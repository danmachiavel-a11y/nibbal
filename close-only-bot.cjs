#!/usr/bin/env node

/**
 * EMERGENCY CLOSE-ONLY BOT (CommonJS Version)
 * 
 * This is a completely separate bot that handles ONLY the close command
 * with no other functionality. It uses a separate Telegram bot token.
 * 
 * Usage: 
 * 1. Create a new bot with @BotFather on Telegram
 * 2. Set the EMERGENCY_BOT_TOKEN env variable with the new token
 * 3. Run this script: node close-only-bot.cjs
 * 4. Talk to your new emergency bot with /close [telegram_id]
 */

const { Telegraf } = require('telegraf');
const { Pool } = require('pg');

// Configure Telegraf with the emergency bot token
const token = process.env.EMERGENCY_BOT_TOKEN;

if (!token) {
  console.error('ERROR: EMERGENCY_BOT_TOKEN not set.');
  console.error('Create a new bot with @BotFather and set the token as EMERGENCY_BOT_TOKEN.');
  process.exit(1);
}

// Create a new bot instance
const bot = new Telegraf(token);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

console.log('Starting emergency close-only bot...');

// Simple help command
bot.help((ctx) => {
  ctx.reply(
    '🆘 *EMERGENCY TICKET CLOSING BOT* 🆘\n\n' +
    'This bot has a single purpose: to close tickets when the main bot fails.\n\n' +
    '*Commands:*\n' +
    '• `/close [telegram_id]` - Close a ticket for the specified user\n' +
    '• `/help` - Show this help message\n\n' +
    'Example: `/close 1234567890`',
    { parse_mode: 'Markdown' }
  );
});

// Start command with instructions
bot.start((ctx) => {
  ctx.reply(
    '🚨 *Emergency Ticket Closing Bot* 🚨\n\n' +
    'This is a special bot to close tickets when the main bot fails.\n\n' +
    'To close a ticket, use the command:\n' +
    '`/close [telegram_id]`\n\n' +
    'Example: `/close 1234567890`\n\n' +
    'You will need admin permissions to use this bot.',
    { parse_mode: 'Markdown' }
  );
});

// The close command handler
bot.command('close', async (ctx) => {
  // Get the Telegram ID from the command arguments
  const args = ctx.message.text.split(' ').slice(1);
  const telegramId = args[0];
  
  if (!telegramId) {
    return ctx.reply(
      '❌ Error: You must provide a Telegram ID.\n\n' +
      'Usage: `/close [telegram_id]`\n' +
      'Example: `/close 1234567890`',
      { parse_mode: 'Markdown' }
    );
  }
  
  try {
    // Check if the user is an admin
    const fromId = ctx.from.id.toString();
    const adminCheck = await pool.query(
      `SELECT * FROM bot_config WHERE $1 = ANY(admin_telegram_ids)`,
      [fromId]
    );
    
    if (adminCheck.rows.length === 0) {
      return ctx.reply('❌ Error: You do not have permission to use this command.');
    }
    
    // Tell the user we're processing
    await ctx.reply(`🔄 Processing ticket close for Telegram ID: ${telegramId}...`);
    
    // 1. Find the user by telegram ID
    const userResult = await pool.query(
      'SELECT * FROM users WHERE telegram_id = $1',
      [telegramId.toString()]
    );
    
    if (userResult.rows.length === 0) {
      return ctx.reply(`❌ Error: No user found with Telegram ID ${telegramId}`);
    }
    
    const user = userResult.rows[0];
    await ctx.reply(`✅ Found user: ${user.username || 'Unknown'} (ID: ${user.id})`);
    
    // 2. Find active tickets for this user
    const ticketsResult = await pool.query(
      `SELECT * FROM tickets 
       WHERE user_id = $1 
       AND status NOT IN ('closed', 'completed', 'transcript', 'deleted')
       ORDER BY id DESC`,
      [user.id]
    );
    
    if (ticketsResult.rows.length === 0) {
      return ctx.reply(`❌ Error: No active tickets found for user ${user.id}`);
    }
    
    // Get the most recent active ticket
    const ticket = ticketsResult.rows[0];
    await ctx.reply(`✅ Found active ticket: ID ${ticket.id}, Status: ${ticket.status}`);
    
    // 3. Close the ticket
    await pool.query(
      'UPDATE tickets SET status = $1 WHERE id = $2',
      ['closed', ticket.id]
    );
    
    await ctx.reply(
      `✅ SUCCESS: Ticket ${ticket.id} has been closed.\n\n` +
      `User: ${user.username || 'Unknown'}\n` +
      `Telegram ID: ${telegramId}\n` +
      `Previous Status: ${ticket.status}\n` +
      `Current Status: closed`
    );
    
    // 4. Note about Discord channel
    if (ticket.discord_channel_id) {
      await ctx.reply(
        `ℹ️ NOTE: This ticket has Discord channel ID: ${ticket.discord_channel_id}\n` +
        'You may need to manually move it to the transcripts category.'
      );
    }
    
    await ctx.reply('✅ Operation completed successfully.');
    
  } catch (error) {
    console.error('ERROR:', error);
    await ctx.reply(`❌ Error: ${error.message}`);
  }
});

