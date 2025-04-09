/**
 * SUPER SIMPLE CLOSE COMMAND
 * 
 * This script directly makes HTTP requests to the Telegram API
 * to close a ticket. It does not use any bot framework or libraries.
 * 
 * Usage: node super-simple-close.cjs [telegram_id]
 */

const https = require('https');
const { Pool } = require('pg');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN environment variable is not set');
  process.exit(1);
}

// Create database connection
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Get the Telegram ID from command line args
const telegramId = process.argv[2];
if (!telegramId) {
  console.error('ERROR: Please provide a Telegram ID as a command line argument');
  console.error('Usage: node super-simple-close.cjs [telegram_id]');
  process.exit(1);
}

console.log(`👉 Attempting to close ticket for Telegram user ${telegramId}`);

// Send a message to the user via Telegram API
async function sendTelegramMessage(chatId, text) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML'
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
    
    const req = https.request(options, (res) => {
      let responseData = '';
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      
      res.on('end', () => {
        try {
          const parsedData = JSON.parse(responseData);
          resolve(parsedData);
        } catch (e) {
          reject(new Error(`Invalid JSON response: ${responseData}`));
        }
      });
    });
    
    req.on('error', (e) => {
      reject(e);
    });
    
    req.write(data);
    req.end();
  });
}

// Main function to close a ticket
async function closeTicket() {
  try {
    // 1. Find the user
    console.log('🔍 Finding user in database...');
    const userResult = await pool.query(
      'SELECT * FROM users WHERE telegram_id = $1',
      [telegramId]
    );
    
    if (!userResult.rows || userResult.rows.length === 0) {
      console.error('❌ User not found in database');
      return;
    }
    
    const user = userResult.rows[0];
    console.log(`✅ Found user: ${user.id}`);
    
    // Send initial message
    await sendTelegramMessage(telegramId, '🔄 <b>Ticket Close Utility</b>\n\nProcessing your request...');
    
    // 2. Find active tickets
    console.log('🔍 Finding active tickets...');
    const ticketResult = await pool.query(
      `SELECT * FROM tickets 
       WHERE user_id = $1 
       AND status NOT IN ('closed', 'completed', 'transcript')
       ORDER BY id DESC`,
      [user.id]
    );
    
    if (!ticketResult.rows || ticketResult.rows.length === 0) {
      console.error('❌ No active tickets found');
      await sendTelegramMessage(telegramId, '❌ You don\'t have any active tickets to close.');
      return;
    }
    
    const ticket = ticketResult.rows[0];
    console.log(`✅ Found active ticket: ${ticket.id} (${ticket.status})`);
    
    // Send progress message
    await sendTelegramMessage(
      telegramId, 
      `✅ Found ticket #${ticket.id} with status "${ticket.status}"\n\nClosing now...`
    );
    
    // 3. Close the ticket
    console.log('🔄 Closing ticket...');
    await pool.query(
      'UPDATE tickets SET status = $1 WHERE id = $2',
      ['closed', ticket.id]
    );
    
    console.log(`✅ Successfully closed ticket ${ticket.id}`);
    
    // 4. Send confirmation
    await sendTelegramMessage(
      telegramId,
      `✅ <b>Ticket Closed Successfully</b>\n\n` +
      `Ticket #${ticket.id} has been closed.\n\n` +
      `Previous status: ${ticket.status}\n` +
      `Current status: closed\n\n` +
      `Use /start to create a new ticket if needed.`
    );
    
    // 5. If there's a Discord channel, notify about it
    if (ticket.discord_channel_id) {
      await sendTelegramMessage(
        telegramId,
        `ℹ️ Your ticket has a Discord channel associated with it.\n` +
        `It will be moved to the transcripts category by staff.`
      );
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
    try {
      await sendTelegramMessage(telegramId, '❌ An error occurred while processing your request.');
    } catch (msgError) {
      console.error('Failed to send error message:', msgError);
    }
  } finally {
    // Close the database connection
    await pool.end();
    console.log('✅ Operation complete');
  }
}

// Run the close ticket function
closeTicket();