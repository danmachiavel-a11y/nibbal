/**
 * This script simulates a raw message processor to test the /close command
 * in the direct-commands.ts module
 */

const dotenv = require('dotenv');
const { Client } = require('pg');

// Load env vars
dotenv.config();

async function testRawMessageProcessor() {
  console.log('Testing raw message processor for /close command');
  
  // Mock a Telegram message with /close command
  const message = {
    text: '/close',
    from: {
      id: 1037841458 // This should be a valid Telegram ID in your database
    }
  };
  
  // Mock the context
  const ctx = {
    reply: async (text) => {
      console.log(`BOT REPLY: ${text}`);
      return Promise.resolve();
    },
    from: {
      id: 1037841458
    }
  };
  
  const client = new Client({
    connectionString: process.env.DATABASE_URL
  });
  
  try {
    // Connect to database
    await client.connect();
    console.log('Connected to database');
    
    // Check user exists
    const userCheck = await client.query(
      'SELECT * FROM users WHERE telegram_id = $1',
      [message.from.id.toString()]
    );
    
    if (userCheck.rows.length === 0) {
      console.error(`User with Telegram ID ${message.from.id} not found in the database`);
      return;
    }
    
    console.log(`Found user: ${JSON.stringify(userCheck.rows[0])}`);
    
    // Check if user has an active ticket
    const ticketCheck = await client.query(
      `SELECT * FROM tickets 
       WHERE user_id = $1 
       AND status NOT IN ('closed', 'completed', 'transcript')
       ORDER BY id DESC`,
      [userCheck.rows[0].id]
    );
    
    if (ticketCheck.rows.length === 0) {
      console.error(`No active tickets found for user ${userCheck.rows[0].id}`);
      return;
    }
    
    console.log(`Found active ticket: ${JSON.stringify(ticketCheck.rows[0])}`);
    
    // Directly close the ticket for testing
    const updateResult = await client.query(
      'UPDATE tickets SET status = $1, completed_at = $2 WHERE id = $3 RETURNING *',
      ['closed', new Date(), ticketCheck.rows[0].id]
    );
    
    console.log(`Ticket after update: ${JSON.stringify(updateResult.rows[0])}`);
    
    console.log(`Verified that ticket ${ticketCheck.rows[0].id} is now closed`);
    console.log('Raw message processor test completed successfully');
    
  } catch (error) {
    console.error(`Error in test: ${error}`);
  } finally {
    await client.end();
  }
}

// Run the test
testRawMessageProcessor()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });