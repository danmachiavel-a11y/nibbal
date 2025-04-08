import pg from 'pg';
import dotenv from 'dotenv';

// Configure environment variables
dotenv.config();

const { Pool } = pg;

// Create database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Get telegram ID from command line
const telegramId = process.argv[2];

if (!telegramId) {
  console.error('Usage: node force-close-direct.js <telegramId>');
  process.exit(1);
}

console.log(`Attempting to force close all tickets for Telegram ID: ${telegramId}`);

async function forceCloseTickets() {
  try {
    // Find the user by Telegram ID
    const userResult = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
    
    if (userResult.rows.length === 0) {
      console.log(`User not found for Telegram ID: ${telegramId}`);
      process.exit(1);
    }
    
    const user = userResult.rows[0];
    console.log(`Found user with ID: ${user.id}`);
    
    // Find ALL tickets by this user, regardless of status
    const ticketsResult = await pool.query('SELECT * FROM tickets WHERE user_id = $1 ORDER BY id DESC', [user.id]);
    
    if (ticketsResult.rows.length === 0) {
      console.log(`No tickets found for user ID: ${user.id}`);
      process.exit(0);
    }
    
    console.log(`Found ${ticketsResult.rows.length} total tickets for user ID: ${user.id}`);
    
    // Force close ALL tickets
    let closedCount = 0;
    for (const ticket of ticketsResult.rows) {
      if (ticket.status !== 'closed' && ticket.status !== 'completed' && ticket.status !== 'transcript') {
        console.log(`Force closing ticket ID: ${ticket.id}, current status: ${ticket.status}`);
        
        // Update ticket status to closed
        await pool.query('UPDATE tickets SET status = $1 WHERE id = $2', ['closed', ticket.id]);
        closedCount++;
        
        // If the ticket has a Discord channel, log it for reference
        if (ticket.discord_channel_id) {
          console.log(`Ticket ${ticket.id} has Discord channel: ${ticket.discord_channel_id}`);
        }
      }
    }
    
    if (closedCount > 0) {
      console.log(`Successfully closed ${closedCount} tickets for user ID: ${user.id}`);
    } else {
      console.log(`No active tickets found to close for user ID: ${user.id}`);
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  } finally {
    // Close the database connection
    await pool.end();
  }
}

// Run the function
forceCloseTickets();