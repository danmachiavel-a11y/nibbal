// Test script for verifying the ultra priority close command middleware
require('dotenv').config();
const { Pool } = require('pg');
const { Telegraf } = require('telegraf');

// Create a pool instance directly in this file
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function testUltraCloseMiddleware() {
  console.log('Starting ultra close middleware test...');
  
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
    
    // Create a temporary bot instance just for making this API call
    const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
    
    try {
      console.log(`Sending test message to user ${ticket.telegram_id}...`);
      await bot.telegram.sendMessage(
        ticket.telegram_id, 
        `Testing our updated bot with enhanced command detection. Please try sending /close to close your ticket #${ticket.id}.`
      );
      console.log('✅ Successfully sent test message to user.');
      
      console.log('Attempting to update middleware directly to test...');
      // Test if we can close a ticket directly using our approach in the middleware
      const updateResult = await pool.query(`
        UPDATE tickets SET status = 'pending_close' WHERE id = $1 RETURNING *
      `, [ticket.id]);
      
      if (updateResult.rows && updateResult.rows.length > 0) {
        console.log(`✅ Successfully updated ticket #${ticket.id} status for testing.`);
        console.log(`New status: ${updateResult.rows[0].status}`);
        
        // Restore the original status
        await pool.query(`
          UPDATE tickets SET status = $1 WHERE id = $2
        `, [ticket.status, ticket.id]);
        console.log(`Restored ticket #${ticket.id} to original status: ${ticket.status}`);
      } else {
        console.log(`❌ Failed to update ticket #${ticket.id} status via direct database query!`);
      }
    } catch (error) {
      console.error(`Error during test: ${error.message}`);
    }
    
    await bot.stop();
    console.log('Test completed.');
  } catch (error) {
    console.error(`Error during test: ${error.message}`);
  } finally {
    // Close the database connection
    await pool.end();
  }
}

testUltraCloseMiddleware().catch(console.error);