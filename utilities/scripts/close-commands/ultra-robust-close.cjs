/**
 * ULTRA ROBUST CLOSE COMMAND IMPLEMENTATION
 * 
 * This is a completely standalone implementation that avoids all potential
 * conflicts with the main bot. It uses direct Telegram API methods instead
 * of the command system.
 */

const { Telegraf } = require('telegraf');
const { Pool } = require('pg');

// Load environment variables
require('dotenv').config();

// Create database connection
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Get the bot token
const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN not set in environment variables.');
  process.exit(1);
}

// Create a new bot instance with a unique name
const bot = new Telegraf(token);

console.log('Starting ultra-robust close command handler...');

// APPROACH 1: Listen for ALL messages and filter for /close
bot.on('text', async (ctx) => {
  const text = ctx.message?.text || '';
  
  // Only process if it's a close command (case insensitive)
  if (!/^\/close$/i.test(text) && !/^\/close\s/i.test(text)) {
    return;
  }
  
  const userId = ctx.from?.id;
  if (!userId) {
    console.log('No user ID found in message');
    return;
  }
  
  console.log(`[ULTRA] Detected /close command from user ${userId}`);
  
  try {
    // Send immediate acknowledgment
    await ctx.reply('🔍 Ultra close handler activated! Processing your request...');
    
    // Find the user in database
    const userResult = await pool.query(
      'SELECT * FROM users WHERE telegram_id = $1',
      [userId.toString()]
    );
    
    if (!userResult.rows?.length) {
      await ctx.reply('❌ User not found. Please use /start first to create a ticket.');
      return;
    }
    
    const user = userResult.rows[0];
    console.log(`[ULTRA] Found user: ${user.id}`);
    
    // Find active tickets
    const ticketsResult = await pool.query(
      `SELECT * FROM tickets 
       WHERE user_id = $1 
       AND status NOT IN ('closed', 'completed', 'transcript')
       ORDER BY id DESC`,
      [user.id]
    );
    
    if (!ticketsResult.rows?.length) {
      await ctx.reply('❌ No active tickets found. Use /start to create a new ticket.');
      return;
    }
    
    const ticket = ticketsResult.rows[0];
    console.log(`[ULTRA] Found ticket: ${ticket.id} with status: ${ticket.status}`);
    
    // Close the ticket
    await pool.query(
      'UPDATE tickets SET status = $1 WHERE id = $2',
      ['closed', ticket.id]
    );
    
    console.log(`[ULTRA] Successfully closed ticket: ${ticket.id}`);
    
    // Send success message
    await ctx.reply(
      `✅ Successfully closed ticket #${ticket.id}.\n\n` +
      `Previous status: ${ticket.status}\n` +
      `New status: closed\n\n` +
      `Use /start to create a new ticket if needed.`
    );
    
    // If the ticket has a Discord channel, notify the user
    if (ticket.discord_channel_id) {
      await ctx.reply(
        `ℹ️ Note: Your ticket has a Discord channel associated with it.\n` +
        `A staff member will archive it soon.`
      );
    }
  } catch (error) {
    console.error('[ULTRA] Error processing close command:', error);
    await ctx.reply('❌ An error occurred while closing your ticket. Please try again later.');
  }
});

// Also register a specific command handler as backup
bot.command('close', async (ctx) => {
  console.log('[ULTRA] Command handler triggered for /close');
  
  const userId = ctx.from?.id;
  if (!userId) {
    console.log('No user ID found in command');
    return;
  }
  
  try {
    // Send immediate acknowledgment
    await ctx.reply('🔍 Command handler activated! Processing your request...');
    
    // Find the user in database
    const userResult = await pool.query(
      'SELECT * FROM users WHERE telegram_id = $1',
      [userId.toString()]
    );
    
    if (!userResult.rows?.length) {
      await ctx.reply('❌ User not found. Please use /start first to create a ticket.');
      return;
    }
    
    const user = userResult.rows[0];
    console.log(`[ULTRA] Found user: ${user.id}`);
    
    // Find active tickets
    const ticketsResult = await pool.query(
      `SELECT * FROM tickets 
       WHERE user_id = $1 
       AND status NOT IN ('closed', 'completed', 'transcript')
       ORDER BY id DESC`,
      [user.id]
    );
    
    if (!ticketsResult.rows?.length) {
      await ctx.reply('❌ No active tickets found. Use /start to create a new ticket.');
      return;
    }
    
    const ticket = ticketsResult.rows[0];
    console.log(`[ULTRA] Found ticket: ${ticket.id} with status: ${ticket.status}`);
    
    // Close the ticket
    await pool.query(
      'UPDATE tickets SET status = $1 WHERE id = $2',
      ['closed', ticket.id]
    );
    
    console.log(`[ULTRA] Successfully closed ticket: ${ticket.id}`);
    
    // Send success message
    await ctx.reply(
      `✅ Successfully closed ticket #${ticket.id}.\n\n` +
      `Previous status: ${ticket.status}\n` +
      `New status: closed\n\n` +
      `Use /start to create a new ticket if needed.`
    );
    
    // If the ticket has a Discord channel, notify the user
    if (ticket.discord_channel_id) {
      await ctx.reply(
        `ℹ️ Note: Your ticket has a Discord channel associated with it.\n` +
        `A staff member will archive it soon.`
      );
    }
  } catch (error) {
    console.error('[ULTRA] Error processing close command:', error);
    await ctx.reply('❌ An error occurred while closing your ticket. Please try again later.');
  }
});

// Register startup message
bot.command('start', async (ctx) => {
  await ctx.reply(
    '👋 Welcome to the Ultra Robust Close Command Bot!\n\n' +
    'This is a dedicated bot for handling the /close command.\n\n' +
    'Simply type /close to close your active ticket.'
  );
});

// Register help command
bot.help(async (ctx) => {
  await ctx.reply(
    '🔹 /close - Close your active ticket\n' +
    '🔹 /start - Show welcome message\n' +
    '🔹 /help - Show this help message'
  );
});

// Launch bot
bot.launch()
  .then(() => {
    console.log('✅ Ultra robust close command bot started successfully');
    console.log(`Bot username: @${bot.botInfo.username}`);
    console.log('Users can now type /close to close their tickets');
  })
  .catch(error => {
    console.error('Error starting bot:', error);
    process.exit(1);
  });

// Enable graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));