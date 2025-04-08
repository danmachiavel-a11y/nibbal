// A standalone module for handling the /close command
// This provides a clean implementation that can be imported where needed
const { pool } = require("../db");
const { log } = require("../vite");

/**
 * Handles the close command for a Telegram user
 * @param {number} userId - The Telegram user ID
 * @param {object} ctx - The Telegraf context
 * @param {object} bridge - The bridge manager for Discord integration
 * @returns {Promise<boolean>} - Whether the command was successfully handled
 */
async function handleCloseCommand(userId, ctx, bridge) {
  try {
    log(`[CLOSE HANDLER] Processing /close for user ${userId}`, "info");
    
    // 1. Find the user in the database
    const userQueryResult = await pool.query(
      `SELECT * FROM users WHERE telegram_id = $1`,
      [userId.toString()]
    );
    
    if (!userQueryResult.rows || userQueryResult.rows.length === 0) {
      log(`[CLOSE HANDLER] User ${userId} not found in database`, "warn");
      await ctx.reply("❌ You haven't created any tickets yet. Use /start to create a ticket.");
      return false;
    }
    
    const user = userQueryResult.rows[0];
    log(`[CLOSE HANDLER] Found user ${user.id} for Telegram ID ${userId}`, "info");
    
    // 2. Find active tickets
    const ticketsQueryResult = await pool.query(
      `SELECT * FROM tickets 
       WHERE user_id = $1 
       AND status NOT IN ('closed', 'completed', 'transcript')
       ORDER BY id DESC`,
      [user.id]
    );
    
    if (!ticketsQueryResult.rows || ticketsQueryResult.rows.length === 0) {
      log(`[CLOSE HANDLER] No active tickets found for user ${user.id}`, "warn");
      await ctx.reply("❌ You don't have any active tickets to close. Use /start to create a new ticket.");
      return false;
    }
    
    // 3. Get the most recent active ticket
    const ticket = ticketsQueryResult.rows[0];
    log(`[CLOSE HANDLER] Found active ticket ${ticket.id} with status ${ticket.status}`, "info");
    
    // 4. Close the ticket
    await pool.query(
      `UPDATE tickets SET status = $1 WHERE id = $2`,
      ['closed', ticket.id]
    );
    
    log(`[CLOSE HANDLER] Successfully closed ticket ${ticket.id}`, "info");
    
    // 5. Handle Discord channel if applicable
    if (ticket.discord_channel_id) {
      try {
        // Convert to number to ensure type safety
        const ticketId = parseInt(ticket.id.toString(), 10);
        await bridge.moveToTranscripts(ticketId);
        log(`[CLOSE HANDLER] Successfully moved ticket ${ticketId} to transcripts`, "info");
        await ctx.reply("✅ Your ticket has been closed and moved to transcripts. Use /start to create a new ticket if needed.");
      } catch (error) {
        log(`[CLOSE HANDLER] Error moving ticket to transcripts: ${error}`, "error");
        await ctx.reply("✅ Your ticket has been closed, but there was an error with the Discord channel. Use /start to create a new ticket if needed.");
      }
    } else {
      await ctx.reply("✅ Your ticket has been closed. Use /start to create a new ticket if needed.");
    }
    
    return true;
  } catch (error) {
    log(`[CLOSE HANDLER] Error in close handler: ${error}`, "error");
    await ctx.reply("❌ An error occurred while trying to close your ticket. Please try again later.");
    return false;
  }
}

module.exports = {
  handleCloseCommand
};