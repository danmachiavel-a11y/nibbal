# Messaging Bridge Setup Guide

This guide provides step-by-step instructions for setting up the messaging bridge application.

## Environment Setup

The application can be configured using environment variables, either through a `.env` file or through your hosting platform's environment variables interface.

### Setting Up with .env File

1. Create a `.env` file in the root directory of the project
2. Copy the contents of `.env.example` to your new `.env` file
3. Fill in the values for each environment variable

Example `.env` file:
```
# Bot Tokens
DISCORD_BOT_TOKEN=your_discord_bot_token_here
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here

# Image upload service (for sending images)
IMGBB_API_KEY=your_imgbb_api_key_here
```

### Required Environment Variables

- `DISCORD_BOT_TOKEN`: Your Discord bot token
- `TELEGRAM_BOT_TOKEN`: Your Telegram bot token

### Optional Environment Variables

- `IMGBB_API_KEY`: API key for image uploads

## Discord Bot Setup

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Navigate to the "Bot" tab and click "Add Bot"
4. Copy the token and add it to your `.env` file or environment variables
5. Under "Privileged Gateway Intents", enable the following:
   - Presence Intent
   - Server Members Intent
   - Message Content Intent
6. Generate an invite link with the following permissions:
   - Manage Channels
   - Manage Roles
   - Read Messages/View Channels
   - Send Messages
   - Manage Messages
   - Embed Links
   - Attach Files
   - Read Message History
   - Mention Everyone
   - Use External Emojis
   - Add Reactions
7. Use the invite link to add the bot to your Discord server

## Telegram Bot Setup

1. Talk to [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the instructions to create a new bot
3. Copy the token provided by BotFather and add it to your `.env` file or environment variables
4. (Optional) Customize your bot with `/setdescription`, `/setabouttext`, and `/setuserpic`

## Database Setup

The application uses a PostgreSQL database. If you're deploying on Replit, the database will be automatically set up for you. If you're deploying elsewhere, you'll need to set up a PostgreSQL database and set the `DATABASE_URL` environment variable.

## Running the Application

1. Install dependencies:
```
npm install
```

2. Start the application:
```
npm run dev
```

For production deployment:
```
npm run build
npm start
```

## Setting Up Categories and Services

After the application is running:

1. Open the application in your browser
2. Navigate to the Settings page
3. Configure the Discord categories and roles for ticket management
4. Set up the various services (categories) and their questionnaires

## Troubleshooting

If you encounter issues with the Discord or Telegram bot:

1. Check that the tokens are correctly entered in your environment variables
2. Verify that the bots have the necessary permissions
3. For Discord, ensure the bot is in your server and has the required intents
4. For Telegram, make sure the bot is active and hasn't been blocked

## Additional Resources

- [Discord Developer Documentation](https://discord.com/developers/docs/intro)
- [Telegram Bot API Documentation](https://core.telegram.org/bots/api)
- [API Documentation](./API.md) for this application