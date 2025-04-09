/**
 * CLOSE COMMAND DIAGNOSTIC TOOL
 * 
 * This script creates a minimal bot with super verbose logging on all types
 * of command registrations for /close to understand why it's not working.
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
const logFile = fs.createWriteStream('./close-command-debug.log', { flags: 'a' });

// Helper function to log to both console and file
function debugLog(message) {
  const timestamp = new Date().toISOString();
  const formattedMessage = `[${timestamp}] ${message}`;
  console.log(formattedMessage);
  logFile.write(formattedMessage + '\n');
}

// Create a bot instance focused just on close command
const bot = new Telegraf(token, {
  handlerTimeout: 90000,
});

// Log all updates first
bot.use((ctx, next) => {
  try {
    debugLog(`Received update: ${JSON.stringify(ctx.update)}`);
    return next();
  } catch (err) {
    debugLog(`Error in update logger: ${err}`);
  }
});

// METHOD 1: Command handler with command() method
bot.command('close', (ctx) => {
  debugLog('METHOD 1: /close command triggered via bot.command()');
  debugLog(`Command from user: ${ctx.from.id}`);
  ctx.reply('Close command detected via bot.command()');
});

// METHOD 2: Hear handler for /close text
bot.hears(/^\/close($|\s)/i, (ctx) => {
  debugLog('METHOD 2: /close command triggered via bot.hears() regex');
  debugLog(`Command from user: ${ctx.from.id}`);
  ctx.reply('Close command detected via bot.hears()');
});

// METHOD 3: Text handler with text() method
bot.on('text', (ctx) => {
  const text = ctx.message.text;
  debugLog(`TEXT HANDLER: Received message: "${text}"`);
  
  if (text && text.toLowerCase().startsWith('/close')) {
    debugLog('METHOD 3: /close command detected in general text handler');
    debugLog(`Command from user: ${ctx.from.id}`);
    ctx.reply('Close command detected via text handler');
  }
});

// METHOD 4: Raw update handler as a last resort
bot.on('update', (ctx) => {
  try {
    debugLog('RAW UPDATE HANDLER TRIGGERED');
    
    // Try to extract message
    if (ctx.update && ctx.update.message && ctx.update.message.text) {
      const text = ctx.update.message.text;
      debugLog(`RAW UPDATE: Message text: "${text}"`);
      
      if (text.toLowerCase().startsWith('/close')) {
        debugLog('METHOD 4: /close command detected in raw update handler');
        debugLog(`Command from user: ${ctx.from.id}`);
        ctx.reply('Close command detected via raw update handler');
      }
    }
  } catch (err) {
    debugLog(`Error in raw update handler: ${err}`);
  }
});

// Start the bot
bot.launch()
  .then(() => {
    debugLog(`✅ Close command debug bot started!`);
    debugLog(`Bot username: @${bot.botInfo.username}`);
    debugLog(`This bot is ONLY for diagnosing why /close doesn't work`);
  })
  .catch((error) => {
    debugLog(`Error starting debug bot: ${error}`);
    process.exit(1);
  });

// Enable graceful stop
process.once('SIGINT', () => {
  bot.stop('SIGINT');
  debugLog('Debug bot stopped (SIGINT)');
  logFile.end();
});

process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  debugLog('Debug bot stopped (SIGTERM)');
  logFile.end();
});