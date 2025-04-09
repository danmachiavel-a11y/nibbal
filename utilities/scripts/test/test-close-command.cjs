// Script to directly test the /close command functionality
require('dotenv').config();
const { Pool } = require('pg');
const { Telegraf } = require('telegraf');

// Create a pool instance directly in this file
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function testCloseCommand() {
  console.log('Starting close command test...');
  
  try {
    // First, find an open ticket belonging to a user
    const ticketsResult = await pool.query(`
      SELECT t.*, u.telegram_id
      FROM tickets t
      JOIN users u ON t.user_id = u.id
      WHERE t.status NOT IN ('closed', 'completed', 'transcript')
      ORDER BY t.id DESC
      LIMIT 1
    `);
    
    if (!ticketsResult.rows || ticketsResult.rows.length === 0) {
      console.log('No open tickets found for testing.');
      return;
    }
    
    const ticket = ticketsResult.rows[0];
    console.log(`Found open ticket #${ticket.id} with status ${ticket.status} for Telegram ID ${ticket.telegram_id}`);
    
    // Create a temporary bot instance just for making this API call
    const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
    
    // Get the bot's commands to verify the /close command is properly registered
    const commands = await bot.telegram.getMyCommands();
    console.log('Registered bot commands:');
    console.log(JSON.stringify(commands, null, 2));
    
    // Check if /close is among the registered commands
    const closeCommand = commands.find(cmd => cmd.command === 'close');
    if (closeCommand) {
      console.log('✅ /close command is properly registered with Telegram.');
    } else {
      console.log('❌ /close command is NOT registered with Telegram!');
    }
    
    // Simulate sending a message to the user confirming we're testing
    try {
      await bot.telegram.sendMessage(
        ticket.telegram_id, 
        `Testing close command for your ticket #${ticket.id}. Please send the /close command to the bot.`
      );
      console.log(`✅ Successfully sent test message to user ${ticket.telegram_id}`);
    } catch (error) {
      console.error(`Error sending message to user: ${error.message}`);
    }
    
    await bot.stop();
    console.log('Test completed.');
  } catch (error) {
    console.error(`Error during test: ${error.message}`);
  } finally {
    // Close the database connection
    await pool.end();
  }
}

testCloseCommand().catch(console.error);