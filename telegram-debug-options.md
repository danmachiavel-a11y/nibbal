# Telegram Command Debugging Options

We've created a set of tools to help debug why the `/close` command isn't working:

## Approach 1: Message Monitor (Non-Intrusive)

This tool monitors ALL Telegram updates without interfering with the main bot:

```bash
node debug-telegram-messages.cjs
```

This will:
1. Log ALL incoming updates to the bot to both console and telegram-debug.log
2. Show specific details when a `/close` command is detected
3. Run alongside the main bot without interfering with it

## Approach 2: Command Testing Bot 

This tool creates a separate instance of the bot that implements 4 different methods
of handling the `/close` command to determine which one works:

```bash
node debug-close-command.cjs
```

This will:
1. Try to capture `/close` commands using 4 different methods
2. Log all details to both console and close-command-debug.log
3. Reply to confirm which method detected the command

## Approach 3: Commands Registration Check

This tool checks if the `/close` command is actually registered with the Telegram Bot API
and attempts to register it if it's missing:

```bash
node debug-all-bot-commands.cjs
```

This will:
1. Retrieve the current list of registered commands for the bot
2. Check if the `/close` command is properly registered
3. Attempt to register it if it's missing

## Approach 4: Standalone Close Listener

This creates a minimal bot focused only on listening to the `/close` command:

```bash
node standalone-close-listener.cjs
```

This will:
1. Create a simple bot that ONLY listens for the `/close` command
2. Respond with detailed debug information when it detects the command
3. Log all information to the console and close-listener.log

## Approach 5: Command Re-Registration

This completely clears all bot commands and registers them again:

```bash
node reregister-commands.cjs
```

This will:
1. Delete all existing command registrations
2. Register a fresh set of commands with Telegram
3. Log the before and after command lists

## How to Use

1. Start the main app as normal `npm run dev`
2. Open a second terminal window 
3. Run one of the debug scripts
4. Try sending `/close` to the bot in Telegram
5. Check the logs to see what's happening

## Important Notes

The debug scripts run independently of the main application and don't modify your database.
They are purely for diagnostic purposes.