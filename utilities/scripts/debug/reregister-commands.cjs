/**
 * COMMAND RE-REGISTRATION TOOL
 * 
 * This script completely removes and re-registers all bot commands with Telegram.
 * This is a troubleshooting step when the bot doesn't respond to specific commands.
 */

const { Telegraf } = require('telegraf');

// Get the token from environment
const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN not set.');
  process.exit(1);
}

async function reregisterCommands() {
  try {
    console.log('=== COMMAND RE-REGISTRATION TOOL ===');
    
    // Create a temporary API instance
    const api = new Telegraf(token).telegram;
    
    // Delete all existing commands first
    console.log('Deleting all existing commands...');
    await api.deleteMyCommands();
    console.log('✅ All commands deleted');
    
    // Verify they're gone
    const afterDelete = await api.getMyCommands();
    console.log('Commands after deletion:', afterDelete);
    
    // Define the commands
    const commands = [
      { command: 'start', description: 'Start an order with us!' },
      { command: 'close', description: 'Close your ticket' },
      { command: 'cancel', description: 'Cancel your ticket' },
      { command: 'help', description: 'Show help information' }
    ];
    
    // Set the commands
    console.log('Registering commands:', commands);
    await api.setMyCommands(commands);
    console.log('✅ Commands registered');
    
    // Verify they were set
    const afterSet = await api.getMyCommands();
    console.log('Commands after registration:', afterSet);
    
    console.log('=== COMMAND RE-REGISTRATION COMPLETE ===');
    console.log('Now restart the bot for changes to take effect');
  } catch (error) {
    console.error('ERROR:', error);
  }
}

// Run the re-registration
reregisterCommands()
  .then(() => {
    console.log('Command re-registration completed');
    process.exit(0);
  })
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });