// The simplest possible Telegram bot for closing tickets (CommonJS version)
// No middleware, no complex handlers, just a direct database connection
require('dotenv').config();
const { Telegraf } = require('telegraf');
const { Pool } = require('pg');

// Create database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Create a very simple bot
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// ONE single handler for the close command - nothing else
bot.command('close', async (ctx) => {
  // Get user ID
  const userId = ctx.from?.id;
  if (!userId) {
    return;
  }
  
  console.log(`BASIC BOT: Received /close command from user ${userId}`);
  
  try {
    // Find user in database with one query
    const users = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [userId.toString()]);
    
    if (users.rows.length === 0) {
      await ctx.reply("You don't have any tickets.");
      return;
    }
    
    const user = users.rows[0];
    console.log(`BASIC BOT: Found user ${user.id} in database`);
    
    // Get active tickets with one query
    const tickets = await pool.query(
      `SELECT * FROM tickets 
       WHERE user_id = $1 
       AND status NOT IN ('closed', 'completed', 'transcript') 
       ORDER BY id DESC`, 
      [user.id]
    );
    
    if (tickets.rows.length === 0) {
      await ctx.reply("You don't have any active tickets to close.");
      return;
    }
    
    const ticket = tickets.rows[0];
    console.log(`BASIC BOT: Found active ticket ${ticket.id} with status ${ticket.status}`);
    
    // Close ticket with one query
    await pool.query('UPDATE tickets SET status = $1 WHERE id = $2', ['closed', ticket.id]);
    console.log(`BASIC BOT: Closed ticket ${ticket.id}`);
    
    await ctx.reply(`✅ Ticket #${ticket.id} has been closed.`);
  } catch (error) {
    console.error(`BASIC BOT: Error processing command:`, error);
    await ctx.reply("❌ An error occurred. Please try again.");
  }
});

// Start the bot
console.log('Starting super simple close bot...');
bot.launch()
  .then(() => {
    console.log('Bot started successfully!');
    console.log('ONLY the /close command is supported in this bot');
  })
  .catch(err => {
    console.error('Failed to start bot:', err);
  });

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));