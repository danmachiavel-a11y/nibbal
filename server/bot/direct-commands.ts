/**
 * Direct Command Handler
 * This module bypasses all Telegraf handlers and uses raw message events
 * to directly process critical commands when all other methods fail.
 */

import { Context } from "telegraf";
import { log } from "../vite";
import { BridgeManager } from "./bridge";
import { storage } from "../storage";

/**
 * High priority implementation of the close command handler
 * Now using the storage interface instead of raw database access
 */
/**
 * Close a ticket by Discord channel ID
 * This is used when there's a mismatch between Discord and the database
 */
export async function closeTicketByDiscordChannel(discordChannelId: string, bridge?: BridgeManager | null): Promise<boolean> {
  try {
    log(`[EMERGENCY CLOSE] Attempting to close ticket with Discord channel ID: ${discordChannelId}`, "info");
    
    // Find the ticket with this Discord channel ID
    const ticket = await storage.getTicketByDiscordChannel(discordChannelId);
    if (!ticket) {
      log(`[EMERGENCY CLOSE] No ticket found with Discord channel ID: ${discordChannelId}`, "error");
      return false;
    }
    
    log(`[EMERGENCY CLOSE] Found ticket ID ${ticket.id} with status '${ticket.status}' for Discord channel ${discordChannelId}`, "info");
    
    // Mark as closed
    await storage.updateTicketStatus(ticket.id, "closed");
    log(`[EMERGENCY CLOSE] Successfully marked ticket ${ticket.id} as closed`, "info");
    
    // Try to move to transcripts if possible
    if (bridge && ticket.categoryId) {
      try {
        // Get category for transcript category ID
        const category = await storage.getCategory(ticket.categoryId);
        log(`[EMERGENCY CLOSE] Category for ticket: ${JSON.stringify(category)}`, "info");
        
        // Verify the category has a transcript category ID
        if (category && category.transcriptCategoryId) {
          await bridge.moveToTranscripts(ticket.id);
          log(`[EMERGENCY CLOSE] Successfully moved ticket ${ticket.id} to transcripts category ${category.transcriptCategoryId}`, "info");
        } else {
          log(`[EMERGENCY CLOSE] No transcript category found for category ${ticket.categoryId}`, "warn");
        }
      } catch (error) {
        log(`[EMERGENCY CLOSE] Error moving ticket to transcripts:`, error, "error");
      }
    }
    
    return true;
  } catch (error) {
    log(`[EMERGENCY CLOSE] Error in emergency close:`, error, "error");
    return false;
  }
}

