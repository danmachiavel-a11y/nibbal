/**
 * Direct test script to close a ticket using raw SQL
 * Usage: node direct-close-test.cjs TICKET_ID
 */

const { Client } = require('pg');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

async function closeTicket(ticketId) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL
  });

  try {
    await client.connect();
    console.log(`Connected to database, closing ticket ${ticketId}`);

    // First check if the ticket exists
    const checkResult = await client.query(
      'SELECT * FROM tickets WHERE id = $1', 
      [ticketId]
    );

    if (checkResult.rows.length === 0) {
      console.error(`Ticket with ID ${ticketId} not found`);
      return false;
    }

    console.log(`Found ticket: ${JSON.stringify(checkResult.rows[0])}`);

    // Update the ticket status to closed and set completed_at
    const result = await client.query(
      'UPDATE tickets SET status = $1, completed_at = $2 WHERE id = $3 RETURNING *',
      ['closed', new Date(), ticketId]
    );

    if (result.rows.length > 0) {
      console.log(`✅ Ticket ${ticketId} successfully closed!`);
      console.log(`Updated ticket: ${JSON.stringify(result.rows[0])}`);
      return true;
    } else {
      console.error(`❌ Failed to close ticket ${ticketId}`);
      return false;
    }
  } catch (error) {
    console.error(`Error closing ticket: ${error}`);
    return false;
  } finally {
    await client.end();
  }
}

const ticketId = process.argv[2];
if (!ticketId || isNaN(parseInt(ticketId))) {
  console.error('Please provide a valid ticket ID');
  process.exit(1);
}

closeTicket(parseInt(ticketId))
  .then(success => {
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    console.error(error);
    process.exit(1);
  });