// Self-close command - for users to close their own tickets
bot.command('selfclose', async (ctx) => {
  try {
    // Get the user's Telegram ID
    const telegramId = ctx.from.id.toString();
    
    // Tell the user we're processing
    await ctx.reply(`🔄 Processing self-close for your account (ID: ${telegramId})...`);
    
    // 1. Find the user by telegram ID
    const userResult = await pool.query(
      'SELECT * FROM users WHERE telegram_id = $1',
      [telegramId]
    );
    
    if (userResult.rows.length === 0) {
      return ctx.reply(`❌ Error: Your account was not found in our system.`);
    }
    
    const user = userResult.rows[0];
    await ctx.reply(`✅ Found your account: ${user.username || 'Unknown'} (ID: ${user.id})`);
    
    // 2. Find active tickets for this user
    const ticketsResult = await pool.query(
      `SELECT * FROM tickets 
       WHERE user_id = $1 
       AND status NOT IN ('closed', 'completed', 'transcript', 'deleted')
       ORDER BY id DESC`,
      [user.id]
    );
    
    if (ticketsResult.rows.length === 0) {
      return ctx.reply(`❌ Error: You don't have any active tickets to close.`);
    }
    
    // Get the most recent active ticket
    const ticket = ticketsResult.rows[0];
    await ctx.reply(`✅ Found your active ticket: ID ${ticket.id}, Status: ${ticket.status}`);
    
    // 3. Close the ticket
    await pool.query(
      'UPDATE tickets SET status = $1 WHERE id = $2',
      ['closed', ticket.id]
    );
    
    await ctx.reply(
      `✅ SUCCESS: Your ticket #${ticket.id} has been closed.\n\n` +
      `Previous Status: ${ticket.status}\n` +
      `Current Status: closed`
    );
    
    // 4. Note about Discord channel
    if (ticket.discord_channel_id) {
      await ctx.reply(
        `ℹ️ NOTE: Your ticket has a Discord channel associated with it. An administrator will move it to the transcripts category.`
      );
    }
    
    await ctx.reply('✅ Operation completed successfully. Use /start with the main bot if you need to create a new ticket.');
    
  } catch (error) {
    console.error('ERROR:', error);
    await ctx.reply(`❌ Error: ${error.message}`);
  }
});

// Start the bot
bot.launch()
  .then(() => {
    console.log(`✅ Emergency close-only bot is running!`);
    console.log(`Bot username: @${bot.botInfo.username}`);
    console.log('Ready to handle /close and /selfclose commands');
  })
  .catch((error) => {
    console.error('Error starting bot:', error);
    process.exit(1);
  });

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));