import { Telegraf } from 'telegraf';
import pg from 'pg';
import dotenv from 'dotenv';

// Configure environment variables
dotenv.config();

const { Pool } = pg;

// Create database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Create Telegram bot instance just for the /close command
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

console.log("Starting force-close Telegram command handler...");

// Set up the /close command to force close ANY ticket
bot.command('close', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  
  console.log(`[FORCE-CLOSE] Received /close command from user ${userId}`);
  
  try {
    // Find the user by Telegram ID
    const userResult = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [userId.toString()]);
    
    if (userResult.rows.length === 0) {
      console.log(`[FORCE-CLOSE] User not found for Telegram ID: ${userId}`);
      await ctx.reply("❌ You don't have any tickets in our system.");
      return;
    }
    
    const user = userResult.rows[0];
    console.log(`[FORCE-CLOSE] Found user with ID: ${user.id}`);
    
    // Find ALL tickets by this user, regardless of status
    const ticketsResult = await pool.query('SELECT * FROM tickets WHERE user_id = $1 ORDER BY id DESC', [user.id]);
    
    if (ticketsResult.rows.length === 0) {
      console.log(`[FORCE-CLOSE] No tickets found for user ID: ${user.id}`);
      await ctx.reply("❌ You don't have any tickets to close.");
      return;
    }
    
    // Force close ALL tickets that aren't already closed
    let closedCount = 0;
    for (const ticket of ticketsResult.rows) {
      if (ticket.status !== 'closed' && ticket.status !== 'completed' && ticket.status !== 'transcript') {
        console.log(`[FORCE-CLOSE] Force closing ticket ID: ${ticket.id}, current status: ${ticket.status}`);
        
        // Update ticket status to closed
        await pool.query('UPDATE tickets SET status = $1 WHERE id = $2', ['closed', ticket.id]);
        closedCount++;
        
        // If the ticket has a Discord channel, log it for reference
        if (ticket.discord_channel_id) {
          console.log(`[FORCE-CLOSE] Ticket ${ticket.id} has Discord channel: ${ticket.discord_channel_id}`);
          // We don't attempt to move the channel here, the main bot will handle that
        }
      }
    }
    
    if (closedCount > 0) {
      console.log(`[FORCE-CLOSE] Successfully closed ${closedCount} tickets for user ID: ${user.id}`);
      await ctx.reply(`✅ Successfully closed ${closedCount} ticket(s). Discord channels will be moved to archives soon.`);
    } else {
      console.log(`[FORCE-CLOSE] No active tickets found to close for user ID: ${user.id}`);
      await ctx.reply("ℹ️ You don't have any active tickets to close.");
    }
  } catch (error) {
    console.error(`[FORCE-CLOSE] Error: ${error.message}`);
    await ctx.reply("❌ An error occurred while processing your request. Please try again later.");
  }
});

// Launch the bot
bot.launch()
  .then(() => console.log("Force-close Telegram command handler is running."))
  .catch(err => console.error("Failed to start the bot:", err));

// Handle graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// Keep the process running
console.log("Bot is now listening for the /close command...");