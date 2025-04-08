/**
 * ULTIMATE FORCE CLOSE UTILITY FOR TELEGRAM
 * 
 * This script directly communicates with the Telegram API using the HTTP API,
 * completely bypassing the bot framework. It sends a direct API request to
 * close a ticket.
 * 
 * Usage: node telegram-force-close.js [telegram_id]
 */

import https from 'https';
import pg from 'pg';
const { Pool } = pg;

// Get Telegram ID from command line
const telegramId = process.argv[2];

if (!telegramId) {
  console.error('❌ ERROR: Telegram ID is required');
  console.error('Usage: node telegram-force-close.js [telegram_id]');
  process.exit(1);
}

// Function to make HTTP requests to the Telegram API
function telegramApiRequest(method, params) {
  return new Promise((resolve, reject) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    
    if (!token) {
      return reject(new Error('TELEGRAM_BOT_TOKEN environment variable is not set'));
    }
    
    const data = JSON.stringify(params);
    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${token}/${method}`,
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
          if (parsedData.ok) {
            resolve(parsedData.result);
          } else {
            reject(new Error(`Telegram API error: ${parsedData.description}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse response: ${e.message}`));
        }
      });
    });
    
    req.on('error', (e) => {
      reject(new Error(`Request error: ${e.message}`));
    });
    
    req.write(data);
    req.end();
  });
}

async function closeTicket() {
  console.log(`🔄 Initializing force close for Telegram user ID: ${telegramId}`);
  
  // Create a new client with the DATABASE_URL
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });
  
  try {
    console.log('🔄 Connecting to database...');
    
    // Find the user by telegram ID
    console.log(`🔄 Looking up user with Telegram ID ${telegramId}...`);
    const userQuery = 'SELECT * FROM users WHERE telegram_id = $1';
    const userResult = await pool.query(userQuery, [telegramId.toString()]);
    
    if (userResult.rows.length === 0) {
      throw new Error(`No user found with Telegram ID ${telegramId}`);
    }
    
    const user = userResult.rows[0];
    console.log(`✅ Found user: ID ${user.id}, Telegram ID ${user.telegram_id}`);
    
    // Find active tickets for this user
    console.log(`🔄 Looking for active tickets for user ${user.id}...`);
    const ticketsQuery = `
      SELECT * FROM tickets 
      WHERE user_id = $1 
      AND status NOT IN ('closed', 'completed', 'transcript', 'deleted')
      ORDER BY id DESC
    `;
    const ticketsResult = await pool.query(ticketsQuery, [user.id]);
    
    if (ticketsResult.rows.length === 0) {
      throw new Error(`No active tickets found for user ${user.id}`);
    }
    
    // Get the most recent active ticket
    const ticket = ticketsResult.rows[0];
    console.log(`✅ Found active ticket: ID ${ticket.id}, Status: ${ticket.status}`);
    
    // Send notification to user about ticket closure
    try {
      console.log('🔄 Sending message to user via direct Telegram API...');
      await telegramApiRequest('sendMessage', {
        chat_id: telegramId,
        text: `⚙️ Force close utility is processing ticket #${ticket.id} with status "${ticket.status}"...`
      });
      console.log('✅ Successfully sent initial message to user');
    } catch (error) {
      console.error('⚠️ Error sending message to user:', error.message);
      console.log('Continuing with ticket closure...');
    }
    
    // Update the ticket status to closed
    console.log(`🔄 Closing ticket ${ticket.id}...`);
    const updateQuery = 'UPDATE tickets SET status = $1 WHERE id = $2';
    await pool.query(updateQuery, ['closed', ticket.id]);
    
    console.log('✅ Successfully closed ticket in database');
    
    // Handle Discord channel if applicable
    if (ticket.discord_channel_id) {
      console.log(`ℹ️ The ticket has a Discord channel (${ticket.discord_channel_id}).`);
      console.log(`ℹ️ You may need to manually move it to the transcripts category if needed.`);
    }
    
    // Send confirmation to user
    try {
      await telegramApiRequest('sendMessage', {
        chat_id: telegramId,
        text: `✅ Your ticket #${ticket.id} has been successfully closed.\n\nIf you need additional help, you can create a new ticket using the /start command.`
      });
      console.log('✅ Successfully sent confirmation message to user');
    } catch (error) {
      console.error('⚠️ Error sending confirmation to user:', error.message);
    }
    
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║        TICKET CLOSED SUCCESSFULLY        ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log(`Ticket ID: ${ticket.id}`);
    console.log(`User: ${user.username || 'Unknown'} (Telegram ID: ${telegramId})`);
    console.log(`Previous Status: ${ticket.status}`);
    console.log(`Current Status: closed`);
    
    return ticket.id;
  } catch (error) {
    console.error('❌ ERROR:', error.message);
    throw error;
  } finally {
    // Always close the database connection
    await pool.end();
    console.log('🔄 Database connection closed');
  }
}

// Run the function
closeTicket()
  .then((ticketId) => {
    console.log(`\n✅ Ticket ${ticketId} has been closed by telegram-force-close.js`);
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Failed to close ticket:', error.message);
    process.exit(1);
  });