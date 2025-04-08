/**
 * ULTIMATE TICKET CLOSE UTILITY
 * 
 * This script directly updates the database with NO dependencies on bot code.
 * It uses the bare minimum code needed to close a ticket, and should work when nothing else does.
 * 
 * Usage: node ultimate-close.js [telegram_id]
 * 
 * This script requires only the core pg library.
 */

// Import pg with ES modules syntax
import pg from 'pg';
const { Client } = pg;

// Get Telegram ID from command line
const telegramId = process.argv[2];

if (!telegramId) {
  console.error('ERROR: Telegram ID is required');
  console.error('Usage: node ultimate-close.js [telegram_id]');
  process.exit(1);
}

// Connect directly to the database
async function closeTicket() {
  // Create a new client directly with the DATABASE_URL
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    // Connect to database
    console.log('Connecting to database...');
    await client.connect();
    console.log('Connected to database successfully');

    // Find the user by telegram ID
    console.log(`Looking up user with Telegram ID ${telegramId}...`);
    const userQuery = 'SELECT * FROM users WHERE telegram_id = $1';
    const userResult = await client.query(userQuery, [telegramId.toString()]);

    if (userResult.rows.length === 0) {
      throw new Error(`No user found with Telegram ID ${telegramId}`);
    }

    const user = userResult.rows[0];
    console.log(`Found user: ID ${user.id}, Telegram ID ${user.telegram_id}`);

    // Find active tickets for this user
    console.log(`Looking for active tickets for user ${user.id}...`);
    const ticketsQuery = `
      SELECT * FROM tickets 
      WHERE user_id = $1 
      AND status NOT IN ('closed', 'completed', 'transcript', 'deleted')
      ORDER BY id DESC
    `;
    const ticketsResult = await client.query(ticketsQuery, [user.id]);

    if (ticketsResult.rows.length === 0) {
      throw new Error(`No active tickets found for user ${user.id}`);
    }

    // Get the most recent active ticket
    const ticket = ticketsResult.rows[0];
    console.log(`Found active ticket: ID ${ticket.id}, Status: ${ticket.status}`);

    // Update the ticket status to closed
    console.log(`Closing ticket ${ticket.id}...`);
    const updateQuery = 'UPDATE tickets SET status = $1 WHERE id = $2';
    await client.query(updateQuery, ['closed', ticket.id]);

    console.log(`=================================`);
    console.log(`✓ TICKET ${ticket.id} CLOSED SUCCESSFULLY`);
    console.log(`=================================`);
    
    if (ticket.discord_channel_id) {
      console.log(`\nNOTE: The ticket has a Discord channel (${ticket.discord_channel_id}).`);
      console.log(`You may need to manually move it to the transcripts category.`);
    }

    return ticket.id;
  } catch (error) {
    console.error('ERROR:', error.message);
    throw error;
  } finally {
    // Always close the client
    await client.end();
    console.log('Database connection closed');
  }
}

// Run the function
closeTicket()
  .then((ticketId) => {
    console.log(`\nTicket ${ticketId} has been closed by ultimate-close.js`);
    process.exit(0);
  })
  .catch((error) => {
    console.error('\nFailed to close ticket:', error.message);
    process.exit(1);
  });