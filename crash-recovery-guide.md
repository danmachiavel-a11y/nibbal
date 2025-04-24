# Crash Recovery System Guide

This project has been enhanced with a comprehensive crash recovery and logging system to detect, diagnose, and automatically recover from application failures.

## Features

### 1. Enhanced Crash Logging

The system now records detailed crash information to help diagnose issues:

- **Crash Log File**: All crashes are recorded in `crash-logs.txt` with detailed information
- **System Statistics**: Memory usage, uptime, and other diagnostics are captured at crash time
- **Error Categorization**: Automatic detection of error types (media processing, bot communication, database)
- **Dashboard Access**: View crash logs through the dashboard UI at `/crash-logs`

### 2. Watchdog System (Auto-restart)

For unrecoverable crashes where the entire application terminates, a watchdog process has been implemented:

- **Watchdog Process**: Monitors the main application and restarts it if it crashes
- **Graduated Backoff**: Prevents rapid restart cycles by increasing delays between restarts
- **Automatic Recovery**: Ensures the application continues running even after fatal crashes
- **Restart Logging**: Maintains history of restarts with timestamps and failure reasons

## How to Use the Watchdog

Instead of running the application directly, you can start it with the watchdog for automatic crash recovery:

```bash
# Start the application with watchdog (development)
node watchdog.mjs

# In production environments
NODE_ENV=production node watchdog.mjs
```

## Accessing Crash Logs

1. Navigate to `/crash-logs` in the dashboard
2. Review crash history organized by type and time
3. View detailed information for each crash including:
   - Memory usage at crash time
   - Application uptime before crash
   - Error message and stack trace
   - Error category and source

## Configuration

The watchdog system can be configured by editing `watchdog.mjs`:

- `maxRestarts`: Maximum number of restarts in a time period (default: 10)
- `restartTimeWindow`: Time window for counting restarts (default: 1 hour)
- `initialRestartDelay`: Initial delay between restarts (default: 2 seconds)
- `maxRestartDelay`: Maximum delay between restarts (default: 30 seconds)

## Architecture

The crash recovery system operates on multiple levels:

1. **Application-level Recovery**: Handles non-fatal errors and attempts to continue operation
2. **Graceful Degradation**: Continues providing service even when components fail
3. **Process Monitoring**: Watchdog process to detect and recover from complete application crashes
4. **Detailed Diagnostics**: Comprehensive logging for debugging and troubleshooting

## Best Practices

- Regularly check the crash logs for patterns of recurring issues
- If you see frequent crashes of the same type, address the root cause
- Use the dashboard to track system stability over time