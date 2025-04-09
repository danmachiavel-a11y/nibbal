/**
 * STANDALONE CLOSE COMMAND LISTENER
 * 
 * This tool creates a minimal bot that ONLY listens for /close commands
 * and responds with debugging information. It avoids all other bot framework code.
 * 
 * The goal is to determine if the command is being received at all.
 */

const { Telegraf } = require('telegraf');
const fs = require('fs');

// Get the token from environment
const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN not set.');
  process.exit(1);
}

// Create a log file for debug output
const logFile = fs.createWriteStream('./close-listener.log', { flags: 'a' });

// Helper function to log to both console and file
function debugLog(message) {
  const timestamp = new Date().toISOString();
  const formattedMessage = `[${timestamp}] ${message}`;
  console.log(formattedMessage);
  logFile.write(formattedMessage + '\n');
}

// Create a bot instance focused just on close command
const bot = new Telegraf(token, {
  handlerTimeout: 300000, // 5 minutes timeout - plenty of time to debug
});

debugLog('=== STARTING CLOSE COMMAND LISTENER ===');

// Register command handler for /close
bot.command('close', async (ctx) => {
  try {
    debugLog(`🔴 DETECTED /close COMMAND FROM USER ${ctx.from.id}`);
    debugLog(`User: ${ctx.from.first_name} (${ctx.from.username || 'no username'})`);
    debugLog(`Full message: ${ctx.message.text}`);
    debugLog(`Chat type: ${ctx.chat.type}`);
    
    // Reply to confirm we saw it
    await ctx.reply(`✅ COMMAND RECEIVED: I detected your /close command!

This is the standalone listener confirming that your command was properly received by the Telegram API.

DEBUG INFO:
- Command: /close
- User ID: ${ctx.from.id}
- Chat ID: ${ctx.chat.id}
- Message ID: ${ctx.message.message_id}
- Text: ${ctx.message.text}

The command detection is working correctly in this isolated test bot.
`);
    
    debugLog(`Sent confirmation to user ${ctx.from.id}`);
  } catch (error) {
    debugLog(`ERROR in close command handler: ${error}`);
    try {
      await ctx.reply(`Error processing command: ${error.message}`);
    } catch (replyError) {
      debugLog(`Failed to send error message: ${replyError}`);
    }
  }
});

// Log any text message starting with /close
bot.hears(/^\/close($|\s)/i, async (ctx) => {
  try {
    debugLog(`🔵 DETECTED /close TEXT (via hears) FROM USER ${ctx.from.id}`);
    debugLog(`User: ${ctx.from.first_name} (${ctx.from.username || 'no username'})`);
    debugLog(`Full message: ${ctx.message.text}`);
    
    // Reply to confirm we saw it
    await ctx.reply(`✅ TEXT MATCHER: I detected your /close command through the text matcher!

This confirms the text is being properly matched.
`);
    
    debugLog(`Sent text matcher confirmation to user ${ctx.from.id}`);
  } catch (error) {
    debugLog(`ERROR in close text handler: ${error}`);
  }
});

// Listen for all text messages too
bot.on('text', async (ctx) => {
  try {
    const text = ctx.message.text;
    debugLog(`📝 RECEIVED TEXT MESSAGE: "${text}" FROM USER ${ctx.from.id}`);
    
    // If it looks like a close command, notify
    if (text && text.toLowerCase().startsWith('/close')) {
      debugLog(`🟢 TEXT HANDLER FOUND POTENTIAL /close COMMAND`);
      
      // Reply to confirm we saw it
      await ctx.reply(`✅ GENERAL TEXT HANDLER: I noticed your message starts with /close

This means the command is being received but might not be recognized as a command.
`);
      
      debugLog(`Sent general text confirmation to user ${ctx.from.id}`);
    }
  } catch (error) {
    debugLog(`ERROR in text handler: ${error}`);
  }
});

// Start the bot
bot.launch()
  .then(() => {
    debugLog(`✅ Close command listener started!`);
    debugLog(`Bot username: @${bot.botInfo.username}`);
    debugLog(`Send /close to the bot to test command detection`);
  })
  .catch((error) => {
    debugLog(`Error starting listener bot: ${error}`);
    process.exit(1);
  });

// Enable graceful stop
process.once('SIGINT', () => {
  bot.stop('SIGINT');
  debugLog('Listener bot stopped (SIGINT)');
  logFile.end();
});

process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  debugLog('Listener bot stopped (SIGTERM)');
  logFile.end();
});