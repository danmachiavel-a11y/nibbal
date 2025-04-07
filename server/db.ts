import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from "ws";
import * as schema from "@shared/schema";
import { log } from "./vite";

// Configure Neon to use WebSockets
neonConfig.webSocketConstructor = ws;

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

// Create connection pool with better error handling
export const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL,
  max: 10, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000, // How long a client is allowed to remain idle before being closed
  connectionTimeoutMillis: 15000, // How long to wait before timing out when connecting a new client
});

// Add event listeners for better error handling
pool.on('error', (err) => {
  log(`Unexpected error on idle database client: ${err.message}`, 'error');
  
  // If connection is terminated by administrator, we can try to recover
  if (err.message.includes('terminating connection due to administrator command')) {
    log('Database connection terminated by administrator. The connection will be automatically restored on next query.', 'warn');
  }
});

// Create Drizzle ORM instance
export const db = drizzle({ client: pool, schema });

// Helper function to check database connection
export async function checkDatabaseConnection(): Promise<boolean> {
  let client;
  try {
    // Get a client from the pool
    client = await pool.connect();
    // Run a simple query
    await client.query('SELECT 1');
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`Database connection check failed: ${errorMessage}`, 'error');
    return false;
  } finally {
    // Release the client back to the pool
    if (client) client.release();
  }
}
