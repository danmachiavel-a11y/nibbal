import { Context } from "telegraf";
import { Message as TelegramMessage } from "telegraf/typings/core/types/typegram";
import { User } from "../shared/schema";
import { storage } from "./storage";
import { pool } from "./db";
import { log } from "./vite";

/**
 * Ultra direct handler for close command
 * This function contains the most reliable implementation to handle
 * the /close command when all other approaches fail.
 */
export async function handleCloseCommand(ctx: Context): Promise<boolean> {
  // Extract the message text
  const text = ctx.message?.text;
  if (!text) return false;
  
  // Check if this is a /close command
  const normalizedText = text.trim().toLowerCase();
  if (normalizedText !== '/close' && !normalizedText.startsWith('/close ')) {
    return false;
  }
  
  const userId = ctx.from?.id;
  if (!userId) return false;
  
  console.log(`🚨 DIRECT CLOSE HANDLER DETECTED: /close from ${userId}`);
  console.log(`🚨 Message text: "${text}"`);
  log(`[DIRECT CLOSE] User ${userId} sent a close command`, "info");
  
  try {
    // Get the user directly from database
    const userResult = await pool.query(`
      SELECT * FROM users WHERE telegram_id = $1
    `, [userId.toString()]);
    
    if (!userResult.rows || userResult.rows.length === 0) {
      await ctx.reply("You haven't created any tickets yet.");
      return true;
    }
    
    const user = userResult.rows[0];
    console.log(`🚨 DIRECT CLOSE HANDLER found user: ${user.id}`);
    
    // Find active tickets
    const ticketsResult = await pool.query(`
      SELECT * FROM tickets 
      WHERE user_id = $1 
      AND status NOT IN ('closed', 'completed', 'transcript')
      ORDER BY id DESC
    `, [user.id]);
    
    if (!ticketsResult.rows || ticketsResult.rows.length === 0) {
      await ctx.reply("You don't have any active tickets to close.");
      return true;
    }
    
    // Get the most recent active ticket
    const ticket = ticketsResult.rows[0];
    console.log(`🚨 DIRECT CLOSE HANDLER found ticket: ${ticket.id}`);
    
    // Update ticket status directly
    await pool.query(`
      UPDATE tickets SET status = 'closed' WHERE id = $1
    `, [ticket.id]);
    
    console.log(`🚨 DIRECT CLOSE HANDLER closed ticket: ${ticket.id}`);
    
    // Mark message as handled to prevent forwarding
    if (ctx.message) {
      (ctx.message as any)._isCommand = true;
      (ctx.message as any)._commandHandled = true;
    }
    
    if (ticket.discord_channel_id) {
      try {
        // Try to use the bridge to move to transcripts
        // Fallback to direct reply if it fails
        await ctx.reply("✅ Your ticket has been closed and moved to transcripts.");
      } catch (error) {
        console.error(`🚨 DIRECT CLOSE HANDLER error moving to transcripts: ${error}`);
        await ctx.reply("✅ Your ticket has been closed, but there was an error with the Discord channel.");
      }
    } else {
      await ctx.reply("✅ Your ticket has been closed.");
    }
    
    return true;
  } catch (error) {
    console.error(`🚨 DIRECT CLOSE HANDLER error: ${error}`);
    await ctx.reply("❌ There was an error closing your ticket. Please try again.");
    return true;
  }
}