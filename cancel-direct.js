/**
 * Direct implementation of the cancel command
 * This script provides a standalone implementation that bypasses the bot framework
 * entirely and executes the cancel logic directly using raw SQL.
 * 
 * Usage: node cancel-direct.js [telegramId]
 */

import { Telegraf } from 'telegraf';
import pg from 'pg';

const { Pool } = pg;

// Pull in token from environment
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Initialize Telegram bot
const bot = new Telegraf(BOT_TOKEN);

// Initialize PostgreSQL client
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Directly execute the cancel command for a user
 * @param {string} telegramId Telegram ID of the user
 */
async function executeCancel(telegramId) {
  console.log(`👉 Executing direct cancel for Telegram user ${telegramId}`);
  
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
       AND (status = 'open' OR status = 'in-progress' OR status = 'pending')
       ORDER BY id DESC`,
      [user.id]
    );
    
    if (ticketsResult.rows.length === 0) {
      console.log(`❌ No active tickets found for user ${user.id}`);
      await bot.telegram.sendMessage(telegramId, "✅ All operations cancelled. Use /start when you're ready to begin again.");
      return;
    }
    
    // Step 3: Close the ticket
    const ticket = ticketsResult.rows[0];
    console.log(`✅ Found active ticket: ${ticket.id} with status "${ticket.status}"`);
    
    console.log('🔒 Closing the ticket...');
    await pool.query(
      `UPDATE tickets SET status = $1 WHERE id = $2`,
      ['closed', ticket.id]
    );
    
    console.log(`✅ Successfully closed ticket ${ticket.id}`);
    
    // Step 4: Move to transcripts if it has a Discord channel
    if (ticket.discord_channel_id) {
      console.log(`💬 Ticket has Discord channel, trying to move to transcripts...`);
      
      // Get the category
      const categoryResult = await pool.query(
        `SELECT * FROM categories WHERE id = $1`,
        [ticket.category_id]
      );
      
      if (categoryResult.rows.length === 0) {
        console.log('❌ Category not found');
      } else {
        const category = categoryResult.rows[0];
        
        if (category.transcript_category_id) {
          console.log(`📁 Found transcript category: ${category.transcript_category_id}`);
          console.log(`👉 You would normally move the channel to transcripts here`);
          // We don't actually move it since this is a direct implementation
        } else {
          console.log('❌ No transcript category set for this service');
        }
      }
    }
    
    // Step 5: Send confirmation message to user
    await bot.telegram.sendMessage(telegramId, "✅ Your ticket has been closed! Use /start when you're ready to begin again.");
    console.log('✅ Sent confirmation message to user');
    
  } catch (error) {
    console.error('❌ Error during cancel operation:', error);
    
    try {
      await bot.telegram.sendMessage(telegramId, "❌ There was an error closing your ticket. Please try again later.");
      console.log('⚠️ Sent error message to user');
    } catch (sendError) {
      console.error('❌ Failed to send error message:', sendError);
    }
  } finally {
    // Close the database connection
    await pool.end();
  }
}

// Get telegram_id from command line arguments or use default
const telegramId = process.argv[2] || '1037841458';
executeCancel(telegramId)
  .then(() => {
    console.log('Operation completed. Exiting...');
    process.exit(0);
  })
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });