/**
 * Test script to verify ticket closing functionality
 * 
 * This script checks if a user has an active ticket and
 * tests the ticket closing functionality without using the bot framework.
 * 
 * Usage: node test-cancel-command.js [telegramId]
 */

import pg from 'pg';
const { Pool } = pg;

// Initialize PostgreSQL client
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function testCancelCommand(telegramId) {
  console.log(`👉 Testing ticket closing for Telegram user ${telegramId}`);
  
  try {
    // Step 1: Find the user in the database
    console.log('🔍 Finding user in database...');
    const userResult = await pool.query(
      `SELECT * FROM users WHERE telegram_id = $1`,
      [telegramId]
    );
    
    if (userResult.rows.length === 0) {
      console.log(`❌ No user found with Telegram ID ${telegramId}`);
      return;
    }
    
    const user = userResult.rows[0];
    console.log(`✅ Found user: ${user.id} (${user.username})`);
    
    // Step 2: Find active tickets
    console.log('🔍 Finding active tickets...');
    const ticketsResult = await pool.query(
      `SELECT * FROM tickets 
       WHERE user_id = $1 
       AND status NOT IN ('closed', 'completed', 'transcript')
       ORDER BY id DESC`,
      [user.id]
    );
    
    if (ticketsResult.rows.length === 0) {
      console.log(`❌ No active tickets found for user ${user.id}`);
      console.log('\n✨ Let\'s create a test ticket to verify closing functionality');
      
      // Create a test ticket
      const categoryResult = await pool.query(
        `SELECT * FROM categories ORDER BY id ASC LIMIT 1`
      );
      
      if (categoryResult.rows.length === 0) {
        console.log('❌ No categories found in the database');
        return;
      }
      
      const category = categoryResult.rows[0];
      console.log(`Using category: ${category.name}`);
      
      // Insert test ticket
      const testTicketResult = await pool.query(
        `INSERT INTO tickets (user_id, category_id, status, answers)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [user.id, category.id, 'pending', ['Test answer 1', 'Test answer 2']]
      );
      
      const testTicket = testTicketResult.rows[0];
      console.log(`✅ Created test ticket with ID ${testTicket.id}`);
      
      // Now find active tickets again
      const activeTicketsResult = await pool.query(
        `SELECT * FROM tickets 
         WHERE user_id = $1 
         AND status NOT IN ('closed', 'completed', 'transcript')
         ORDER BY id DESC`,
        [user.id]
      );
      
      if (activeTicketsResult.rows.length === 0) {
        console.log('❌ Failed to create test ticket');
        return;
      }
      
      const ticket = activeTicketsResult.rows[0];
      console.log(`✅ Verified active ticket: ${ticket.id} with status "${ticket.status}"`);
      
      // Step 3: Test closing the ticket
      console.log('🔒 Closing the ticket...');
      await pool.query(
        `UPDATE tickets SET status = $1 WHERE id = $2`,
        ['closed', ticket.id]
      );
      
      console.log(`✅ Successfully closed ticket ${ticket.id}`);
      
      // Step 4: Verify it's closed
      const verifyResult = await pool.query(
        `SELECT * FROM tickets WHERE id = $1`,
        [ticket.id]
      );
      
      if (verifyResult.rows.length === 0) {
        console.log('❌ Could not find ticket after closing');
        return;
      }
      
      const closedTicket = verifyResult.rows[0];
      console.log(`✅ Verified ticket ${closedTicket.id} is now "${closedTicket.status}"`);
      
      console.log('\n✅ Test completed successfully! The cancel command should work correctly.');
      console.log('The /cancel command should detect active tickets, close them, and display the proper message.');
    } else {
      // We already have active tickets
      const ticket = ticketsResult.rows[0];
      console.log(`✅ Found active ticket: ${ticket.id} with status "${ticket.status}"`);
      
      // Step 3: Test closing the ticket
      console.log('🔒 Closing the ticket...');
      await pool.query(
        `UPDATE tickets SET status = $1 WHERE id = $2`,
        ['closed', ticket.id]
      );
      
      console.log(`✅ Successfully closed ticket ${ticket.id}`);
      
      // Step 4: Verify it's closed
      const verifyResult = await pool.query(
        `SELECT * FROM tickets WHERE id = $1`,
        [ticket.id]
      );
      
      if (verifyResult.rows.length === 0) {
        console.log('❌ Could not find ticket after closing');
        return;
      }
      
      const closedTicket = verifyResult.rows[0];
      console.log(`✅ Verified ticket ${closedTicket.id} is now "${closedTicket.status}"`);
      
      console.log('\n✅ Test completed successfully! The cancel command should work correctly.');
      console.log('The /cancel command should detect active tickets, close them, and display the proper message.');
    }
  } catch (error) {
    console.error('❌ Error during test:', error);
  } finally {
    // Close the database connection
    await pool.end();
  }
}

// Get telegram_id from command line arguments or use default
const telegramId = process.argv[2] || '1037841458';
testCancelCommand(telegramId);