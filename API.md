# API Documentation

This document provides information about the API endpoints in the messaging bridge application.

## Bot Configuration

### Check Discord Bot Status

```
GET /api/bot/discord/status
```

Returns the current status of the Discord bot, including information about whether it's connected, any errors, and environment configuration.

Example response:
```json
{
  "connected": true,
  "error": null,
  "environment": {
    "token_set": true,
    "using_env_file": true
  }
}
```

### Check Telegram Bot Status

```
GET /api/bot/telegram/status
```

Returns the current status of the Telegram bot.

Example response:
```json
{
  "connected": true
}
```

### Update Discord Bot Token

```
POST /api/bot/discord/config
```

Updates the Discord bot token and restarts the bot.

Request body:
```json
{
  "token": "your_discord_token_here"
}
```

Response:
```json
{
  "success": true,
  "message": "Discord bot configuration updated",
  "env_file_updated": true,
  "bot_restarted": true
}
```

## Discord Data Endpoints

### Get Discord Categories

```
GET /api/discord/categories
```

Returns a list of all categories in the Discord server.

### Get Discord Roles

```
GET /api/discord/roles
```

Returns a list of all roles in the Discord server.

### Get Discord Text Channels

```
GET /api/discord/text-channels
```

Returns a list of all text channels in the Discord server.

## Notes on Environment Variables

The application uses the following environment variables:

- `DISCORD_BOT_TOKEN`: The Discord bot token
- `TELEGRAM_BOT_TOKEN`: The Telegram bot token
- `IMGBB_API_KEY`: API key for image uploads (optional)

These can be set in a `.env` file in the root directory of the project. The application will automatically load these variables when it starts.

## Common Error Codes

- `DISCORD_BOT_NOT_READY`: Discord bot is not connected
- `BOT_BRIDGE_UNAVAILABLE`: Bot bridge is not initialized
- `DISCORD_BOT_UNAVAILABLE`: Discord bot failed to initialize
- `NO_SERVER_CONNECTED`: Bot is connected but not in any Discord servers
- `INSUFFICIENT_PERMISSIONS`: Bot doesn't have enough permissions in the Discord server

## Troubleshooting

If you encounter issues with the Discord bot, check the following:

1. Make sure the token is valid and correctly formatted
2. Ensure the bot has been invited to at least one Discord server
3. Verify the bot has the appropriate permissions in the server
4. Check that the bot's intents are properly configured in the Discord Developer Portal