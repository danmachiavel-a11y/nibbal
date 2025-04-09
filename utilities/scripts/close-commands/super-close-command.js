/**
 * Ultra Direct Close Command Utility
 * This is a last resort utility that works directly with the database
 * to close tickets bypassing all bot code entirely.
 * 
 * Usage: node super-close-command.js [telegram_id]
 */

// Load environment variables
require('dotenv').config();

// Import required libraries
const { Pool } = require('pg');

// Initialize database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function forceCloseTicket(telegramId) {
  console.log(`⚙️ SUPER CLOSE SYSTEM: Attempting to close ticket for user ${telegramId}...`);
  
  try {
    // Step 1: Find the user by Telegram ID
    console.log(`Looking up user with Telegram ID ${telegramId}...`);
    const userResult = await pool.query(
      `SELECT * FROM users WHERE telegram_id = $1`,
      [telegramId.toString()]
    );
    
    if (userResult.rows.length === 0) {
      console.error(`❌ ERROR: No user found with Telegram ID ${telegramId}`);
      return false;
    }
    
    const user = userResult.rows[0];
    console.log(`✅ Found user: ID ${user.id}, Telegram ID ${user.telegram_id}`);
    
    // Step 2: Find active tickets for this user
    console.log(`Looking for active tickets for user ${user.id}...`);
    const ticketsResult = await pool.query(
      `SELECT * FROM tickets 
       WHERE user_id = $1 
       AND status NOT IN ('closed', 'completed', 'transcript', 'deleted')
       ORDER BY id DESC`,
      [user.id]
    );
    
    if (ticketsResult.rows.length === 0) {
      console.error(`❌ ERROR: No active tickets found for user ${user.id}`);
      return false;
    }
    
    const ticket = ticketsResult.rows[0];
    console.log(`✅ Found active ticket: ID ${ticket.id}, Status ${ticket.status}`);
    
    // Step 3: Close the ticket
    console.log(`Closing ticket ${ticket.id}...`);
    await pool.query(
      `UPDATE tickets SET status = 'closed' WHERE id = $1`,
      [ticket.id]
    );
    
    console.log(`✅ SUCCESS: Ticket ${ticket.id} has been closed`);
    
    // Step 4: Output success message with instructions for Discord channel
    if (ticket.discord_channel_id) {
      console.log(`
      ⚠️ IMPORTANT: The ticket has been closed in the database but the Discord channel may need manual handling.
      Discord Channel ID: ${ticket.discord_channel_id}
      
      If you need to manually move the Discord channel to the transcripts category, use the Discord UI or
      run the Discord bot command for moving to transcripts:
      !movetotranscripts ${ticket.id}
      `);
    }
    
    return true;
  } catch (error) {
    console.error(`❌ FATAL ERROR: ${error.message}`);
    console.error(error.stack);
    return false;
  } finally {
    // Close the database connection
    await pool.end();
    console.log('Database connection closed');
  }
}

// Get command line arguments
const args = process.argv.slice(2);
if (!args.length) {
  console.error('Please provide a Telegram ID as an argument');
  process.exit(1);
}

const telegramId = args[0];

// Execute the close ticket function
forceCloseTicket(telegramId)
  .then(success => {
    if (success) {
      console.log('🎉 TICKET CLOSED SUCCESSFULLY 🎉');
      process.exit(0);
    } else {
      console.error('💣 FAILED TO CLOSE TICKET 💣');
      process.exit(1);
    }
  })
  .catch(err => {
    console.error('💥 UNEXPECTED ERROR:', err);
    process.exit(1);
  });