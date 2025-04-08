/**
 * Direct/standalone command line utility to close a Telegram ticket
 * Usage: node direct-close-command.js [telegramId]
 * 
 * This is a fallback utility in case the regular /close command doesn't work in Telegram.
 */

require('dotenv').config();
const { Pool } = require('pg');

// Initialize database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function directCloseTicket(telegramId) {
  console.log(`Attempting to close ticket for Telegram user ${telegramId}...`);
  
  try {
    // 1. Find the user in the database
    console.log('Finding user...');
    const userQueryResult = await pool.query(
      `SELECT * FROM users WHERE telegram_id = $1`,
      [telegramId.toString()]
    );
    
    if (!userQueryResult.rows || userQueryResult.rows.length === 0) {
      console.error(`User with Telegram ID ${telegramId} not found in database`);
      return false;
    }
    
    const user = userQueryResult.rows[0];
    console.log(`Found user ${user.id} with Telegram ID ${telegramId}`);
    
    // 2. Find active tickets
    console.log('Finding active tickets...');
    const ticketsQueryResult = await pool.query(
      `SELECT * FROM tickets 
       WHERE user_id = $1 
       AND status NOT IN ('closed', 'completed', 'transcript')
       ORDER BY id DESC`,
      [user.id]
    );
    
    if (!ticketsQueryResult.rows || ticketsQueryResult.rows.length === 0) {
      console.error(`No active tickets found for user ${user.id}`);
      return false;
    }
    
    // 3. Get the most recent active ticket
    const ticket = ticketsQueryResult.rows[0];
    console.log(`Found active ticket ${ticket.id} with status ${ticket.status}`);
    
    // 4. Close the ticket
    console.log('Closing ticket...');
    await pool.query(
      `UPDATE tickets SET status = $1 WHERE id = $2`,
      ['closed', ticket.id]
    );
    
    console.log(`Successfully closed ticket ${ticket.id} for user ${user.id} (${telegramId})`);
    return true;
  } catch (error) {
    console.error(`ERROR: ${error}`);
    return false;
  } finally {
    // Close the database connection pool
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
directCloseTicket(telegramId)
  .then(success => {
    if (success) {
      console.log('TICKET CLOSED SUCCESSFULLY');
      process.exit(0);
    } else {
      console.error('FAILED TO CLOSE TICKET');
      process.exit(1);
    }
  })
  .catch(err => {
    console.error('UNEXPECTED ERROR:', err);
    process.exit(1);
  });