// Emergency Close API Client - CommonJS version
// This is a fallback option when all other approaches fail
require('dotenv').config();
const fetch = require('node-fetch');
const readline = require('readline');
const { Telegraf } = require('telegraf');
const { Pool } = require('pg');

// Create database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function closeTicketForTelegramUser(telegramId) {
  try {
    console.log(`🔄 Attempting to close ticket for Telegram ID: ${telegramId}`);
    
    // First try the API method
    try {
      console.log("Method 1: Using API endpoint");
      const response = await fetch('http://localhost:5000/api/emergency/close-ticket-by-telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegramId })
      });
      
      const data = await response.json();
      
      if (response.ok) {
        console.log('✅ Method 1 Success!');
        console.log(data);
        return true;
      } else {
        console.log('❌ Method 1 Error:');
        console.log(data);
        // Continue to next method
      }
    } catch (error) {
      console.error(`❌ Method 1 Error: ${error.message}`);
      // Continue to next method
    }
    
    // If API method fails, try direct database method
    try {
      console.log("Method 2: Direct database connection");
      
      // Get user by Telegram ID
      const userResult = await pool.query(`
        SELECT * FROM users WHERE telegram_id = $1
      `, [telegramId]);
      
      if (!userResult.rows || userResult.rows.length === 0) {
        console.error("❌ User not found");
        return false;
      }
      
      const user = userResult.rows[0];
      console.log(`✅ Found user: ${user.id}`);
      
      // Find active tickets
      const ticketsResult = await pool.query(`
        SELECT * FROM tickets 
        WHERE user_id = $1 
        AND status NOT IN ('closed', 'completed', 'transcript')
        ORDER BY id DESC
      `, [user.id]);
      
      if (!ticketsResult.rows || ticketsResult.rows.length === 0) {
        console.error("❌ No active tickets found");
        return false;
      }
      
      // Get the most recent active ticket
      const ticket = ticketsResult.rows[0];
      console.log(`✅ Found ticket: ${ticket.id} with status "${ticket.status}"`);
      
      // Update ticket status
      const updateResult = await pool.query(`
        UPDATE tickets SET status = 'closed' WHERE id = $1 RETURNING *
      `, [ticket.id]);
      
      if (!updateResult.rows || updateResult.rows.length === 0) {
        console.error("❌ Failed to update ticket status");
        return false;
      }
      
      console.log(`✅ Successfully closed ticket ${ticket.id}`);
      
      // Try to send notification to user via Telegram
      try {
        console.log("Sending success notification to user...");
        const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
        await bot.telegram.sendMessage(
          telegramId,
          `✅ Your ticket #${ticket.id} has been closed via the emergency tool. Thank you!`
        );
        console.log("✅ Notification sent to user");
        await bot.stop();
      } catch (error) {
        console.error(`❌ Failed to send notification: ${error.message}`);
      }
      
      return true;
    } catch (error) {
      console.error(`❌ Method 2 Error: ${error.message}`);
      return false;
    }
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    return false;
  }
}

async function promptForTelegramId() {
  return new Promise((resolve) => {
    rl.question('Enter Telegram ID to close ticket for: ', (telegramId) => {
      resolve(telegramId);
    });
  });
}

async function main() {
  console.log('🚨 EMERGENCY TICKET CLOSE TOOL 🚨');
  console.log('Use this tool to close a ticket when the /close command fails');
  console.log('------------------------------------------------------------');
  
  let telegramId = process.argv[2];
  
  if (!telegramId) {
    telegramId = await promptForTelegramId();
  }
  
  const success = await closeTicketForTelegramUser(telegramId);
  
  if (success) {
    console.log('✅ Operation completed successfully');
  } else {
    console.log('❌ Operation failed');
  }
  
  rl.close();
  await pool.end();
}

main().catch(console.error);