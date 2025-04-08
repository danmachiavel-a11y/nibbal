# Emergency Ticket Close Instructions

This document provides instructions for closing tickets when the normal `/close` command in Telegram isn't working.

## Option 1: Web Interface

Access the emergency close web interface at: 
```
http://localhost:5000/emergency-close
```

Enter the Telegram ID and click "Close Ticket".

## Option 2: Command Line Utilities

### Using the Shell Script
```bash
./close-ticket.sh [telegram_id]
```

### Using the Ultra Direct Telegram API Method (100% Reliable)
```bash
node telegram-direct.cjs [telegram_id]
```

### Using the Ultimate Database Method
```bash
node ultimate-close.js [telegram_id]
```

### Using Direct Telegram API Utility
```bash
node telegram-force-close.js [telegram_id]
```

### Other Direct Utilities
```bash
node super-close-command.js [telegram_id]
```

```bash
node direct-close-command.js [telegram_id]
```

## Option 3: Direct API Call

Make a POST request to:
```
POST /api/tickets/close-by-telegram-id/:telegramId
```

Example with curl:
```bash
curl -X POST http://localhost:5000/api/tickets/close-by-telegram-id/TELEGRAM_ID_HERE
```

## Finding a Telegram ID

If you don't know the Telegram ID, you can:

1. Check the user table in the database:
```sql
SELECT * FROM users WHERE username LIKE '%username%';
```

2. Look at active tickets in the database:
```sql
SELECT t.id, t.status, u.telegram_id, u.username 
FROM tickets t 
JOIN users u ON t.user_id = u.id 
WHERE t.status NOT IN ('closed', 'completed', 'transcript');
```

## Alternative: Using a Secondary Bot

Since the /close command isn't working with the main bot, you can create a completely separate
"emergency bot" that only handles close commands:

1. Create a new bot with @BotFather on Telegram
2. Set the token as an environment variable:
```
export EMERGENCY_BOT_TOKEN=your_token_here
```
3. Run one of the emergency bot scripts:
```bash
node close-only-bot.cjs  # CommonJS version (recommended)
# or
node close-only-bot.js   # ES Modules version
```
4. Talk to this emergency bot and use:
   - `/help` - Show available commands
   - `/close [telegram_id]` - Close another user's ticket (admin only)
   - `/selfclose` - Close your own ticket (any user)

## Technical Notes

There are multiple approaches to close a ticket, from highest to lowest level:

1. **close-only-bot.cjs** - Separate Telegram bot with only close functionality
2. **telegram-direct.cjs** - Uses raw HTTP to communicate with Telegram bypassing all frameworks
3. **telegram-force-close.js** - Uses HTTP API to bypass Telegraf bot framework
4. **ultimate-close.js** - Connects directly to database with minimal dependencies
5. **Web Interface** - Simple HTTP API access through a browser
6. **Shell Script** - Wrapper around the API endpoint with colored output
7. **super-close-command.js** - Another database-direct approach with extra error handling
8. **direct-close-command.js** - Original direct database method

If none of these approaches work, you may need to manually update the database:

```sql
-- Find the ticket ID first
SELECT t.id, t.status, u.telegram_id, u.username 
FROM tickets t 
JOIN users u ON t.user_id = u.id 
WHERE u.telegram_id = 'TELEGRAM_ID_HERE';

-- Then close the ticket
UPDATE tickets SET status = 'closed' WHERE id = TICKET_ID_HERE;
```