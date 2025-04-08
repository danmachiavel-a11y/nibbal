#!/bin/bash

# This script runs the force-close Telegram bot alongside the main application
# Usage: ./command-fix.sh start|stop|status

# Configuration
MAIN_BOT_PID_FILE="/tmp/main-bot.pid"
FORCE_CLOSE_PID_FILE="/tmp/force-close-bot.pid"
LOG_FILE="/tmp/force-close-bot.log"

# Function to start the force-close bot
start_force_close_bot() {
    echo "Starting force-close Telegram command handler..."
    nohup node telegram-force-close.js > "$LOG_FILE" 2>&1 &
    echo $! > "$FORCE_CLOSE_PID_FILE"
    echo "Force-close bot started with PID: $(cat $FORCE_CLOSE_PID_FILE)"
}

# Function to stop the force-close bot
stop_force_close_bot() {
    if [ -f "$FORCE_CLOSE_PID_FILE" ]; then
        PID=$(cat "$FORCE_CLOSE_PID_FILE")
        echo "Stopping force-close bot (PID: $PID)..."
        kill -9 "$PID" 2>/dev/null || echo "Process was not running"
        rm "$FORCE_CLOSE_PID_FILE"
        echo "Force-close bot stopped"
    else
        echo "Force-close bot is not running"
    fi
}

# Function to check the status of the force-close bot
check_status() {
    echo "=== Force-Close Bot Status ==="
    if [ -f "$FORCE_CLOSE_PID_FILE" ]; then
        PID=$(cat "$FORCE_CLOSE_PID_FILE")
        if ps -p "$PID" > /dev/null; then
            echo "Force-close bot is running with PID: $PID"
            echo "Log file: $LOG_FILE"
            echo "Last 10 lines of log:"
            tail -n 10 "$LOG_FILE"
        else
            echo "Force-close bot is not running (stale PID file)"
        fi
    else
        echo "Force-close bot is not running"
    fi
}

# Function to close tickets for a specified Telegram ID
force_close_tickets() {
    if [ -z "$1" ]; then
        echo "Error: Telegram ID is required"
        echo "Usage: ./command-fix.sh force-close <telegramId>"
        exit 1
    fi
    
    echo "Force closing tickets for Telegram ID: $1"
    node force-close-direct.js "$1"
}

# Main script logic
case "$1" in
    start)
        start_force_close_bot
        ;;
    stop)
        stop_force_close_bot
        ;;
    restart)
        stop_force_close_bot
        sleep 2
        start_force_close_bot
        ;;
    status)
        check_status
        ;;
    force-close)
        force_close_tickets "$2"
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|force-close <telegramId>}"
        exit 1
        ;;
esac

exit 0