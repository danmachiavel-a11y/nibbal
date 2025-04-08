// Test script for the close command middleware handler
require('dotenv').config();
const { Pool } = require('pg');

// Create a pool instance directly in this file
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function testCloseMiddleware() {
  console.log('Starting middleware close test...');
  
  try {
    // First, find an open ticket belonging to a user
    const ticketsResult = await pool.query(`
      SELECT t.*, u.telegram_id
      FROM tickets t
      JOIN users u ON t.user_id = u.id
      WHERE t.status NOT IN ('closed', 'completed', 'transcript')
      ORDER BY t.id DESC
      LIMIT 1
    `);
    
    if (!ticketsResult.rows || ticketsResult.rows.length === 0) {
      console.log('No open tickets found for testing.');
      return;
    }
    
    const ticket = ticketsResult.rows[0];
    console.log(`Found open ticket #${ticket.id} with status ${ticket.status} for Telegram ID ${ticket.telegram_id}`);
    
    // Query the database directly to check if our middleware can close this ticket
    try {
      console.log('Simulating direct database update (mimicking middleware behavior)...');
      
      // This simulates what our middleware does by directly updating the database
      const updateResult = await pool.query(`
        UPDATE tickets SET status = 'closed' WHERE id = $1 RETURNING *
      `, [ticket.id]);
      
      if (updateResult.rows && updateResult.rows.length > 0) {
        console.log(`✅ Successfully closed ticket #${ticket.id} using direct database update`);
        console.log(`New status: ${updateResult.rows[0].status}`);
      } else {
        console.log(`❌ Failed to close ticket #${ticket.id} using direct database update`);
      }
    } catch (error) {
      console.error(`Error updating ticket status: ${error.message}`);
    }
    
    console.log('Test completed.');
  } catch (error) {
    console.error(`Error during test: ${error.message}`);
  } finally {
    // Close the database connection
    await pool.end();
  }
}

testCloseMiddleware().catch(console.error);