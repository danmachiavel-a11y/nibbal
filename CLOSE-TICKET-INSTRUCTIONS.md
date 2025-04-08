# Ticket Closing Instructions

Due to a persistent issue with the Telegram bot's `/close` command not functioning correctly, here are the recommended methods to close tickets:

## For Administrators

### Method 1: Using the Direct Close Tool
```bash
node direct-close.cjs [TELEGRAM_ID]
```

Example:
```bash
node direct-close.cjs 1933230287
```

### Method 2: Using the Emergency API
```bash
node emergency-close.cjs [TELEGRAM_ID]
```

### Method 3: Ultra Simple Script
```bash
node ultra-close.js [TELEGRAM_ID]
```

## For Users

1. Direct users to use Discord to close their tickets when possible
2. If a user needs to close a ticket via Telegram, an administrator should run one of the scripts above

## Finding a User's Telegram ID

1. From the database:
```sql
SELECT id, telegram_id, username FROM users WHERE username LIKE '%[username]%';
```

2. From a ticket ID:
```sql
SELECT u.telegram_id, u.username FROM users u 
JOIN tickets t ON u.id = t.user_id
WHERE t.id = [TICKET_ID];
```

## Troubleshooting

If none of the above methods work, the ticket can be closed directly in the database:

```sql
UPDATE tickets SET status = 'closed' WHERE id = [TICKET_ID];
```

After closing a ticket this way, you may need to manually move the Discord channel to the transcripts category.