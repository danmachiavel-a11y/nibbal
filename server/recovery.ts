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
    
    // Log the error with detailed context
    log(`CRITICAL ERROR from ${source}: ${errorMessage}`, 'error');
    
    // Check if we have a specific BridgeError with more details
    if (error instanceof BridgeError && error.context) {
      log(`Error context: ${error.context}`, 'error');
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
 * Attempt to gracefully restart the application
 */
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