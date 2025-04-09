/**
 * Emergency Close Discord Channel
 * This script allows directly closing a ticket by its Discord channel ID
 * Usage: node emergency-close-channel.js <discord_channel_id>
 */
require('dotenv').config();
const { BridgeManager } = require('./server/bot/bridge');
const { closeTicketByDiscordChannel } = require('./server/bot/direct-commands');

async function main() {
  try {
    // Get channel ID from command line arguments
    const args = process.argv.slice(2);
    if (args.length === 0) {
      console.error('ERROR: Discord channel ID is required');
      console.log('Usage: node emergency-close-channel.js <discord_channel_id>');
      process.exit(1);
    }

    const channelId = args[0];
    console.log(`Attempting to close ticket for Discord channel ID: ${channelId}`);

    // Initialize bridge manager
    const bridge = new BridgeManager();
    console.log('Bridge manager initialized');

    // Execute close
    const result = await closeTicketByDiscordChannel(channelId, bridge);
    
    if (result) {
      console.log('✅ Successfully closed the ticket and moved to transcripts (if applicable)');
    } else {
      console.error('❌ Failed to close the ticket');
    }
  } catch (error) {
    console.error('ERROR:', error);
  } finally {
    // Force exit to avoid hanging due to open connections
    process.exit(0);
  }
}

main();