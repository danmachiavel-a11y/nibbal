#!/usr/bin/env node

/**
 * TELEGRAM DIRECT API CALLER
 * 
 * This script skips all middleware, frameworks, and bot code,
 * and directly communicates with the Telegram Bot API.
 * 
 * Usage: node telegram-direct.cjs [telegram_id]
 */

const https = require('https');
const { Pool } = require('pg');

// Get the Telegram ID from command arguments
const telegramId = process.argv[2];

if (!telegramId) {
  console.error('ERROR: Telegram ID is required');
  console.error('Usage: node telegram-direct.cjs [telegram_id]');
  process.exit(1);
}

// Send a message to Telegram via HTTPS directly
function sendTelegramMessage(chatId, text, callback) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  
  if (!token) {
    console.error("ERROR: TELEGRAM_BOT_TOKEN not set in environment");
    return;
  }
  
  const data = JSON.stringify({
    chat_id: chatId,
    text: text
  });
  
  const options = {
    hostname: 'api.telegram.org',
    port: 443,
    path: `/bot${token}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': data.length
    }
  };
  
  console.log(`Sending message to Telegram chat ID ${chatId}: "${text.substring(0, 30)}..."`);
  
  const req = https.request(options, (res) => {
    let responseData = '';
    
    res.on('data', (chunk) => {
      responseData += chunk;
    });
    
    res.on('end', () => {
      try {
        const parsedData = JSON.parse(responseData);
        if (parsedData.ok) {
          console.log('Message sent successfully!');
          if (callback) callback(null, parsedData.result);
        } else {
          console.error(`Telegram API error: ${parsedData.description}`);
          if (callback) callback(new Error(parsedData.description));
        }
      } catch (error) {
        console.error('Error parsing response:', error);
        if (callback) callback(error);
      }
    });
  });
  
  req.on('error', (error) => {
    console.error('Request error:', error);
    if (callback) callback(error);
  });
  
  req.write(data);
  req.end();
}

// Main function to close the ticket
async function forceCloseTicket() {
  console.log('=== DIRECT TELEGRAM API TICKET CLOSER ===');
  console.log(`Processing ticket close for Telegram ID: ${telegramId}`);
  
  // Connect to the database
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });
  
  try {
    // Send a message to confirm we're processing the request
    console.log('Sending initial confirmation message...');
    sendTelegramMessage(telegramId, 
      "🛠️ DIRECT API: I'm processing your close request directly via the Telegram API. Please wait...");
    
    // Step 1: Find the user
    console.log('Looking up user in database...');
    const userResult = await pool.query(
      'SELECT * FROM users WHERE telegram_id = $1',
      [telegramId.toString()]
    );
    
    if (userResult.rows.length === 0) {
      console.error(`No user found with Telegram ID ${telegramId}`);
      sendTelegramMessage(telegramId, 
        "❌ ERROR: I couldn't find your user record in our database. Please use /start first to create a ticket.");
      return false;
    }
    
    const user = userResult.rows[0];
    console.log(`Found user: ${JSON.stringify(user)}`);
    
    // Send update to user
    sendTelegramMessage(telegramId, 
      "✅ Found your user account. Looking for active tickets...");
    
    // Step 2: Find active tickets
    console.log('Looking for active tickets...');
    const ticketsResult = await pool.query(
      `SELECT * FROM tickets 
       WHERE user_id = $1 
       AND status NOT IN ('closed', 'completed', 'transcript', 'deleted')
       ORDER BY id DESC`,
      [user.id]
    );
    
    if (ticketsResult.rows.length === 0) {
      console.error(`No active tickets found for user ${user.id}`);
      sendTelegramMessage(telegramId, 
        "❌ You don't have any active tickets to close. Use /start to create a new ticket.");
      return false;
    }
    
    // Get the most recent ticket
    const ticket = ticketsResult.rows[0];
    console.log(`Found active ticket: ${JSON.stringify(ticket)}`);
    
    // Send update to user
    sendTelegramMessage(telegramId, 
      `✅ Found active ticket ID ${ticket.id} with status "${ticket.status}". Closing it now...`);
    
    // Step 3: Close the ticket
    console.log(`Closing ticket ${ticket.id}...`);
    await pool.query(
      'UPDATE tickets SET status = $1 WHERE id = $2',
      ['closed', ticket.id]
    );
    
    console.log('Ticket closed successfully!');
    sendTelegramMessage(telegramId, 
      `✅ Your ticket has been successfully closed. Use /start to create a new ticket if needed.`);
    
    // Step 4: Handle Discord channel if needed (outside the script)
    if (ticket.discord_channel_id) {
      console.log(`NOTE: This ticket has a Discord channel (${ticket.discord_channel_id}) that may need to be moved to transcripts.`);
      
      sendTelegramMessage(telegramId, 
        `ℹ️ Your ticket has a Discord channel associated with it. An administrator will move it to the transcripts section.`);
    }
    
    console.log('========================================');
    console.log(`✅ TICKET ${ticket.id} CLOSED SUCCESSFULLY`);
    console.log('========================================');
    
    return true;
  } catch (error) {
    console.error('ERROR:', error);
    
    // Notify the user about the error
    sendTelegramMessage(telegramId, 
      `❌ An error occurred while closing your ticket: ${error.message}\n\nPlease try again later or contact an administrator.`);
    
    return false;
  } finally {
    // Close the database connection
    await pool.end();
    console.log('Database connection closed');
  }
}

// Run the function
forceCloseTicket()
  .then(success => {
    if (success) {
      console.log('Ticket closed successfully');
    } else {
      console.log('Failed to close ticket');
    }
    
    // Give some time for the remaining message callbacks to complete
    setTimeout(() => {
      process.exit(success ? 0 : 1);
    }, 5000);
  })
  .catch(error => {
    console.error('Error closing ticket:', error);
    process.exit(1);
  });