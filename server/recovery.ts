/**
 * Server recovery mechanism
 * 
 * This file implements a recovery system that:
 * 1. Catches unhandled errors at the process level
 * 2. Implements a backoff strategy to prevent excessive restarts
 * 3. Logs detailed error information for debugging
 * 4. Gracefully shuts down connections before restart
 */

import { log } from './vite';
import { checkDatabaseConnection, pool } from './db';
import { BridgeError } from './bot/bridge';

// Track restart attempts to implement backoff
interface RestartTracker {
  attempts: number;
  lastRestart: number;
  backoffMs: number;
  maxBackoffMs: number;
  maxAttemptsPerHour: number;
  attemptsThisHour: number;
  hourlyResetTime: number;
}

// Global tracker state
const restartTracker: RestartTracker = {
  attempts: 0,
  lastRestart: 0,
  backoffMs: 5000, // Start with 5 second delay
  maxBackoffMs: 5 * 60 * 1000, // Max 5 minute delay
  maxAttemptsPerHour: 10, // Max 10 restarts per hour
  attemptsThisHour: 0,
  hourlyResetTime: Date.now() + 60 * 60 * 1000 // Reset counter after an hour
};

/**
 * Initialize the recovery system with global error handlers
 */
export function initializeRecoverySystem() {
  log('Initializing server recovery system', 'info');

  // Catch uncaught exceptions
  process.on('uncaughtException', async (error) => {
    await handleCriticalError(error, 'uncaughtException');
  });

  // Catch unhandled promise rejections
  process.on('unhandledRejection', async (reason) => {
    await handleCriticalError(reason as Error, 'unhandledRejection');
  });

  // Set up hourly reset for restart attempts counter
  setInterval(() => resetHourlyCounter(), 60 * 60 * 1000);

  // Add global catch-all error handlers for image processing and network errors
  setupGlobalErrorHandlers();

  log('Recovery system initialized', 'info');
}

/**
 * Handle a critical error that would normally crash the app
 */
async function handleCriticalError(error: any, source: string) {
  try {
    // Update hourly tracking first
    checkHourlyLimit();
    
    // Format error message
    const errorMessage = error instanceof Error 
      ? `${error.name}: ${error.message}\n${error.stack}` 
      : String(error);
    
    // Create detailed crash report
    const memoryUsage = process.memoryUsage();
    const memoryInfo = {
      rss: `${Math.round(memoryUsage.rss / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`
    };
    
    // Write the crash information to a special log file
    try {
      const fs = require('fs');
      const crashLog = {
        timestamp: new Date().toISOString(),
        source: source,
        error: errorMessage,
        memory: memoryInfo,
        uptime: `${Math.round(process.uptime())}s`
      };
      
      // Append to crash log file
      fs.appendFileSync('crash-logs.txt', 
        `\n------ CRASH REPORT: ${crashLog.timestamp} ------\n` +
        `Source: ${crashLog.source}\n` +
        `Memory: ${JSON.stringify(crashLog.memory)}\n` +
        `Uptime: ${crashLog.uptime}\n` +
        `Error: ${crashLog.error}\n` +
        `------ END REPORT ------\n`,
        'utf8'
      );
      
      log(`Detailed crash information written to crash-logs.txt`, 'info');
    } catch (fileError) {
      log(`Failed to write crash log: ${fileError}`, 'error');
    }
    
    // Log the error with detailed context
    log(`CRITICAL ERROR from ${source}: ${errorMessage}`, 'error');
    log(`CRASH DETAILS - Memory: ${JSON.stringify(memoryInfo)}, Uptime: ${Math.round(process.uptime())}s`, 'error');
    
    // Check if we have a specific BridgeError with more details
    if (error instanceof BridgeError && error.context) {
      log(`Error context: ${error.context}`, 'error');
    }
    
    // Categorize the error to help with diagnostics
    if (errorMessage.toLowerCase().includes('image') || 
        errorMessage.toLowerCase().includes('buffer') || 
        errorMessage.toLowerCase().includes('attachment')) {
      log(`CRASH CATEGORY: Media processing error`, 'error');
    } else if (errorMessage.toLowerCase().includes('telegram') || 
               errorMessage.toLowerCase().includes('discord')) {
      log(`CRASH CATEGORY: Bot communication error`, 'error');
    } else if (errorMessage.toLowerCase().includes('database') || 
               errorMessage.toLowerCase().includes('sql')) {
      log(`CRASH CATEGORY: Database error`, 'error');
    }
    
    // Check if we're restarting too frequently
    if (shouldBackoff()) {
      log(`Too many restart attempts (${restartTracker.attempts} total, ${restartTracker.attemptsThisHour} this hour). Backing off for ${restartTracker.backoffMs/1000} seconds.`, 'warn');
      
      // Just log but don't restart if we're hitting limits
      return;
    }
    
    // Check database connection before attempting restart
    const dbConnected = await checkDatabaseConnection().catch(() => false);
    if (!dbConnected) {
      log('Database connection failed, this may be causing the errors', 'error');
    }
    
    // Attempt graceful restart
    await gracefulRestart();
    
  } catch (recoveryError) {
    // If our recovery system itself has an error, log it but don't take further action
    // to avoid potential infinite loops
    log(`Error in recovery system: ${recoveryError}`, 'error');
  }
}