export async function directCloseTicket(telegramId: number | string, ctx?: Context | null, bridge?: BridgeManager | null): Promise<boolean> {
  log(`[DIRECT CLOSE] Starting direct close for user ${telegramId}`, "info");
  
  // Send an acknowledgment if we have a context
  if (ctx) {
    try {
      await ctx.reply("⚙️ Direct ticket closing method activated. Processing your request...");
    } catch (err) {
      log(`[DIRECT CLOSE] Error sending initial message:`, err, "error");
    }
  }
  
  try {
    // 1. Find the user in the database using the storage interface
    log('[DIRECT CLOSE] Finding user in database...', "info");
    const user = await storage.getUserByTelegramId(telegramId.toString());
    
    if (!user) {
      log(`[DIRECT CLOSE] User with Telegram ID ${telegramId} not found in database`, "error");
      if (ctx) {
        try {
          await ctx.reply("❌ User not found. Please use /start first to create a ticket.");
        } catch (err) {
          log(`[DIRECT CLOSE] Error sending user not found message:`, err, "error");
        }
      }
      return false;
    }
    
    log(`[DIRECT CLOSE] Found user ${user.id} with Telegram ID ${telegramId}`, "info");
    
    // Progress update
    if (ctx) {
      try {
        await ctx.reply("✅ User account found. Looking for active tickets...");
      } catch (err) {
        log(`[DIRECT CLOSE] Error sending user found message:`, err, "error");
      }
    }
    
    // 2. Find active tickets using the storage interface
    log('[DIRECT CLOSE] Finding active tickets...', "info");
    const ticket = await storage.getActiveTicketByUserId(user.id);
    
    if (!ticket) {
      log(`[DIRECT CLOSE] No active tickets found for user ${user.id}`, "error");
      if (ctx) {
        try {
          await ctx.reply("❌ No active tickets found. Use /start to create a new ticket.");
        } catch (err) {
          log(`[DIRECT CLOSE] Error sending no tickets message:`, err, "error");
        }
      }
      return false;
    }
    
    log(`[DIRECT CLOSE] Found active ticket ${ticket.id} with status ${ticket.status}`, "info");
    
    // Progress update
    if (ctx) {
      try {
        await ctx.reply(`✅ Found active ticket #${ticket.id} with status "${ticket.status}". Closing it now...`);
      } catch (err) {
        log(`[DIRECT CLOSE] Error sending ticket found message:`, err, "error");
      }
    }
    
    // 4. Close the ticket using the storage interface
    log('[DIRECT CLOSE] Closing ticket...', "info");
    await storage.updateTicketStatus(ticket.id, "closed");
    
    // Verify the update worked
    const verifiedTicket = await storage.getTicket(ticket.id);
    log(`[DIRECT CLOSE] Verification: Ticket status is now '${verifiedTicket?.status}'`, "info");
    
    if (verifiedTicket?.status !== "closed") {
      log(`[DIRECT CLOSE] Failed to close ticket ${ticket.id} - status is still ${verifiedTicket?.status}`, "error");
      if (ctx) {
        try {
          await ctx.reply("❌ There was an error closing your ticket. Please try again.");
        } catch (err) {
          log(`[DIRECT CLOSE] Error sending ticket update failure message:`, err, "error");
        }
      }
      return false;
    }
    
    log(`[DIRECT CLOSE] Successfully closed ticket ${ticket.id} for user ${user.id} (${telegramId})`, "info");
    
    // 5. Handle Discord channel if applicable and if bridge is available
    if (ticket.discordChannelId && bridge) {
      log(`[DIRECT CLOSE] Ticket has Discord channel: ${ticket.discordChannelId}`, "info");
      try {
        // Get category for transcript category ID
        const category = await storage.getCategory(ticket.categoryId!);
        log(`[DIRECT CLOSE] Category for ticket: ${JSON.stringify(category)}`, "info");
        
        // Verify the category has a transcript category ID
        if (!category || !category.transcriptCategoryId) {
          log(`[DIRECT CLOSE] No transcript category found for category ${ticket.categoryId}`, "warn");
          if (ctx) {
            try {
              await ctx.reply("✅ Your ticket has been closed! (No Discord transcript category available) Use /start to create a new ticket if needed.");
            } catch (err) {
              log(`[DIRECT CLOSE] Error sending category missing message:`, err, "error");
            }
          }
          return true;
        }
        
        // Move to transcripts
        log(`[DIRECT CLOSE] Moving to transcripts with ticket ID ${ticket.id} to category ${category.transcriptCategoryId}`, "info");
        await bridge.moveToTranscripts(ticket.id);
        log('[DIRECT CLOSE] Successfully moved ticket to transcripts', "info");
        
        if (ctx) {
          try {
            await ctx.reply("✅ Your ticket has been closed and moved to Discord transcripts. Use /start to create a new ticket if needed.");
          } catch (err) {
            log(`[DIRECT CLOSE] Error sending final success message:`, err, "error");
          }
        }
      } catch (error) {
        log(`[DIRECT CLOSE] Error moving ticket to transcripts:`, error, "error");
        if (ctx) {
          try {
            await ctx.reply("✅ Your ticket has been closed, but there was an error with the Discord channel. Use /start to create a new ticket if needed.");
          } catch (err) {
            log(`[DIRECT CLOSE] Error sending partial success message:`, err, "error");
          }
        }
      }
    } else {
      log('[DIRECT CLOSE] Ticket has no Discord channel or bridge not available', "info");
      if (ctx) {
        try {
          await ctx.reply("✅ Your ticket has been closed. Use /start to create a new ticket if needed.");
        } catch (err) {
          log(`[DIRECT CLOSE] Error sending final success message:`, err, "error");
        }
      }
    }
    
    return true;
  } catch (error) {
    log(`[DIRECT CLOSE] Error in direct close:`, error, "error");
    if (ctx) {
      try {
        await ctx.reply("❌ An error occurred while trying to close your ticket. Please try again later.");
      } catch (err) {
        log(`[DIRECT CLOSE] Error sending error message:`, err, "error");
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
    log('[RAW PROCESSOR] Detected raw /close command', "info");
    const userId = message.from?.id;
    if (!userId) {
      log('[RAW PROCESSOR] No user ID in message', "info");
      return Promise.resolve(false);
    }
    
    log(`[RAW PROCESSOR] Executing direct close for user ${userId}`, "info");
    return directCloseTicket(userId, ctx, bridge);
  }
  
  // Not a critical command
  return Promise.resolve(false);
}