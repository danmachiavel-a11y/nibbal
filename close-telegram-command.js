import { Telegraf } from 'telegraf';
import { pool } from './server/db.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Create a new bot instance specifically for the close command
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

console.log("Starting the specialized Telegram /close command handler...");

// Only handle the /close command
bot.command('close', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  
  console.log(`[STANDALONE] Received /close command from user ${userId}`);
  
  try {
    // Query database directly to get the user
    const userQueryResult = await pool.query(`
      SELECT * FROM users WHERE telegram_id = $1
    `, [userId.toString()]);
    
    if (!userQueryResult.rows || userQueryResult.rows.length === 0) {
      console.log(`[STANDALONE] User ${userId} not found in database`);
      await ctx.reply("❌ You haven't created any tickets yet. Use /start to create a ticket.");
      return;
    }
    
    const user = userQueryResult.rows[0];
    console.log(`[STANDALONE] Found user ${user.id} for Telegram ID ${userId}`);
    
    // Query tickets directly
    const ticketsQueryResult = await pool.query(`
      SELECT * FROM tickets 
      WHERE user_id = $1 
      AND status NOT IN ('closed', 'completed', 'transcript')
      ORDER BY id DESC
    `, [user.id]);
    
    if (!ticketsQueryResult.rows || ticketsQueryResult.rows.length === 0) {
      console.log(`[STANDALONE] No active tickets found for user ${user.id}`);
      await ctx.reply("❌ You don't have any active tickets to close. Use /start to create a new ticket.");
      return;
    }
    
    const ticket = ticketsQueryResult.rows[0];
    console.log(`[STANDALONE] Found active ticket ${ticket.id} with status ${ticket.status}`);
    
    // Update ticket status directly
    await pool.query(`
      UPDATE tickets SET status = 'closed' WHERE id = $1
    `, [ticket.id]);
    
    console.log(`[STANDALONE] Successfully closed ticket ${ticket.id}`);
    
    // If there's a Discord channel, inform the user
    if (ticket.discord_channel_id) {
      console.log(`[STANDALONE] Ticket ${ticket.id} has Discord channel ${ticket.discord_channel_id}`);
      const discordChannelId = ticket.discord_channel_id;
      
      // Update to move the channel in Discord
      try {
        // This is just a placeholder - since we can't access the bridge manager directly
        // The regular bot will handle moving the channel to transcripts on its next poll
        console.log(`[STANDALONE] Ticket ${ticket.id} will be moved to transcripts by the main bot`);
        await ctx.reply("✅ Your ticket has been closed. The Discord channel will be moved to transcripts soon.");
      } catch (error) {
        console.error(`[STANDALONE] Error handling Discord channel: ${error}`);
        await ctx.reply("✅ Your ticket has been closed, but there was an error with the Discord channel.");
      }
    } else {
      await ctx.reply("✅ Your ticket has been closed.");
    }
  } catch (error) {
    console.error(`[STANDALONE] Error in /close command: ${error}`);
    await ctx.reply("❌ An error occurred while trying to close your ticket. Please try again later.");
  }
});

// Launch the bot
bot.launch()
  .then(() => console.log("Telegram /close command handler bot is running"))
  .catch(err => console.error("Failed to start the bot:", err));

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));