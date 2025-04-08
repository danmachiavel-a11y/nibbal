// Standalone bot that ONLY handles the /close command
// This is a last resort to fix the persistent issue
require('dotenv').config();
const { Telegraf } = require('telegraf');
const { Pool } = require('pg');

// Create database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function runStandaloneCloseBot() {
  console.log("🔄 Starting standalone /close command bot");
  
  // Create a new Telegraf instance
  const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
  
  // Only listen for text messages containing /close
  bot.on('text', async (ctx) => {
    const text = ctx.message?.text;
    if (!text) return;
    
    // Skip if not a close command
    const normalizedText = text.trim().toLowerCase();
    if (normalizedText !== '/close' && !normalizedText.startsWith('/close ')) {
      return;
    }
    
    const userId = ctx.from?.id;
    if (!userId) return;
    
    console.log(`🚨 STANDALONE BOT: Detected /close from ${userId}`);
    console.log(`🚨 Message text: "${text}"`);
    
    try {
      // Get the user directly from database
      const userResult = await pool.query(`
        SELECT * FROM users WHERE telegram_id = $1
      `, [userId.toString()]);
      
      if (!userResult.rows || userResult.rows.length === 0) {
        await ctx.reply("You haven't created any tickets yet.");
        return;
      }
      
      const user = userResult.rows[0];
      console.log(`🚨 STANDALONE BOT: Found user: ${user.id}`);
      
      // Find active tickets
      const ticketsResult = await pool.query(`
        SELECT * FROM tickets 
        WHERE user_id = $1 
        AND status NOT IN ('closed', 'completed', 'transcript')
        ORDER BY id DESC
      `, [user.id]);
      
      if (!ticketsResult.rows || ticketsResult.rows.length === 0) {
        await ctx.reply("You don't have any active tickets to close.");
        return;
      }
      
      // Get the most recent active ticket
      const ticket = ticketsResult.rows[0];
      console.log(`🚨 STANDALONE BOT: Found ticket: ${ticket.id} with status ${ticket.status}`);
      
      // Update ticket status directly
      await pool.query(`
        UPDATE tickets SET status = 'closed' WHERE id = $1
      `, [ticket.id]);
      
      console.log(`🚨 STANDALONE BOT: Closed ticket: ${ticket.id}`);
      
      // Send success message
      await ctx.reply("✅ Your ticket has been closed by the dedicated close bot.");
      
      if (ticket.discord_channel_id) {
        await ctx.reply("Note: This ticket will be moved to transcripts by the main bot.");
      }
      
    } catch (error) {
      console.error(`🚨 STANDALONE BOT error: ${error}`);
      await ctx.reply("❌ There was an error closing your ticket. Please try again.");
    }
  });
  
  // Register close command explicitly
  try {
    await bot.telegram.setMyCommands([
      { command: 'close', description: 'Close your active ticket' }
    ]);
    console.log("✅ Successfully registered /close command");
  } catch (error) {
    console.error(`❌ Error registering command: ${error.message}`);
  }
  
  console.log("🚀 Starting standalone bot...");
  bot.launch();
  
  // Enable graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

runStandaloneCloseBot().catch(console.error);