/**
 * TELEGRAM CLOSE BUTTON SOLUTION
 * 
 * Since the /close command isn't being detected, this script creates a simple
 * bot that sends an inline keyboard button users can click to close their ticket.
 */

const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');

// Get the token from environment
const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN not set.');
  process.exit(1);
}

// Create database connection
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Create bot instance
const bot = new Telegraf(token);

// Send inline keyboard with close button
bot.command('closeticket', async (ctx) => {
  try {
    const userId = ctx.from.id.toString();
    
    console.log(`User ${userId} requested close ticket button`);
    
    // Check if user has an active ticket
    const userResult = await pool.query(
      'SELECT id FROM users WHERE telegram_id = $1',
      [userId]
    );
    
    if (userResult.rows.length === 0) {
      return ctx.reply('⚠️ You don\'t have an account in our system.');
    }
    
    const dbUserId = userResult.rows[0].id;
    
    // Find active tickets
    const ticketsResult = await pool.query(
      `SELECT * FROM tickets 
       WHERE user_id = $1 
       AND status NOT IN ('closed', 'completed', 'transcript', 'deleted')
       ORDER BY id DESC`,
      [dbUserId]
    );
    
    if (ticketsResult.rows.length === 0) {
      return ctx.reply('⚠️ You don\'t have any active tickets to close.');
    }
    
    const ticket = ticketsResult.rows[0];
    
    // Create inline keyboard with close button
    const keyboard = Markup.inlineKeyboard([
      Markup.button.callback('❌ Close Ticket', `close_ticket_${ticket.id}`)
    ]);
    
    // Send message with keyboard
    await ctx.reply(
      `🎫 Ticket #${ticket.id}\n` +
      `Status: ${ticket.status}\n\n` +
      `Click the button below to close this ticket:`,
      keyboard
    );
    
  } catch (error) {
    console.error('Error in closeticket command:', error);
    ctx.reply('❌ An error occurred while processing your request.');
  }
});

// Handle callback when button is clicked
bot.action(/^close_ticket_(\d+)$/, async (ctx) => {
  try {
    const ticketId = ctx.match[1];
    const userId = ctx.from.id.toString();
    
    console.log(`User ${userId} clicked close button for ticket ${ticketId}`);
    
    // Verify user owns this ticket
    const userResult = await pool.query(
      'SELECT id FROM users WHERE telegram_id = $1',
      [userId]
    );
    
    if (userResult.rows.length === 0) {
      return ctx.reply('⚠️ You don\'t have permission to close this ticket.');
    }
    
    const dbUserId = userResult.rows[0].id;
    
    // Verify ticket exists and belongs to user
    const ticketResult = await pool.query(
      'SELECT * FROM tickets WHERE id = $1 AND user_id = $2',
      [ticketId, dbUserId]
    );
    
    if (ticketResult.rows.length === 0) {
      return ctx.answerCbQuery('⚠️ Ticket not found or not yours');
    }
    
    const ticket = ticketResult.rows[0];
    
    // Update ticket status
    await pool.query(
      'UPDATE tickets SET status = $1 WHERE id = $2',
      ['closed', ticketId]
    );
    
    // Acknowledge callback query to clear loading state
    await ctx.answerCbQuery('✅ Ticket closed successfully!');
    
    // Send confirmation message
    await ctx.editMessageText(
      `✅ Ticket #${ticketId} has been closed.\n\n` +
      `Previous status: ${ticket.status}\n` +
      `Current status: closed\n\n` +
      `Use /start to create a new ticket if needed.`
    );
    
    // If ticket has discord channel, notify about it
    if (ticket.discord_channel_id) {
      await ctx.reply(
        `ℹ️ Note: Your ticket has a Discord channel associated with it (ID: ${ticket.discord_channel_id}).\n` +
        `An administrator will move it to the transcripts category.`
      );
    }
    
  } catch (error) {
    console.error('Error in close button callback:', error);
    ctx.answerCbQuery('❌ An error occurred');
    ctx.reply('❌ An error occurred while closing your ticket.');
  }
});

// Start command with instructions
bot.start((ctx) => {
  ctx.reply(
    '👋 Welcome to the Ticket Close Button Bot!\n\n' +
    'Use the /closeticket command to get a button that closes your active ticket.\n\n' +
    'This is an alternative to the /close command which might not be working.'
  );
});

// Help command
bot.help((ctx) => {
  ctx.reply(
    '🔹 /start - Show welcome message\n' +
    '🔹 /closeticket - Get a button to close your active ticket\n' +
    '🔹 /help - Show this help message'
  );
});

// Start the bot
bot.launch()
  .then(() => {
    console.log('✅ Close Button Bot started successfully');
    console.log(`Bot username: @${bot.botInfo.username}`);
    console.log('Users can now use /closeticket to get a button that closes their ticket');
  })
  .catch((error) => {
    console.error('Error starting bot:', error);
    process.exit(1);
  });

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));