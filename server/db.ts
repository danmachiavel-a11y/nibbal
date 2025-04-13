import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from "ws";
import * as schema from "@shared/schema";
import { log } from "./vite";

// Configure Neon to use WebSockets
neonConfig.webSocketConstructor = ws;

// Retry configuration
const DB_MAX_RETRIES = 5;
const DB_INITIAL_RETRY_DELAY_MS = 250; // Start with 250ms
const DB_MAX_RETRY_DELAY_MS = 10000; // Max 10s between retries

// Configure secure connection (if supported by Neon version)
try {
  // @ts-ignore - Some versions of @neondatabase/serverless might not have this property
  neonConfig.useSecureWebSocket = true;
} catch (error) {
  log("Warning: Couldn't set secure WebSocket option, might be using an older version of the Neon client", "warn");
}

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Create connection pool with better error handling and performance settings
export const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL,
  max: 15, // Maximum number of clients in the pool (increased for better throughput)
  idleTimeoutMillis: 30000, // How long a client is allowed to remain idle before being closed
  connectionTimeoutMillis: 15000, // How long to wait before timing out when connecting a new client
  maxUses: 10000, // Maximum number of times a client can be used before being recycled
  keepAlive: true, // Use TCP keepalive to detect dead connections
  keepAliveInitialDelayMillis: 30000 // Initial delay before sending keepalive probes
});

// Track database health
let isHealthy = true;
let lastHealthCheck = Date.now();
let disconnectedSince: number | null = null;
let reconnectionAttempts = 0;

// Add event listeners for better error handling
pool.on('error', (err) => {
  const now = Date.now();
  isHealthy = false;
  
  if (!disconnectedSince) {
    disconnectedSince = now;
  }
  
  log(`Database pool error: ${err.message}`, 'error');
  
  // Categorize error for better recovery handling
  if (err.message.includes('terminating connection') || 
      err.message.includes('Connection terminated') || 
      err.message.includes('Connection ended unexpectedly')) {
    // Connection was terminated, will be auto-restored on next query
    log('Database connection terminated unexpectedly. The connection will be automatically restored on next query.', 'warn');
    reconnectionAttempts++;
    
    // If multiple reconnection attempts, add increasing delay
    if (reconnectionAttempts > 1) {
      const backoffDelay = Math.min(
        DB_INITIAL_RETRY_DELAY_MS * Math.pow(2, reconnectionAttempts - 1),
        DB_MAX_RETRY_DELAY_MS
      );
      log(`Multiple reconnection attempts detected (${reconnectionAttempts}). Adding backoff delay of ${backoffDelay}ms`, 'warn');
    }
  }
});

// Create Drizzle ORM instance with query logging for debug purposes
export const db = drizzle({ client: pool, schema });

/**
 * Execute a database query with automatic retries
 * Used to wrap important database operations that must not fail
 */
export async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  let attempt = 0;
  let lastError: any = null;
  let delay = DB_INITIAL_RETRY_DELAY_MS;
  
  while (attempt < DB_MAX_RETRIES) {
    try {
      // If not first attempt, log the retry
      if (attempt > 0) {
        log(`Retrying database operation (attempt ${attempt + 1}/${DB_MAX_RETRIES})`, 'debug');
      }
      
      // Execute the database operation
      const result = await operation();
      
      // If this was a retry attempt that succeeded, log recovery
      if (attempt > 0) {
        log(`Database operation recovered after ${attempt} retries`, 'info');
      }
      
      // Reset health tracking on successful operation
      if (!isHealthy) {
        isHealthy = true;
        reconnectionAttempts = 0;
        disconnectedSince = null;
        log(`Database connection restored after ${disconnectedSince ? Math.floor((Date.now() - disconnectedSince) / 1000) : '?'} seconds`, 'info');
      }
      
      return result;
    } catch (error: any) {
      lastError = error;
      attempt++;
      
      // Only retry on connection-related errors
      const isRetriableError = 
        error.message.includes('connection') ||
        error.message.includes('timeout') ||
        error.message.includes('terminated') ||
        error.message.includes('socket') ||
        error.message.includes('closed') ||
        error.code === 'ECONNRESET' ||
        error.code === 'ECONNREFUSED' ||
        error.code === '08006' || // Connection failure
        error.code === '08001' || // Unable to connect
        error.code === '08004' || // Rejected connection
        error.code === '57P01' || // Admin shutdown
        error.code === '57P02' || // Crash shutdown
        error.code === '57P03';   // Cannot connect now

      if (!isRetriableError) {
        log(`Database error not retriable: ${error.message}`, 'error');
        throw error; // Don't retry logic errors like constraint violations
      }
      
      // Track database health
      isHealthy = false;
      if (!disconnectedSince) {
        disconnectedSince = Date.now();
      }
      
      if (attempt < DB_MAX_RETRIES) {
        // Log retriable errors
        log(`Database error: ${error.message}. Will retry in ${delay}ms (attempt ${attempt}/${DB_MAX_RETRIES})`, 'warn');
        
        // Wait before retrying using exponential backoff with jitter
        await new Promise(resolve => setTimeout(resolve, delay));
        
        // Calculate next delay with exponential backoff
        delay = Math.min(delay * 2, DB_MAX_RETRY_DELAY_MS);
        // Add jitter (±20% randomness)
        const jitter = delay * 0.2;
        delay = Math.floor(delay - jitter + (Math.random() * jitter * 2));
      }
    }
  }
  
  // All retries failed
  log(`Database operation failed after ${DB_MAX_RETRIES} retries: ${lastError?.message}`, 'error');
  throw lastError;
}

/**
 * Checks the health of the database connection
 * You can call this function before critical operations
 * or periodically to ensure the database is available
 */
export async function checkDatabaseConnection(): Promise<boolean> {
  // If we checked recently and it was healthy, avoid unnecessary checks
  const now = Date.now();
  if (isHealthy && (now - lastHealthCheck < 30000)) {
    return true;
  }
  
  lastHealthCheck = now;
  let client;
  
  try {
    // Get a client from the pool
    client = await pool.connect();
    // Run a simple query
    await client.query('SELECT 1 as health_check');
    
    // Update tracking variables
    isHealthy = true;
    reconnectionAttempts = 0;
    
    // If we were previously disconnected, log reconnection
    if (disconnectedSince) {
      const downtime = Math.floor((now - disconnectedSince) / 1000);
      log(`Database connection restored after ${downtime} seconds of downtime`, 'info');
      disconnectedSince = null;
    }
    
    return true;
  } catch (error) {
    // Update tracking variables
    isHealthy = false;
    if (!disconnectedSince) {
      disconnectedSince = now;
    }
    
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`Database connection check failed: ${errorMessage}`, 'error');
    
    // Log how long we've been disconnected
    if (disconnectedSince) {
      const downtime = Math.floor((now - disconnectedSince) / 1000);
      log(`Database has been down for ${downtime} seconds`, 'warn');
    }
    
    return false;
  } finally {
    // Release the client back to the pool
    if (client) client.release();
  }
}
