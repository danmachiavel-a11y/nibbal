# Instructions for Setting Up Discord Bot Token in Deployment

## Environment Variable Setup

When deploying this application, make sure to properly set up the Discord bot token as an environment variable in your deployment environment. The application will look for the token in the following environment variables (in order):

1. `DISCORD_BOT_TOKEN` (primary)
2. `DISCORD_TOKEN`
3. `BOT_TOKEN`
4. `DISCORDTOKEN`

## Replit Deployment

For Replit deployments, follow these steps:

1. Go to the "Secrets" tab in your Replit project
2. Add a new secret with the key `DISCORD_BOT_TOKEN` and your bot token as the value
3. The secret will be automatically added to the environment variables

## Other Cloud Platforms

For other cloud platforms like Heroku, Vercel, or Railway:

1. Find the environment variables or secrets section in your deployment settings
2. Add `DISCORD_BOT_TOKEN` with your bot token as the value
3. Redeploy your application or restart if necessary

## Testing Environment Variables

After deployment, check the logs to verify that the Discord token is being properly detected:

```
Discord bot token from env: exists (length 72)
```

or

```
Found Discord token in alternative env var DISCORD_TOKEN (length 72)
```

## Troubleshooting

If you see an error like:

```
Error creating Discord channel: Error [TokenInvalid]: An invalid token was provided.
```

This means the token is being read from the environment but is invalid. You need to:

1. Check that the token in your environment variables is correct and up-to-date
2. Make sure you haven't reset the token in the Discord Developer Portal after setting it in your deployment
3. Verify that the bot has the necessary permissions and intents enabled

## Graceful Fallback

The application has been improved to continue functioning even when Discord connectivity fails:

1. All Telegram functionality will work normally
2. Messages will be saved in the database
3. The system will attempt to reconnect to Discord periodically
4. Once Discord is properly connected, normal cross-platform functionality will resume

## Important Note

Never expose your Discord bot token in public repositories or client-side code. Always use environment variables or secrets management systems to handle sensitive tokens.