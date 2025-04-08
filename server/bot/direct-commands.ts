/**
 * Direct Command Handler
 * This module bypasses all Telegraf handlers and uses raw message events
 * to directly process critical commands when all other methods fail.
 */

import { Context } from "telegraf";
import { log } from "../vite";
import { pool } from "../db";
import { BridgeManager } from "./bridge";

/**
 * High priority implementation of the close command handler
 * Uses direct database access for maximum reliability
 */
export async function directCloseTicket(telegramId: number | string, ctx?: Context | null, bridge?: BridgeManager | null): Promise<boolean> {
  console.log(`[DIRECT CLOSE] Starting direct close for user ${telegramId}`);
  log(`[DIRECT CLOSE] Starting direct close for user ${telegramId}`, "info");
  
  // Send an acknowledgment if we have a context
  if (ctx) {
    try {
      await ctx.reply("⚙️ Direct ticket closing method activated. Processing your request...");
    } catch (err) {
      console.error("[DIRECT CLOSE] Error sending initial message:", err);
    }
  }
  
  try {
    // 1. Find the user in the database
    console.log('[DIRECT CLOSE] Finding user in database...');
    const userQueryResult = await pool.query(
      `SELECT * FROM users WHERE telegram_id = $1`,
      [telegramId.toString()]
    );
    
    if (!userQueryResult.rows || userQueryResult.rows.length === 0) {
      console.error(`[DIRECT CLOSE] User with Telegram ID ${telegramId} not found in database`);
      if (ctx) {
        try {
          await ctx.reply("❌ User not found. Please use /start first to create a ticket.");
        } catch (err) {
          console.error("[DIRECT CLOSE] Error sending user not found message:", err);
        }
      }
      return false;
    }
    
    const user = userQueryResult.rows[0];
    console.log(`[DIRECT CLOSE] Found user ${user.id} with Telegram ID ${telegramId}`);
    
    // Progress update
    if (ctx) {
      try {
        await ctx.reply("✅ User account found. Looking for active tickets...");
      } catch (err) {
        console.error("[DIRECT CLOSE] Error sending user found message:", err);
      }
    }
    
    // 2. Find active tickets
    console.log('[DIRECT CLOSE] Finding active tickets...');
    const ticketsQueryResult = await pool.query(
      `SELECT * FROM tickets 
       WHERE user_id = $1 
       AND status NOT IN ('closed', 'completed', 'transcript')
       ORDER BY id DESC`,
      [user.id]
    );
    
    if (!ticketsQueryResult.rows || ticketsQueryResult.rows.length === 0) {
      console.error(`[DIRECT CLOSE] No active tickets found for user ${user.id}`);
      if (ctx) {
        try {
          await ctx.reply("❌ No active tickets found. Use /start to create a new ticket.");
        } catch (err) {
          console.error("[DIRECT CLOSE] Error sending no tickets message:", err);
        }
      }
      return false;
    }
    
    // 3. Get the most recent active ticket
    const ticket = ticketsQueryResult.rows[0];
    console.log(`[DIRECT CLOSE] Found active ticket ${ticket.id} with status ${ticket.status}`);
    
    // Progress update
    if (ctx) {
      try {
        await ctx.reply(`✅ Found active ticket #${ticket.id} with status "${ticket.status}". Closing it now...`);
      } catch (err) {
        console.error("[DIRECT CLOSE] Error sending ticket found message:", err);
      }
    }
    
    // 4. Close the ticket
    console.log('[DIRECT CLOSE] Closing ticket...');
    await pool.query(
      `UPDATE tickets SET status = $1 WHERE id = $2`,
      ['closed', ticket.id]
    );
    
    console.log(`[DIRECT CLOSE] Successfully closed ticket ${ticket.id} for user ${user.id} (${telegramId})`);
    
    // 5. Handle Discord channel if applicable and if bridge is available
    if (ticket.discord_channel_id && bridge) {
      console.log(`[DIRECT CLOSE] Ticket has Discord channel: ${ticket.discord_channel_id}`);
      try {
        // Convert to number to ensure type safety
        const ticketId = parseInt(ticket.id.toString(), 10);
        console.log(`[DIRECT CLOSE] Moving to transcripts with ticket ID ${ticketId}`);
        await bridge.moveToTranscripts(ticketId);
        console.log('[DIRECT CLOSE] Successfully moved ticket to transcripts');
        
        if (ctx) {
          try {
            await ctx.reply("✅ Your ticket has been closed and moved to Discord transcripts. Use /start to create a new ticket if needed.");
          } catch (err) {
            console.error("[DIRECT CLOSE] Error sending final success message:", err);
          }
        }
      } catch (error) {
        console.error(`[DIRECT CLOSE] Error moving ticket to transcripts:`, error);
        if (ctx) {
          try {
            await ctx.reply("✅ Your ticket has been closed, but there was an error with the Discord channel. Use /start to create a new ticket if needed.");
          } catch (err) {
            console.error("[DIRECT CLOSE] Error sending partial success message:", err);
          }
        }
      }
    } else {
      console.log('[DIRECT CLOSE] Ticket has no Discord channel or bridge not available');
      if (ctx) {
        try {
          await ctx.reply("✅ Your ticket has been closed. Use /start to create a new ticket if needed.");
        } catch (err) {
          console.error("[DIRECT CLOSE] Error sending final success message:", err);
        }
      }
    }
    
    return true;
  } catch (error) {
    console.error(`[DIRECT CLOSE] Error in direct close:`, error);
    if (ctx) {
      try {
        await ctx.reply("❌ An error occurred while trying to close your ticket. Please try again later.");
      } catch (err) {
        console.error("[DIRECT CLOSE] Error sending error message:", err);
      }
    }
    return false;
  }
}

/**
 * Process raw message text to look for critical commands
 * This is a last-resort handler that does not depend on Telegraf's command system
 */
export function processRawMessage(message: any, ctx: Context, bridge: BridgeManager): Promise<boolean> {
  if (!message || !message.text || typeof message.text !== 'string') {
    return Promise.resolve(false);
  }
  
  const text = message.text.trim().toLowerCase();
  
  // Check for /close command
  if (text === '/close' || text.startsWith('/close ')) {
    console.log('[RAW PROCESSOR] Detected raw /close command');
    const userId = message.from?.id;
    if (!userId) {
      console.log('[RAW PROCESSOR] No user ID in message');
      return Promise.resolve(false);
    }
    
    console.log(`[RAW PROCESSOR] Executing direct close for user ${userId}`);
    return directCloseTicket(userId, ctx, bridge);
  }
  
  // Not a critical command
  return Promise.resolve(false);
}