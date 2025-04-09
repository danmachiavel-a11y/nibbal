// Ultra Simple Standalone Telegram Bot that ONLY handles the /close command
// This is a replacement for the main bot's close functionality
require('dotenv').config();
const { Telegraf } = require('telegraf');
const { Pool } = require('pg');

// Create database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Initialize the standalone bot
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

console.log("Starting standalone close-only bot...");

// Register ONLY the close command
bot.command('close', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  
  console.log(`STANDALONE CLOSE BOT: Received /close command from user ${userId}`);
  
  try {
    // Find the user in database
    const userResult = await pool.query(
      'SELECT * FROM users WHERE telegram_id = $1',
      [userId.toString()]
    );
    
    if (!userResult.rows || userResult.rows.length === 0) {
      await ctx.reply("You haven't created any tickets yet.");
      return;
    }
    
    const user = userResult.rows[0];
    console.log(`STANDALONE CLOSE BOT: Found user ${user.id}`);
    
    // Find active tickets
    const ticketsResult = await pool.query(
      `SELECT * FROM tickets 
       WHERE user_id = $1 
       AND status NOT IN ('closed', 'completed', 'transcript')
       ORDER BY id DESC`,
      [user.id]
    );
    
    if (!ticketsResult.rows || ticketsResult.rows.length === 0) {
      await ctx.reply("You don't have any active tickets to close.");
      return;
    }
    
    // Get the most recent active ticket
    const ticket = ticketsResult.rows[0];
    console.log(`STANDALONE CLOSE BOT: Found ticket ${ticket.id} with status ${ticket.status}`);
    
    // Update ticket status directly
    await pool.query(
      'UPDATE tickets SET status = $1 WHERE id = $2',
      ['closed', ticket.id]
    );
    
    console.log(`STANDALONE CLOSE BOT: Closed ticket ${ticket.id}`);
    
    await ctx.reply(`✅ Ticket #${ticket.id} has been closed.`);
    
  } catch (error) {
    console.error(`STANDALONE CLOSE BOT error: ${error}`);
    await ctx.reply("❌ There was an error closing your ticket. Please try again.");
  }
});

// Simple text handler for all other messages
bot.on('text', async (ctx) => {
  const text = ctx.message?.text?.toLowerCase();
  
  // Only respond to direct close-related requests
  if (text === '/close' || text?.includes('close')) {
    await ctx.reply("To close your ticket, please use the /close command directly.");
  }
});

// Launch the bot
bot.launch().then(() => {
  console.log('Standalone close bot is running!');
  console.log('This bot ONLY handles the /close command');
}).catch(err => {
  console.error('Failed to start bot:', err);
});

// Enable graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));