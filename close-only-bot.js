// A completely separate Telegram bot dedicated solely to closing tickets
// This bot uses a different token than your main bot
import { Telegraf } from 'telegraf';
import { Pool } from 'pg';
import 'dotenv/config';

// Initialize database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Load the separate bot token
// You need to set CLOSE_BOT_TOKEN in your .env file
const BOT_TOKEN = process.env.CLOSE_BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('❌ CLOSE_BOT_TOKEN not set! Please create a new bot using BotFather and set the token.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Set the bot's description and help message
bot.telegram.setMyDescription('I am a dedicated bot to help you close your tickets. Just send me /close');
bot.telegram.setMyCommands([
  { command: 'close', description: 'Close your active ticket' },
  { command: 'help', description: 'Show help information' }
]);

// Help message
bot.command('help', async (ctx) => {
  await ctx.reply(
    "I'm a simple bot that helps you close your tickets.\n\n" +
    "Available commands:\n" +
    "/close - Close your active ticket\n" +
    "/help - Show this help message"
  );
});

// Start message
bot.command('start', async (ctx) => {
  await ctx.reply(
    "👋 Welcome to the Close Ticket Bot!\n\n" +
    "I'm a dedicated bot that helps you close your tickets. " +
    "Simply send me the /close command when you want to close your active ticket.\n\n" +
    "Type /help for more information."
  );
});

// The main close command
bot.command('close', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) {
    return;
  }
  
  console.log(`Close Bot: User ${userId} sent /close command`);
  
  try {
    // Find the user by Telegram ID
    const userResult = await pool.query(
      'SELECT * FROM users WHERE telegram_id = $1',
      [userId.toString()]
    );
    
    if (!userResult.rows.length) {
      await ctx.reply(
        "❌ You don't have any tickets in the system.\n\n" +
        "Please use the main bot to create tickets first."
      );
      return;
    }
    
    const user = userResult.rows[0];
    console.log(`Close Bot: Found user ${user.id}`);
    
    // Find active tickets
    const ticketsResult = await pool.query(
      `SELECT * FROM tickets 
       WHERE user_id = $1 
       AND status NOT IN ('closed', 'completed', 'transcript') 
       ORDER BY id DESC`,
      [user.id]
    );
    
    if (!ticketsResult.rows.length) {
      await ctx.reply(
        "❌ You don't have any active tickets to close.\n\n" +
        "All your tickets are already closed or you haven't created any yet."
      );
      return;
    }
    
    // Get most recent active ticket
    const ticket = ticketsResult.rows[0];
    console.log(`Close Bot: Found ticket ${ticket.id} with status ${ticket.status}`);
    
    // Close the ticket
    await pool.query(
      'UPDATE tickets SET status = $1 WHERE id = $2',
      ['closed', ticket.id]
    );
    
    console.log(`Close Bot: Successfully closed ticket ${ticket.id}`);
    
    // Get category name
    let categoryName = "Unknown";
    try {
      const categoryResult = await pool.query(
        'SELECT name FROM categories WHERE id = $1',
        [ticket.category_id]
      );
      
      if (categoryResult.rows.length) {
        categoryName = categoryResult.rows[0].name;
      }
    } catch (err) {
      console.error('Error getting category:', err);
    }
    
    // Send success message
    await ctx.reply(
      `✅ Success! Your ticket #${ticket.id} has been closed.\n\n` +
      `Category: ${categoryName}\n` +
      `Status: closed (was ${ticket.status})\n\n` +
      `Thank you for using our services!`
    );
  } catch (error) {
    console.error('Error processing close command:', error);
    await ctx.reply(
      "❌ There was an error closing your ticket.\n\n" +
      "Please try again or contact support if the issue persists."
    );
  }
});

// Handle unknown commands
bot.on('text', async (ctx) => {
  const text = ctx.message.text.toLowerCase();
  
  // If it looks like they're trying to send /close but made a typo
  if (text.includes('close') || text.includes('clos') || text.includes('/c')) {
    await ctx.reply(
      "It looks like you're trying to close a ticket.\n\n" +
      "Please send the exact command: /close"
    );
    return;
  }
  
  // Otherwise, send a generic help message
  await ctx.reply(
    "I only understand a few commands:\n\n" +
    "/close - Close your active ticket\n" +
    "/help - Show help information\n\n" +
    "Please use one of these commands."
  );
});

// Start the bot
console.log('Starting the Close Ticket Bot...');

bot.launch()
  .then(() => {
    console.log('✅ Close Ticket Bot started successfully!');
    console.log(`Bot username: @${bot.botInfo?.username}`);
  })
  .catch(err => {
    console.error('❌ Failed to start bot:', err);
  });

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));