/**
 * Check if we should back off based on restart frequency
 */
function shouldBackoff(): boolean {
  const now = Date.now();
  
  // If this is our first restart, or it's been a long time since the last one
  if (restartTracker.attempts === 0 || (now - restartTracker.lastRestart > 30 * 60 * 1000)) {
    // Don't back off for first attempt or if it's been more than 30 minutes
    restartTracker.backoffMs = 5000; // Reset to 5 seconds
    return false;
  }
  
  // Check if we're exceeding hourly limit
  if (restartTracker.attemptsThisHour >= restartTracker.maxAttemptsPerHour) {
    return true; // Back off if too many attempts this hour
  }
  
  // If we've had multiple restarts in a short period, increase backoff time
  if (now - restartTracker.lastRestart < 60 * 1000) { // Less than a minute since last restart
    // Double the backoff time, but cap at maximum
    restartTracker.backoffMs = Math.min(restartTracker.backoffMs * 2, restartTracker.maxBackoffMs);
    
    // If we're at max backoff, we should probably back off
    if (restartTracker.backoffMs === restartTracker.maxBackoffMs) {
      return true;
    }
  }
  
  return false;
}

/**
 * Check and update hourly restart limit tracking
 */
function checkHourlyLimit() {
  const now = Date.now();
  
  // Reset counter if we've passed the hourly reset time
  if (now > restartTracker.hourlyResetTime) {
    resetHourlyCounter();
  }
  
  // Increment counters
  restartTracker.attempts++;
  restartTracker.attemptsThisHour++;
  restartTracker.lastRestart = now;
}

/**
 * Reset the hourly counter and set next reset time
 */
function resetHourlyCounter() {
  restartTracker.attemptsThisHour = 0;
  restartTracker.hourlyResetTime = Date.now() + 60 * 60 * 1000;
  log('Reset hourly restart counter', 'debug');
}

/**
 * Adds global catch-all error handlers to make the application more resilient
 * This helps prevent crashes from unhandled image processing errors
 */
function setupGlobalErrorHandlers() {
  // Global unhandled exception handler - more specific than the main one
  process.on('uncaughtExceptionMonitor', (error) => {
    const errorMessage = error?.stack || error?.message || String(error);
    log(`MONITORING: Unhandled exception detected: ${errorMessage}`, "warn");
    
    // Log specific details for certain types of errors
    if (errorMessage.includes('image') || errorMessage.includes('buffer')) {
      log(`Image processing error detected. This is likely related to an attachment`, "error");
    } else if (errorMessage.includes('telegram') || errorMessage.includes('discord')) {
      log(`Bot communication error detected. This might be a temporary network issue`, "error");
    }
  });

  // Add enhanced error handling specifically for network and image processing
  const originalFetch = global.fetch;
  if (originalFetch) {
    (global as any).fetch = async function(input: RequestInfo | URL, init?: RequestInit) {
      try {
        return await originalFetch(input, init);
      } catch (error) {
        // Special handling for image-related network errors
        const url = input?.toString() || '';
        if (url.includes('image') || url.includes('photo') || url.includes('cdn.discord') || url.includes('telegram')) {
          log(`Network error fetching media resource: ${url}`, "error");
          log(`Error details: ${error}`, "error");
          
          // Return a failed response instead of throwing
          return new Response(null, { 
            status: 500, 
            statusText: `Error fetching media: ${error}`
          });
        }
        throw error; // Rethrow other errors
      }
    };
  }
  
  // Enhanced Buffer handling to prevent crashes on invalid data
  const originalFrom = Buffer.from;
  (Buffer as any).from = function(...args: any[]) {
    try {
      return originalFrom.apply(Buffer, args as any);
    } catch (error) {
      // For buffer conversions related to images, return an empty buffer instead of crashing
      if (
        (args[1] === 'base64' && args[0]?.length > 100) || // Likely an image conversion
        (args[0] instanceof ArrayBuffer && args[0].byteLength > 1000) // Likely media content
      ) {
        log(`Buffer conversion error for media content: ${error}`, "error");
        // Return empty buffer to prevent crash
        return Buffer.alloc(0);
      }
      throw error; // Rethrow for other cases
    }
  };
}

async function gracefulRestart() {
  try {
    log('Attempting graceful restart...', 'warn');
    
    // Close database connections
    try {
      log('Closing database pool...', 'info');
      await pool.end();
      log('Database pool closed successfully', 'info');
    } catch (dbError) {
      log(`Error closing database pool: ${dbError}`, 'error');
    }
    
    // Wait for backoff period before initiating the actual restart
    log(`Waiting ${restartTracker.backoffMs/1000} seconds before restart...`, 'info');
    await new Promise(resolve => setTimeout(resolve, restartTracker.backoffMs));
    
    // Restart the process
    log('Restarting server process...', 'warn');
    
    // Using Node's process methods to restart 
    // In a production environment with process manager, this would trigger restart
    process.exit(1);
    
  } catch (error) {
    log(`Error during graceful restart: ${error}`, 'error');
    process.exit(1); // Force exit if graceful restart fails
  }
}