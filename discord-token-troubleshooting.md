# Discord Bot Token Troubleshooting Guide

This guide helps you diagnose and fix issues with Discord bot connectivity. Our system is designed to function even if Discord is unavailable, but establishing the connection is ideal for full functionality.

## Current Status

The Discord bot can't connect to Discord's API because the authentication token appears to be invalid or revoked. This could happen for a few reasons:
- The token was recently reset in the Discord Developer Portal
- The application might have been deleted or disabled
- The token might have been compromised and revoked by Discord

## Checking Your Discord Bot Token

Follow these steps to verify your Discord bot token:

1. Visit the [Discord Developer Portal](https://discord.com/developers/applications)
2. Select your bot application
3. Go to the "Bot" tab
4. Check if your token is visible or if it shows "Click to Reset Token"

## Getting a New Discord Bot Token

1. Visit the [Discord Developer Portal](https://discord.com/developers/applications)
2. Select your existing bot application (or create a new one)
3. Go to the "Bot" tab
4. Click "Reset Token"
5. Copy the new token

## Updating Your Discord Bot Token

After obtaining a new token, you need to update it in your environment:

1. When prompted, provide the new token to the system
2. Once saved, the application will automatically attempt to connect with the new token
3. If successful, you'll see "Discord bot started successfully" in the logs

## Important Discord Bot Settings

For full functionality, ensure your Discord bot has these settings:

1. In the Discord Developer Portal, under "Bot" tab:
   - All "Privileged Gateway Intents" should be enabled (Message Content, Server Members, Presence)
   - PUBLIC BOT should be enabled only if you want the bot to be added to multiple servers

2. For server permissions, the bot needs:
   - Manage Channels (to create ticket channels)
   - Send Messages
   - Manage Messages (for pinning important info)
   - Read Message History
   - Attach Files
   - Use External Emojis

## Testing Discord Connectivity Manually

To manually test Discord connectivity, you can:

1. Use our diagnostic tools:
   ```
   node force-token.js
   ```

2. Check the logs for successful connection messages like:
   ```
   Discord bot started successfully
   ```

## Operating in Telegram-Only Mode

If Discord continues to be unavailable, the system will:
1. Function normally for Telegram users
2. Store all messages in the database
3. Properly handle ticket states
4. Notify users that Discord staff may not see their messages immediately

Once Discord connectivity is restored, pending messages will be properly delivered.