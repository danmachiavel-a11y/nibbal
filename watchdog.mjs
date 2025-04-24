/**
 * Watchdog Process Monitor
 * 
 * This script monitors the main application process and restarts it if it crashes.
 * It maintains a heartbeat system and logs restart attempts.
 */

// Using ESM format for compatibility
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Configuration
const config = {
  // Main application script to monitor
  mainScriptPath: './server/index.ts',
  
  // Command to run (using tsx for TypeScript execution)
  command: 'tsx',
  
  // Maximum number of restarts in a time period
  maxRestarts: 10,
  restartTimeWindow: 60 * 60 * 1000, // 1 hour
  
  // Delay between restart attempts (increases with consecutive failures)
  initialRestartDelay: 2000,
  maxRestartDelay: 30000,
  
  // Log file paths
  watchdogLogPath: './watchdog-logs.txt',
  restartHistoryPath: './restart-history.json',
};

// State tracking
let childProcess = null;
let restarts = [];
let currentRestartDelay = config.initialRestartDelay;
let isShuttingDown = false;

// Helper to log messages with timestamps
function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;
  
  console.log(logMessage);
  
  // Also write to log file
  try {
    fs.appendFileSync(config.watchdogLogPath, logMessage + '\n');
  } catch (err) {
    console.error(`Error writing to log file: ${err}`);
  }
}

// Track restart history
function recordRestart(reason) {
  // Clean up old restarts (keep only those in the time window)
  const now = Date.now();
  restarts = restarts.filter(r => (now - r.time) < config.restartTimeWindow);
  
  // Add new restart record
  restarts.push({
    time: now,
    reason: reason
  });
  
  // Save restart history to file
  try {
    fs.writeFileSync(
      config.restartHistoryPath, 
      JSON.stringify({
        lastUpdate: now,
        restarts: restarts
      }, null, 2)
    );
  } catch (err) {
    log(`Error saving restart history: ${err}`);
  }
  
  // Check if we've exceeded the maximum number of restarts
  if (restarts.length > config.maxRestarts) {
    log(`WARNING: Exceeded maximum number of restarts (${config.maxRestarts}) in time window`);
    // Increase the delay between restarts to prevent rapid cycling
    currentRestartDelay = Math.min(currentRestartDelay * 2, config.maxRestartDelay);
    log(`Increased restart delay to ${currentRestartDelay}ms`);
  } else {
    // Reset the delay if we're not restarting too frequently
    currentRestartDelay = config.initialRestartDelay;
  }
}

// Start the application process
function startProcess() {
  if (isShuttingDown) return;
  
  log(`Starting application: ${config.command} ${config.mainScriptPath}`);
  
  childProcess = spawn(config.command, [config.mainScriptPath], {
    stdio: 'inherit',
    env: { ...process.env, WATCHDOG_MONITORED: '1' }
  });
  
  // Handle process exit
  childProcess.on('exit', (code, signal) => {
    const exitReason = signal 
      ? `terminated due to signal ${signal}` 
      : `exited with code ${code}`;
    
    log(`Application process ${exitReason}`);
    
    // Don't restart if normal exit (code 0) or if we're shutting down
    if (code === 0 || isShuttingDown) {
      log('Clean exit detected, not restarting');
      return;
    }
    
    // Record the restart attempt
    recordRestart(exitReason);
    
    // Schedule restart with delay
    log(`Scheduling restart in ${currentRestartDelay}ms`);
    setTimeout(startProcess, currentRestartDelay);
  });
  
  // Handle process errors
  childProcess.on('error', (err) => {
    log(`Failed to start application process: ${err}`);
    recordRestart(`failed to start: ${err}`);
    
    // Schedule restart with delay
    log(`Scheduling restart in ${currentRestartDelay}ms`);
    setTimeout(startProcess, currentRestartDelay);
  });
}

// Load previous restart history if available
try {
  if (fs.existsSync(config.restartHistoryPath)) {
    const historyData = JSON.parse(fs.readFileSync(config.restartHistoryPath, 'utf8'));
    if (Array.isArray(historyData.restarts)) {
      restarts = historyData.restarts;
      log(`Loaded ${restarts.length} previous restart records`);
      
      // Clean up old restarts
      const now = Date.now();
      restarts = restarts.filter(r => (now - r.time) < config.restartTimeWindow);
    }
  }
} catch (err) {
  log(`Error loading restart history: ${err}`);
  restarts = [];
}

// Handle watchdog process signals for graceful shutdown
process.on('SIGINT', () => {
  log('Received SIGINT, shutting down gracefully');
  isShuttingDown = true;
  
  if (childProcess) {
    childProcess.kill('SIGINT');
    // Give child process some time to exit gracefully
    setTimeout(() => process.exit(0), 5000);
  } else {
    process.exit(0);
  }
});

process.on('SIGTERM', () => {
  log('Received SIGTERM, shutting down gracefully');
  isShuttingDown = true;
  
  if (childProcess) {
    childProcess.kill('SIGTERM');
    // Give child process some time to exit gracefully
    setTimeout(() => process.exit(0), 5000);
  } else {
    process.exit(0);
  }
});

// Start the application
log('Watchdog process monitor started');
startProcess();