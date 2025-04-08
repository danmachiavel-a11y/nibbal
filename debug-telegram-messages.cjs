/**
 * TELEGRAM MESSAGE DEBUGGER
 * 
 * This tool connects to the Telegram API and logs ALL updates received,
 * allowing us to see exactly what messages are coming in and in what format.
 * 
 * Run this script alongside the main bot to see what the API is receiving when
 * someone tries to use the /close command.
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
const logFile = fs.createWriteStream('./telegram-debug.log', { flags: 'a' });

// Helper function to log to both console and file
function debugLog(message) {
  const timestamp = new Date().toISOString();
  const formattedMessage = `[${timestamp}] ${message}`;
  console.log(formattedMessage);
  logFile.write(formattedMessage + '\n');
}

// Create a bot instance without changing the main bot
const debugBot = new Telegraf(token, {
  handlerTimeout: 90000,
});

// Log raw updates to understand what's happening
debugBot.use((ctx, next) => {
  try {
    debugLog('========== NEW UPDATE RECEIVED ==========');
    debugLog(`Update ID: ${ctx.update.update_id}`);
    debugLog(`Update type: ${getUpdateType(ctx.update)}`);
    
    // Log the entire update object for detailed inspection
    debugLog(`FULL UPDATE OBJECT: ${JSON.stringify(ctx.update, null, 2)}`);
    
    // If this is a message, extract important info
    if (ctx.update.message) {
      const message = ctx.update.message;
      debugLog(`Message ID: ${message.message_id}`);
      debugLog(`From: ${message.from.first_name} (ID: ${message.from.id})`);
      debugLog(`Chat: ${message.chat.type} (ID: ${message.chat.id})`);
      debugLog(`Text: "${message.text || '(no text)'}"`);
      debugLog(`Entities: ${JSON.stringify(message.entities || [])}`)
      
      // Check if it's a /close command
      if (message.text && message.text.toLowerCase().startsWith('/close')) {
        debugLog('⚠️ /CLOSE COMMAND DETECTED! ⚠️');
        
        // Check for command entities
        if (message.entities && message.entities.length > 0) {
          const commandEntity = message.entities.find(e => e.type === 'bot_command');
          if (commandEntity) {
            debugLog(`Command entity found: ${JSON.stringify(commandEntity)}`);
          } else {
            debugLog('No bot_command entity found even though text starts with /close');
          }
        } else {
          debugLog('No entities in message despite starting with /close');
        }
      }
    }
    
    // For callback queries, log specific info
    if (ctx.update.callback_query) {
      const cbq = ctx.update.callback_query;
      debugLog(`Callback data: ${cbq.data}`);
      debugLog(`From: ${cbq.from.first_name} (ID: ${cbq.from.id})`);
    }
    
    debugLog('========== END UPDATE ==========\n');
  } catch (error) {
    debugLog(`ERROR LOGGING UPDATE: ${error.message}`);
  }
  
  // Don't call next() - we're just observing, not interfering
});

// Helper to determine update type
function getUpdateType(update) {
  if (update.message) return 'message';
  if (update.edited_message) return 'edited_message';
  if (update.channel_post) return 'channel_post';
  if (update.edited_channel_post) return 'edited_channel_post';
  if (update.inline_query) return 'inline_query';
  if (update.chosen_inline_result) return 'chosen_inline_result';
  if (update.callback_query) return 'callback_query';
  if (update.shipping_query) return 'shipping_query';
  if (update.pre_checkout_query) return 'pre_checkout_query';
  if (update.poll) return 'poll';
  if (update.poll_answer) return 'poll_answer';
  return 'unknown';
}

// Start the bot
debugBot.launch()
  .then(() => {
    debugLog(`✅ Telegram debug logger started!`);
    debugLog(`Bot username: @${debugBot.botInfo.username}`);
    debugLog(`This script is now monitoring ALL Telegram updates. Look for /close commands.`);
  })
  .catch((error) => {
    debugLog(`Error starting debug bot: ${error}`);
    process.exit(1);
  });

// Enable graceful stop
process.once('SIGINT', () => {
  debugBot.stop('SIGINT');
  debugLog('Debug bot stopped (SIGINT)');
  logFile.end();
});

process.once('SIGTERM', () => {
  debugBot.stop('SIGTERM');
  debugLog('Debug bot stopped (SIGTERM)');
  logFile.end();
});