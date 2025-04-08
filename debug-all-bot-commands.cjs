/**
 * COMMAND REGISTRATION DEBUG TOOL
 * 
 * This script uses the Telegram getMyCommands API to check what commands
 * are actually registered with the bot. It also tries to re-register the
 * /close command if it's missing.
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
const logFile = fs.createWriteStream('./bot-commands-debug.log', { flags: 'a' });

// Helper function to log to both console and file
function debugLog(message) {
  const timestamp = new Date().toISOString();
  const formattedMessage = `[${timestamp}] ${message}`;
  console.log(formattedMessage);
  logFile.write(formattedMessage + '\n');
}

async function checkBotCommands() {
  try {
    // Create a temporary Telegram API instance just for checking
    const api = new Telegraf(token).telegram;
    
    debugLog('=== CHECKING BOT COMMANDS ===');
    
    // Get current commands
    const commands = await api.getMyCommands();
    debugLog(`Current bot commands: ${JSON.stringify(commands, null, 2)}`);
    
    // Check if close command exists
    const hasCloseCommand = commands.some(cmd => cmd.command === 'close');
    debugLog(`Close command registered: ${hasCloseCommand}`);
    
    if (!hasCloseCommand) {
      debugLog('⚠️ /close command is NOT registered with the bot!');
      
      // Try to add the close command
      debugLog('Attempting to register the /close command...');
      
      // Add close command to existing commands
      const updatedCommands = [
        ...commands,
        { command: 'close', description: 'Close the current ticket' }
      ];
      
      await api.setMyCommands(updatedCommands);
      debugLog('✅ Successfully registered /close command');
      
      // Verify it was added
      const newCommands = await api.getMyCommands();
      debugLog(`Updated bot commands: ${JSON.stringify(newCommands, null, 2)}`);
    } else {
      debugLog('✅ /close command is properly registered');
    }
    
    // Check bot info
    const me = await api.getMe();
    debugLog(`Bot info: ${JSON.stringify(me, null, 2)}`);
    
    debugLog('=== BOT COMMANDS CHECK COMPLETE ===');
  } catch (error) {
    debugLog(`ERROR checking/updating bot commands: ${error}`);
  }
}

// Run the check
checkBotCommands()
  .then(() => {
    debugLog('Command check completed');
    process.exit(0);
  })
  .catch(error => {
    debugLog(`Fatal error: ${error}`);
    process.exit(1);
  });