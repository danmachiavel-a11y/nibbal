import { Telegraf, Context } from "telegraf";
import { storage } from "../storage";
import { BridgeManager } from "./bridge";
import { log } from "../vite";
import fetch from 'node-fetch';
import { pool } from "../db";
import { processRawMessage, directCloseTicket } from "./direct-commands";

/**
 * Centralized implementation of the close command handler
 * This provides a single reliable implementation to be reused across the codebase
 * WITH ENHANCED DEBUGGING
 */
async function handleCloseCommand(userId: number, ctx: Context, bridge: BridgeManager): Promise<boolean> {
  console.log(`[CLOSE HANDLER DEBUG] Starting /close handler for user ${userId}`);
  try {
    log(`[CLOSE HANDLER] Processing /close for user ${userId}`, "info");
    
    // Confirm we have a valid context object
    if (!ctx) {
      console.error("[CLOSE HANDLER ERROR] Context object is null or undefined");
      return false;
    }
    
    // Check if we have message access in the context
    if (ctx.message) {
      console.log("[CLOSE HANDLER DEBUG] ctx.message exists");
    } else {
      console.log("[CLOSE HANDLER DEBUG] ctx.message is undefined");
    }
    
    // First respond to confirm we're processing
    try {
      console.log("[CLOSE HANDLER DEBUG] Attempting to send confirmation message");
      await ctx.reply("⏱️ Looking up ticket information...");
      console.log("[CLOSE HANDLER DEBUG] Confirmation message sent successfully");
    } catch (replyError) {
      console.error("[CLOSE HANDLER ERROR] Failed to send initial confirmation:", replyError);
      // Continue with the function even if initial reply fails
    }
    
    // 1. Find the user in the database
    console.log("[CLOSE HANDLER DEBUG] Querying database for user");
    const userQueryResult = await pool.query(
      `SELECT * FROM users WHERE telegram_id = $1`,
      [userId.toString()]
    );
    console.log(`[CLOSE HANDLER DEBUG] User query result: ${JSON.stringify(userQueryResult.rowCount)} rows`);
    
    if (!userQueryResult.rows || userQueryResult.rows.length === 0) {
      console.log(`[CLOSE HANDLER DEBUG] No user found with telegram_id ${userId}`);
      log(`[CLOSE HANDLER] User ${userId} not found in database`, "warn");
      await ctx.reply("❌ You haven't created any tickets yet. Use /start to create a ticket.");
      return false;
    }
    
    const user = userQueryResult.rows[0];
    console.log(`[CLOSE HANDLER DEBUG] Found user: ${JSON.stringify(user)}`);
    log(`[CLOSE HANDLER] Found user ${user.id} for Telegram ID ${userId}`, "info");
    
    // Send a progress update
    try {
      await ctx.reply("🔍 Found your user account, checking for active tickets...");
    } catch (progressError) {
      console.error("[CLOSE HANDLER ERROR] Failed to send progress message:", progressError);
    }
    
    // 2. Find active tickets
    console.log(`[CLOSE HANDLER DEBUG] Querying tickets for user ${user.id}`);
    const ticketsQueryResult = await pool.query(
      `SELECT * FROM tickets 
       WHERE user_id = $1 
       AND status NOT IN ('closed', 'completed', 'transcript')
       ORDER BY id DESC`,
      [user.id]
    );
    console.log(`[CLOSE HANDLER DEBUG] Tickets query result: ${JSON.stringify(ticketsQueryResult.rowCount)} rows`);
    
    if (!ticketsQueryResult.rows || ticketsQueryResult.rows.length === 0) {
      console.log(`[CLOSE HANDLER DEBUG] No active tickets found for user ${user.id}`);
      log(`[CLOSE HANDLER] No active tickets found for user ${user.id}`, "warn");
      await ctx.reply("❌ You don't have any active tickets to close. Use /start to create a new ticket.");
      return false;
    }
    
    // 3. Get the most recent active ticket
    const ticket = ticketsQueryResult.rows[0];
    console.log(`[CLOSE HANDLER DEBUG] Found ticket: ${JSON.stringify(ticket)}`);
    log(`[CLOSE HANDLER] Found active ticket ${ticket.id} with status ${ticket.status}`, "info");
    
    // Send another progress update
    try {
      await ctx.reply(`🎫 Found active ticket #${ticket.id} with status "${ticket.status}". Closing it now...`);
    } catch (progressError) {
      console.error("[CLOSE HANDLER ERROR] Failed to send ticket found message:", progressError);
    }
    
    // 4. Close the ticket
    console.log(`[CLOSE HANDLER DEBUG] Updating ticket ${ticket.id} status to 'closed'`);
    await pool.query(
      `UPDATE tickets SET status = $1 WHERE id = $2`,
      ['closed', ticket.id]
    );
    
    console.log(`[CLOSE HANDLER DEBUG] Successfully closed ticket ${ticket.id}`);
    log(`[CLOSE HANDLER] Successfully closed ticket ${ticket.id}`, "info");
    
    // 5. Handle Discord channel if applicable
    if (ticket.discord_channel_id) {
      console.log(`[CLOSE HANDLER DEBUG] Ticket has Discord channel ID: ${ticket.discord_channel_id}`);
      try {
        // Convert to number to ensure type safety
        const ticketId = parseInt(ticket.id.toString(), 10);
        console.log(`[CLOSE HANDLER DEBUG] Calling bridge.moveToTranscripts(${ticketId})`);
        await bridge.moveToTranscripts(ticketId);
        console.log(`[CLOSE HANDLER DEBUG] Successfully moved ticket to transcripts`);
        log(`[CLOSE HANDLER] Successfully moved ticket ${ticketId} to transcripts`, "info");
        await ctx.reply("✅ Your ticket has been closed and moved to transcripts. Use /start to create a new ticket if needed.");
      } catch (error) {
        console.error(`[CLOSE HANDLER ERROR] Error moving ticket to transcripts:`, error);
        log(`[CLOSE HANDLER] Error moving ticket to transcripts: ${error}`, "error");
        await ctx.reply("✅ Your ticket has been closed, but there was an error with the Discord channel. Use /start to create a new ticket if needed.");
      }
    } else {
      console.log(`[CLOSE HANDLER DEBUG] Ticket has no Discord channel ID`);
      await ctx.reply("✅ Your ticket has been closed. Use /start to create a new ticket if needed.");
    }
    
    console.log(`[CLOSE HANDLER DEBUG] Close handler completed successfully`);
    return true;
  } catch (error) {
    console.error(`[CLOSE HANDLER ERROR] Detailed error:`, error);
    log(`[CLOSE HANDLER] Error in close handler: ${error}`, "error");
    await ctx.reply("❌ An error occurred while trying to close your ticket. Please try again later.");
    return false;
  }
}

// Simple rate limiting approach
interface RateLimit {
  lastRequest: number;
  count: number;
}

// Rate limit manager to handle all rate limiting logic
class RateLimitManager {
  private userRateLimits = new Map<number, RateLimit>();
  private readonly cleanupInterval: NodeJS.Timeout;
  
  constructor() {
    // Clean up expired rate limits every 5 minutes
    this.cleanupInterval = setInterval(() => this.cleanup(), 300000);
  }
  
  // Check if a user is rate limited
  isRateLimited(userId: number): boolean {
    const now = Date.now();
    const limit = this.userRateLimits.get(userId);
    
    // No previous requests or window expired
    if (!limit || now - limit.lastRequest > RATE_LIMIT_WINDOW) {
      this.userRateLimits.set(userId, { lastRequest: now, count: 1 });
      return false;
    }
    
    // Within window, increment count if below max
    if (limit.count < RATE_LIMIT_MAX_COUNT) {
      limit.count++;
      limit.lastRequest = now;
      return false;
    }
    
    // User is rate limited
    log(`Rate limit exceeded for user ${userId}. Max ${RATE_LIMIT_MAX_COUNT} requests per ${RATE_LIMIT_WINDOW}ms`);
    return true;
  }
  
  // Clean up old rate limits
  private cleanup(): void {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [userId, limit] of this.userRateLimits.entries()) {
      if (now - limit.lastRequest > RATE_LIMIT_WINDOW) {
        this.userRateLimits.delete(userId);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      log(`Cleaned up ${cleanedCount} expired rate limits`);
    }
  }
  
  // Stop cleaning up when shutting down
  stop(): void {
    clearInterval(this.cleanupInterval);
  }
}

// Proper type safety for user states
interface UserState {
  categoryId: number;
  currentQuestion: number;
  answers: string[];
  inQuestionnaire: boolean;
  activeTicketId?: number;
}

interface StateCleanup {
  timeout: NodeJS.Timeout;
  createdAt: number;
}

interface BackoffConfig {
  initialDelay: number;
  maxDelay: number;
  factor: number;
}

interface ConnectionState {
  status: 'connected' | 'disconnected' | 'reconnecting';
  lastTransition: number;
  lastError?: string;
}


// Rate limiting configuration
// Telegram limits at roughly 30 messages per second, but allow for a good margin of safety
// Telegram recommends 1 message per second (3600/hr) for private chats
const RATE_LIMIT_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW || "60000", 10); // 60 seconds window
const RATE_LIMIT_MAX_COUNT = parseInt(process.env.RATE_LIMIT_MAX_COUNT || "20", 10); // 20 requests per minute (1/3 per second)

// User state cleanup configuration 
const USER_STATE_CLEANUP_INTERVAL = 300000; // 5 minutes
const USER_INACTIVE_TIMEOUT = 3600000; // 1 hour
const MAX_INACTIVE_STATES = 1000; // Maximum number of stored states

//Original simpleEscape function has been replaced with enhanced version

// Thread-safe markdown escaping function with caching
const markdownCache = new Map<string, string>();
const MAX_CACHE_SIZE = 1000; // Maximum number of cached entries
const DEFAULT_SPECIAL_CHARS = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];

// Characters that must be escaped in Telegram MarkdownV2 format
const TELEGRAM_SPECIAL_CHARS = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];

// Simpler and more robust function to escape markdown
function simpleEscape(text: string, specialChars: string[] = DEFAULT_SPECIAL_CHARS): string {
  if (!text) return '';
  
  // For empty or very short strings, don't use cache
  if (text.length < 5) {
    return escapeWithoutCache(text, specialChars);
  }
  
  // Create a cache key that includes the text and special chars
  const cacheKey = `${text}|${specialChars.join('')}`;
  
  // Check if we have this in cache already
  if (markdownCache.has(cacheKey)) {
    return markdownCache.get(cacheKey)!;
  }
  
  // Not in cache, do the escaping
  const result = escapeWithoutCache(text, specialChars);
  
  // Cache the result if cache isn't too big
  if (markdownCache.size < MAX_CACHE_SIZE) {
    markdownCache.set(cacheKey, result);
  } else {
    // If cache is full, clear 20% of it (the oldest entries)
    const entriesToDelete = Math.floor(MAX_CACHE_SIZE * 0.2);
    let count = 0;
    for (const key of markdownCache.keys()) {
      markdownCache.delete(key);
      count++;
      if (count >= entriesToDelete) break;
    }
    // Now add the new entry
    markdownCache.set(cacheKey, result);
  }
  
  return result;
}

// The actual escaping logic
function escapeWithoutCache(text: string, specialChars: string[]): string {
  let result = '';
  
  // Process character by character
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    
    // Escape special characters
    if (specialChars.includes(char)) {
      result += '\\' + char;
    } else {
      result += char;
    }
  }
  
  return result;
}

// Direct approach to convert standard markdown to Telegram MarkdownV2 format
function preserveMarkdown(text: string): string {
  if (!text) return '';

  // Step 1: Escape all special characters EXCEPT those used in markdown syntax
  let processed = '';
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);
    
    // If it's a special character that needs escaping in Telegram MarkdownV2
    if (TELEGRAM_SPECIAL_CHARS.includes(char)) {
      // Add a backslash before the character
      processed += '\\' + char;
    } else {
      // Keep the character as is
      processed += char;
    }
  }
  
  // Step 2: Remove escape chars for markdown symbols and fix markdown syntax
  // This undoes escaping for markdown-related characters
  
  // Handle bold (** becomes *)
  processed = processed.replace(/\\\*\\\*([^*]+)\\\*\\\*/g, '*$1*');
  
  // Handle italic (* becomes _)
  processed = processed.replace(/(?<!\\\*)\\\*(?!\\\*)([^*]+)(?<!\\\*)\\\*(?!\\\*)/g, '_$1_');
  
  // Handle underscore italic
  processed = processed.replace(/\\_([^_]+)\\_/g, '_$1_');
  
  // Handle code blocks
  processed = processed.replace(/\\`([^`]+)\\`/g, '`$1`');
  
  // Handle links
  processed = processed.replace(/\\\[([^\]\\]+)\\\]\\\(([^)\\]+)\\\)/g, '[$1]($2)');
  
  return processed;
}

// Empty placeholder to avoid unused function

// Remove markdown to create plain text as a fallback
function removeMarkdown(text: string): string {
  if (!text) return '';
  
  try {
    return text.replace(/\*\*/g, '')
               .replace(/\*/g, '')
               .replace(/__/g, '')
               .replace(/_/g, '')
               .replace(/```/g, '')
               .replace(/`/g, '')
               .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  } catch (error) {
    // If any error occurs, return the original text
    console.warn(`Error removing markdown: ${error}`);
    return text;
  }
}

export class TelegramBot {
  private bot: Telegraf | null = null;
  private bridge: BridgeManager;
  private userStates: Map<number, UserState> = new Map();
  private stateCleanups: Map<number, StateCleanup> = new Map();
  private rateLimitManager: RateLimitManager = new RateLimitManager();
  private _isConnected: boolean = false;
  private isStarting: boolean = false;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private messageQueueInterval: NodeJS.Timeout | null = null;
  private processingQueue: boolean = false;
  
  // Helper method for safe telegram access
  private get telegram() {
    if (!this.bot?.telegram) {
      throw new Error("Bot or telegram not initialized");
    }
    return this.bot.telegram;
  }
  
  // Safe helper method for sending messages
  private async sendSafeMessage(chatId: number | string, text: string): Promise<void> {
    if (!this.bot) {
      console.error("Cannot send message: Bot is not initialized");
      return;
    }
    try {
      await this.bot.telegram.sendMessage(chatId, text);
    } catch (error) {
      console.error(`Error sending message to ${chatId}:`, error);
    }
  }
  private reconnectAttempts: number = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private readonly CLEANUP_DELAY = 10000; // 10 seconds
  private readonly HEARTBEAT_INTERVAL = 900000; // 15 minutes
  private readonly STATE_TIMEOUT = 900000; // 15 minutes
  private readonly RECONNECT_COOLDOWN = 30000; // 30 seconds
  private readonly MAX_FAILED_HEARTBEATS = 3;
  private failedHeartbeats = 0;
  private readonly MAX_CONCURRENT_USERS = 500;
  private activeUsers: Set<number> = new Set();
  private lastHeartbeatSuccess: number = Date.now();
  private backoffConfig: BackoffConfig = {
    initialDelay: 5000,  // 5 seconds
    maxDelay: 300000,    // 5 minutes
    factor: 2            // Double the delay each time
  };
  private connectionState: ConnectionState = {
    status: 'disconnected',
    lastTransition: Date.now()
  };

  constructor(bridge: BridgeManager) {
    if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) {
      throw new Error("Invalid Telegram bot token");
    }

    this.bridge = bridge;
    this.startCleanupInterval();
    log("Telegram bot instance created successfully");
  }

  private async verifyConnection(): Promise<boolean> {
    try {
      // First check - if the bot object is null, we're definitely not connected
      if (!this.bot) {
        log("Connection verification failed: Bot instance is null", "error");
        return false;
      }
      
      // Second check - if the telegram property is missing, we're not connected
      if (!this.bot.telegram) {
        log("Connection verification failed: Bot telegram property is null", "error");
        return false;
      }

      // If we need to immediately recover commands, process messages first then check
      const now = Date.now();
      
      // Safety mechanism: even if verification fails but we had a recent successful heartbeat
      // within the past 2 minutes, consider us connected for command processing purposes
      const recentHeartbeatWindow = 120000; // 2 minutes
      if (now - this.lastHeartbeatSuccess < recentHeartbeatWindow) {
        log(`Using recent heartbeat success (${Math.floor((now - this.lastHeartbeatSuccess)/1000)}s ago) to maintain connection status`, "info");
        return true;
      }

      try {
        // Attempt to get bot info with a timeout to avoid hanging operations
        const me = await this.bot.telegram.getMe() as any;

        // If we haven't had a successful heartbeat in 20 minutes, consider disconnected
        if (now - this.lastHeartbeatSuccess > 1200000) {
          log("No successful heartbeat in 20 minutes, considering disconnected", "warn");
          return false;
        }

        if (!me) {
          log("Bot verification failed - null response", "warn");
          return false;
        }

        this.lastHeartbeatSuccess = now;
        return true;
      } catch (error) {
        // If we get an error from the Telegram API
        log(`Bot API connection check failed: ${error}`, "error");
        
        // For resilience, maintain connection state
        // This helps with temporary API glitches
        log("Maintaining connection state despite API error", "warn");
        return this._isConnected;
      }
    } catch (error) {
      log(`Critical error in connection verification: ${error}`, "error");
      return false;
    }
  }

  private async handleHeartbeat() {
    try {
      if (!this._isConnected || this.isStarting) return;

      const isConnected = await this.verifyConnection();
      if (!isConnected) {
        this.failedHeartbeats++;
        log(`Heartbeat check failed (attempt ${this.failedHeartbeats}/${this.MAX_FAILED_HEARTBEATS}): Bot verification failed`, "warn");

        // Only disconnect after multiple consecutive failures
        if (this.failedHeartbeats >= this.MAX_FAILED_HEARTBEATS) {
          this._isConnected = false;
          await this.handleDisconnect();
        }
        return;
      }

      // Reset failed heartbeats counter on successful check
      this.failedHeartbeats = 0;
      this.lastHeartbeatSuccess = Date.now();
      log("Heartbeat successful");
    } catch (error: any) {
      log(`Heartbeat check failed: ${error}`, "warn");
      this.failedHeartbeats++;

      // Only disconnect on critical errors or after multiple failures
      if ((error && typeof error === 'object' && error.message?.includes('restart') || 
           error && typeof error === 'object' && error.message?.includes('unauthorized')) ||
        this.failedHeartbeats >= this.MAX_FAILED_HEARTBEATS) {
        this._isConnected = false;
        await this.handleDisconnect();
      }
    }
  }

  private startHeartbeat = (): void => {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(
      () => this.handleHeartbeat(),
      this.HEARTBEAT_INTERVAL
    );

    log("Started heartbeat monitoring");
  };

  private stopHeartbeat = (): void => {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    log("Stopped heartbeat monitoring");
  };

  private startCleanupInterval(): void {
    // Cleanup stale states every 5 minutes
    setInterval(() => this.cleanupStaleStates(), USER_STATE_CLEANUP_INTERVAL);
    log("Started user state cleanup interval");
  }

  private cleanupStaleStates(): void {
    const now = Date.now();
    let cleanedCount = 0;
    const stateCount = this.userStates.size;

    // Only cleanup non-questionnaire states
    for (const [userId, state] of this.userStates.entries()) {
      if (state.inQuestionnaire) continue; // Skip active questionnaires

      const cleanup = this.stateCleanups.get(userId);
      if (!cleanup || now - cleanup.createdAt > USER_INACTIVE_TIMEOUT) {
        if (cleanup?.timeout) {
          clearTimeout(cleanup.timeout);
        }
        this.userStates.delete(userId);
        this.stateCleanups.delete(userId);
        this.activeUsers.delete(userId);
        cleanedCount++;
      }
    }

    // Only log if we actually cleaned something
    if (cleanedCount > 0) {
      log(`Cleaned up ${cleanedCount} stale user states. Before: ${stateCount}, After: ${this.userStates.size}`);
    }
  }

  // New consolidated rate limiting method
  private checkRateLimit(userId: number, type: 'command' | 'message', command?: string): boolean {
    // Use our simplified rate limit manager
    if (this.rateLimitManager.isRateLimited(userId)) {
      return false;
    }
    return true;
  }

  private setState(userId: number, state: UserState) {
    // Clear existing timeout if any
    const existing = this.stateCleanups.get(userId);
    if (existing?.timeout) {
      clearTimeout(existing.timeout);
    }

    // Set new state
    this.userStates.set(userId, state);

    // Set cleanup timeout
    const timeout = setTimeout(() => {
      // Only cleanup if not in questionnaire
      const currentState = this.userStates.get(userId);
      if (!currentState?.inQuestionnaire) {
        this.userStates.delete(userId);
        this.stateCleanups.delete(userId);
        this.activeUsers.delete(userId);
        log(`State timeout for user ${userId}`);
      }
    }, USER_INACTIVE_TIMEOUT);

    this.stateCleanups.set(userId, {
      timeout,
      createdAt: Date.now()
    });
  }


  private updateConnectionState(newStatus: 'connected' | 'disconnected' | 'reconnecting', error?: string) {
    const oldStatus = this.connectionState.status;
    const now = Date.now();

    this.connectionState = {
      status: newStatus,
      lastTransition: now,
      lastError: error
    };

    log(`Connection state transition: ${oldStatus} -> ${newStatus}${error ? ` (Error: ${error})` : ''}`,
      newStatus === 'connected' ? 'info' : 'warn');
  }

  private calculateBackoffDelay(): number {
    const attempt = this.reconnectAttempts;
    const delay = Math.min(
      this.backoffConfig.initialDelay * Math.pow(this.backoffConfig.factor, attempt),
      this.backoffConfig.maxDelay
    );
    return delay;
  }

  private async handleDisconnect() {
    if (this.isStarting) return;

    this.updateConnectionState('reconnecting');
    const backoffDelay = this.calculateBackoffDelay();

    log(`Bot disconnected, waiting ${backoffDelay / 1000} seconds before reconnection attempt...`);
    await new Promise(resolve => setTimeout(resolve, backoffDelay));

    try {
      if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
        this.updateConnectionState('disconnected', 'Max reconnection attempts reached');
        log("Max reconnection attempts reached, waiting for longer cooldown", "warn");
        this.reconnectAttempts = 0;
        await new Promise(resolve => setTimeout(resolve, this.backoffConfig.maxDelay));
      }

      log(`Attempting to reconnect (attempt ${this.reconnectAttempts + 1}/${this.MAX_RECONNECT_ATTEMPTS})...`);

      // Stop existing bot instance gracefully
      if (this.bot) {
        try {
          await this.bot.stop();
        } catch (error) {
          log(`Error stopping bot during reconnect: ${error}`, "warn");
        }
      }

      await this.start();
      this.reconnectAttempts = 0;
      this.updateConnectionState('connected');
      log("Reconnection successful");
    } catch (error) {
      this.reconnectAttempts++;
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.updateConnectionState('disconnected', errorMsg);
      log(`Reconnection attempt failed: ${error}`, "error");

      if (this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
        await this.handleDisconnect();
      } else {
        log("Max reconnection attempts reached", "error");
        this.reconnectAttempts = 0;
      }
    }
  }

  private startMessageQueueProcessor = (): void => {
    if (this.messageQueueInterval) {
      clearInterval(this.messageQueueInterval);
    }

    // Process message queue every 10 seconds
    this.messageQueueInterval = setInterval(
      () => this.processMessageQueue(),
      10000
    );

    log("Started message queue processor");
  };

  private stopMessageQueueProcessor = (): void => {
    if (this.messageQueueInterval) {
      clearInterval(this.messageQueueInterval);
      this.messageQueueInterval = null;
    }
    log("Stopped message queue processor");
  };

  private async processMessageQueue(): Promise<void> {
    // Only process if bot is connected and not already processing
    if (!this._isConnected || this.processingQueue || !this.bot) {
      return;
    }

    try {
      this.processingQueue = true;
      
      // Get unprocessed messages
      const messages = await storage.getUnprocessedMessages(10);
      
      if (messages.length === 0) {
        this.processingQueue = false;
        return;
      }
      
      log(`Processing ${messages.length} queued messages`);
      
      for (const message of messages) {
        try {
          // Increment the attempt counter
          await storage.incrementMessageAttempt(message.id);
          
          // Process based on message type
          switch (message.messageType) {
            case 'text':
              if (message.content) {
                const chatId = parseInt(message.telegramUserId);
                
                // Get user by telegramId
                const user = await storage.getUserByTelegramId(message.telegramUserId);
                if (!user) {
                  log(`User not found for telegram ID: ${message.telegramUserId}`, "warn");
                  // Mark as processed since we can't handle it
                  await storage.markMessageProcessed(message.id);
                  continue;
                }

                // Get ticket from user for forwarding
                const ticket = await storage.getNonClosedTicketByUserId(user.id);
                if (ticket) {
                  // Mark as processed BEFORE storing/forwarding to prevent duplicates if something fails
                  await storage.markMessageProcessed(message.id);
                  
                  // Store message in database
                  await storage.createMessage({
                    ticketId: ticket.id,
                    content: message.content,
                    authorId: user.id,
                    platform: "telegram",
                    timestamp: new Date()
                  });
                  
                  // If ticket is active (not just pending), forward to Discord
                  if (ticket.status !== 'pending' && ticket.discordChannelId) {
                    try {
                      await this.bridge.forwardToDiscord(
                        message.content,
                        ticket.id,
                        user.username || "Telegram User",
                        undefined // We don't have the avatar URL in the queue
                      );
                      await this.sendSafeMessage(chatId, "✓ Your queued message has been delivered to Discord.");
                    } catch (error) {
                      log(`Error forwarding queued message to Discord: ${error}`, "error");
                      await this.sendSafeMessage(chatId, "⚠️ Your message was saved but could not be forwarded to Discord.");
                    }
                  } else {
                    await this.sendSafeMessage(chatId, "✓ Your message has been saved and will be delivered when your ticket is processed.");
                  }
                } else {
                  await this.sendSafeMessage(chatId, "❌ You don't have an active ticket. Use /start to create one.");
                  await storage.markMessageProcessed(message.id);
                }
              }
              break;
              
            case 'photo':
              if (message.photoId) {
                const chatId = parseInt(message.telegramUserId);
                
                // Get user by telegramId
                const user = await storage.getUserByTelegramId(message.telegramUserId);
                if (!user) {
                  log(`User not found for telegram ID: ${message.telegramUserId}`, "warn");
                  // Mark as processed since we can't handle it
                  await storage.markMessageProcessed(message.id);
                  continue;
                }

                // Get ticket from user for forwarding
                const ticket = await storage.getNonClosedTicketByUserId(user.id);
                if (ticket) {
                  // Mark as processed BEFORE storing/forwarding to prevent duplicates if something fails
                  await storage.markMessageProcessed(message.id);
                  
                  // Store message in database
                  await storage.createMessage({
                    ticketId: ticket.id,
                    content: message.content || "[Image]",
                    authorId: user.id,
                    platform: "telegram",
                    timestamp: new Date()
                  });
                  
                  // If ticket is active (not just pending) and has a Discord channel, forward to Discord
                  if (ticket.status !== 'pending' && ticket.discordChannelId) {
                    try {
                      const displayName = user.telegramName || user.username || "Telegram User";
                      
                      // Send caption if it exists
                      if (message.content) {
                        await this.bridge.forwardToDiscord(
                          message.content,
                          ticket.id,
                          displayName,
                          undefined // No avatar URL from queue
                        );
                      }
                      
                      // Pass the photo file_id directly to the bridge
                      await this.bridge.forwardToDiscord(
                        "",
                        ticket.id,
                        displayName,
                        undefined,
                        message.photoId
                      );
                      
                      await this.sendSafeMessage(chatId, "✓ Your queued photo has been forwarded to the support team.");
                    } catch (error) {
                      log(`Error forwarding queued photo to Discord: ${error}`, "error");
                      await this.sendSafeMessage(chatId, "⚠️ Your photo was saved but could not be forwarded to Discord.");
                    }
                  } else {
                    await this.sendSafeMessage(chatId, "✓ Your photo has been received, but your ticket is still pending.");
                  }
                } else {
                  await this.sendSafeMessage(chatId, "❌ You don't have an active ticket. Use /start to create one.");
                  await storage.markMessageProcessed(message.id);
                }
              }
              break;
              
            case 'command':
              if (message.commandName) {
                const chatId = parseInt(message.telegramUserId);
                
                // Get user by telegramId
                const user = await storage.getUserByTelegramId(message.telegramUserId);
                if (!user) {
                  log(`User not found for telegram ID: ${message.telegramUserId}`, "warn");
                  // Mark as processed since we can't handle it
                  await storage.markMessageProcessed(message.id);
                  continue;
                }

                // Mark command as processed
                await storage.markMessageProcessed(message.id);
                
                // For commands, just notify the user to try again
                await this.sendSafeMessage(chatId, 
                  `Your /${message.commandName} command was queued but couldn't be fully processed. Please try the command again now that the bot is online.`);
              }
              break;
          }
          
          // Only mark the message as processed if we haven't already marked it
          // This is already done for messages that were successfully processed
          
        } catch (error) {
          log(`Error processing queued message ${message.id}: ${error}`, "error");
          // We don't mark as processed so it can be retried
        }
      }
      
    } catch (error) {
      log(`Error in message queue processor: ${error}`, "error");
    } finally {
      this.processingQueue = false;
    }
  }

  async start() {
    if (this.isStarting) {
      log("Bot is already starting, waiting...");
      return;
    }

    this.isStarting = true;

    try {
      log("Starting Telegram bot...");
      this.updateConnectionState('reconnecting');

      // Stop existing bot if any
      if (this.bot) {
        await this.stop();
        await new Promise(resolve => setTimeout(resolve, this.CLEANUP_DELAY));
      }

      this._isConnected = false;
      this.stopHeartbeat();
      this.failedHeartbeats = 0;

      // First, try to delete any existing webhooks to avoid conflicts
      try {
        const tempBot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
        await tempBot.telegram.deleteWebhook({ drop_pending_updates: true });
        log("Successfully cleared any existing webhooks");
        // Important: stop this temporary bot to avoid conflicts
        await tempBot.stop();
        // Add a delay to ensure the connection is fully closed
        await new Promise(resolve => setTimeout(resolve, 5000));
      } catch (webhookError) {
        log(`Error clearing webhooks: ${webhookError}`, "warn");
        // Continue anyway, as this is just a precaution
      }

      // Create new bot instance with a longer polling timeout
      log("Creating new Telegram bot instance");
      this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!, {
        handlerTimeout: 90000, // 90 seconds
      });

      // EXPLICITLY REGISTER COMMANDS WITH TELEGRAM
      try {
        await this.bot.telegram.setMyCommands([
          { command: 'start', description: 'Start a new ticket or see available services' },
          { command: 'close', description: 'Close your current ticket' },
          { command: 'switch', description: 'Switch to a different service' },
          { command: 'help', description: 'Get help with using the bot' }
        ]);
        log("Successfully registered commands with Telegram API", "info");
      } catch (error) {
        log(`Failed to register commands with Telegram API: ${error}`, "error");
      }

      // Add handlers
      await this.setupHandlers();

      // Launch with conflict resolution options
      try {
        // First, try to delete pending updates
        if (this.bot?.telegram) {
          try {
            await this.bot.telegram.deleteWebhook({ drop_pending_updates: true });
          } catch (webhookError) {
            log(`Error deleting webhook: ${webhookError}`, "warn");
          }
        }
        
        // Simply launch the bot, Telegraf handles polling internally
        await this.bot.launch();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        // If there's a conflict error, try more aggressive recovery
        if (errorMessage.includes('409') && errorMessage.includes('Conflict')) {
          log("Detected 409 Conflict error, attempting aggressive recovery", "warn");
          
          try {
            // First, stop the current bot completely
            if (this.bot) {
              await this.bot.stop();
            }
            
            // Wait a longer time for connections to fully close
            await new Promise(resolve => setTimeout(resolve, 15000));
            
            // Create a new bot instance
            this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!, {
              handlerTimeout: 90000,
            });
            
            // Set up handlers again
            await this.setupHandlers();
            
            // First try explicitly deleting webhook
            try {
              await this.bot.telegram.deleteWebhook({ drop_pending_updates: true });
              log("Successfully deleted webhook during recovery", "info");
            } catch (webhookError) {
              log(`Error deleting webhook during recovery: ${webhookError}`, "warn");
            }
            
            // Simply launch the bot after recovery
            await this.bot.launch();
            
            log("Successfully recovered from conflict after aggressive recovery");
          } catch (retryError) {
            const retryMsg = retryError instanceof Error ? retryError.message : String(retryError);
            log(`Failed recovery attempt: ${retryMsg}`, "error");
            throw new Error(`Failed to start after conflict recovery: ${retryMsg}`);
          }
        } else {
          // Rethrow other errors
          throw error;
        }
      }

      const botInfo = await this.bot.telegram.getMe();
      log(`Connected as @${botInfo.username}`);

      this._isConnected = true;
      this.updateConnectionState('connected');
      this.startHeartbeat();
      this.startMessageQueueProcessor();
      this.reconnectAttempts = 0;

      log("Telegram bot started successfully");
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.updateConnectionState('disconnected', errorMsg);
      log(`Error starting Telegram bot: ${error}`, "error");
      this._isConnected = false;
      this.failedHeartbeats = 0;

      // Always fully stop the bot on any error
      if (this.bot) {
        try {
          await this.bot.stop();
        } catch (stopError) {
          log(`Error stopping bot after failure: ${stopError}`, "warn");
        }
      }

      // Add extra delay for 409 conflicts
      if (errorMsg.includes("409: Conflict")) {
        log("409 Conflict detected - another bot instance is running, waiting longer", "error");
        await new Promise(resolve => setTimeout(resolve, this.CLEANUP_DELAY * 3)); // Wait 30 seconds
      }

      throw error;
    } finally {
      this.isStarting = false;
    }
  }

  async stop() {
    try {
      log("Stopping Telegram bot...");
      this.stopHeartbeat();
      this.stopMessageQueueProcessor();
      
      // Stop the rate limit manager's cleanup interval
      this.rateLimitManager.stop();

      if (this.bot) {
        try {
          await this.bot.stop();
        } catch (error) {
          log(`Error during bot stop: ${error}`, "warn");
        } finally {
          this.bot = null;
        }
      }

      this._isConnected = false;
      this.isStarting = false;
      this.userStates.clear();
      this.stateCleanups.clear();
      this.reconnectAttempts = 0;
      this.activeUsers.clear();
      this.failedHeartbeats = 0;

      log("Telegram bot stopped successfully");
    } catch (error) {
      log(`Error stopping Telegram bot: ${error}`, "error");
      throw error;
    }
  }

  getIsConnected(): boolean {
    return this._isConnected && this.bot !== null;
  }
  
  // Public method to check if bot is in the process of starting
  isStartingProcess(): boolean {
    return this.isStarting;
  }
  
  // Public method to get the last error that occurred
  getLastError(): string | undefined {
    return this.connectionState.lastError;
  }

  async sendMessage(chatId: number, text: string) {
    try {
      // Use the telegram getter for null safety
      await this.telegram.sendMessage(chatId, preserveMarkdown(text), {
        parse_mode: "MarkdownV2"
      });
    } catch (error) {
      log(`Error sending message: ${error}`, "error");
      throw error;
    }
  }

  async sendPhoto(chatId: number, photo: Buffer | string, caption?: string): Promise<string | undefined> {
    try {
      log(`Sending photo to chat ${chatId}`);
      let sentMessage;

      // If photo is a URL, download it first
      if (typeof photo === 'string' && photo.startsWith('http')) {
        const response = await fetch(photo);
        const buffer = await response.buffer();
        sentMessage = await this.telegram.sendPhoto(chatId, { source: buffer }, {
          caption: caption ? preserveMarkdown(caption) : undefined,
          parse_mode: "MarkdownV2"
        });
      } else if (photo instanceof Buffer) {
        // Handle buffer by using InputFile format
        sentMessage = await this.telegram.sendPhoto(chatId, { source: photo }, {
          caption: caption ? preserveMarkdown(caption) : undefined,
          parse_mode: "MarkdownV2"
        });
      } else {
        // Handle file_id string
        sentMessage = await this.telegram.sendPhoto(chatId, photo, {
          caption: caption ? preserveMarkdown(caption) : undefined,
          parse_mode: "MarkdownV2"
        });
      }

      // Return the file_id for caching
      if (sentMessage?.photo && sentMessage.photo.length > 0) {
        const fileId = sentMessage.photo[sentMessage.photo.length - 1].file_id;
        log(`Got file_id ${fileId} for photo`);
        return fileId;
      }

      log(`Successfully sent photo to chat ${chatId}`);
      return undefined;
    } catch (error) {
      log(`Error sending photo: ${error}`, "error");
      throw error;
    }
  }

  async sendCachedPhoto(chatId: number, fileId: string, caption?: string): Promise<void> {
    try {
      await this.telegram.sendPhoto(chatId, fileId, {
        caption: caption ? preserveMarkdown(caption) : undefined,
        parse_mode: "MarkdownV2"
      });

      log(`Successfully sent cached photo (${fileId}) to chat ${chatId}`);
    } catch (error) {
      log(`Error sending cached photo: ${error}`, "error");
      throw error;
    }
  }

  private async checkActiveUsers(userId: number): Promise<boolean> {
    // Clean up disconnected users first
    for (const activeId of this.activeUsers) {
      try {
        // Use telegram getter for null safety
        await this.telegram.getChat(activeId);
      } catch (error) {
        this.activeUsers.delete(activeId);
        this.userStates.delete(activeId);
        this.stateCleanups.delete(activeId);
        log(`Removed inactive user ${activeId}`);
      }
    }

    // Check if we can add new user
    if (!this.activeUsers.has(userId)) {
      if (this.activeUsers.size >= this.MAX_CONCURRENT_USERS) {
        return false;
      }
      this.activeUsers.add(userId);
    }
    return true;
  }

  private async handleTicketCommand(ctx: Context, user: any, ticket: any): Promise<boolean> {
    if (!ctx.message || !('text' in ctx.message)) return false;

    const userId = ctx.from?.id;
    if (!userId) return false;

    // Check if this is actually a command
    const messageText = ctx.message.text || "";
    if (!messageText.startsWith('/')) return false;

    const commandParts = messageText.split(' ')[0].split('@');
    const command = commandParts[0].substring(1); // Remove the leading '/'
    
    // Enhanced logging for command detection
    log(`[COMMAND DEBUG] Detected command in text message: /${command} from user ${userId} for ticket ${ticket.id}`, "info");
    
    // List of supported commands that should be properly handled
    const supportedCommands = ['close', 'start', 'switch', 'ban', 'unban', 'paid', 'reopen', 'ping'];
    
    // Set a flag on the message context to prevent it from being forwarded to Discord later
    (ctx.message as any)._isCommand = true;
    
    // See if this is a recognized command
    const isRecognizedCommand = supportedCommands.includes(command);
    log(`[COMMAND DEBUG] Command /${command} is ${isRecognizedCommand ? 'recognized' : 'not recognized'}`, "info");
    
    if (isRecognizedCommand) {
      log(`[COMMAND DEBUG] Processing command /${command} for ticket ${ticket.id}`, "info");
      
      try {
        // CLOSE COMMAND
        if (command === 'close') {
          log(`[COMMAND DEBUG] Executing CLOSE command for ticket ${ticket.id}`, "info");
          
          // Use our dedicated handler for maximum reliability
          await handleCloseCommand(userId, ctx, this.bridge);
          return true;
        }
        // PING COMMAND
        else if (command === 'ping') {
          log(`[COMMAND DEBUG] Executing PING command for ticket ${ticket.id}`, "info");
          
          // Get user's display name
          if (!ctx.from) return false;
          const displayName = [ctx.from.first_name, ctx.from.last_name]
            .filter(Boolean)
            .join(' ') || ctx.from.username || "Telegram User";
          
          try {
            await this.bridge.forwardPingToDiscord(ticket.id, displayName);
            log(`[COMMAND DEBUG] Successfully sent ping to Discord for ticket ${ticket.id}`, "info");
            await ctx.reply("✅ Staff has been successfully notified.");
          } catch (error) {
            log(`[COMMAND DEBUG] Error sending ping: ${error}`, "error");
            await ctx.reply("❌ Failed to send ping. Please try again.");
          }
          return true;
        }
        // SWITCH COMMAND
        else if (command === 'switch') {
          log(`[COMMAND DEBUG] Executing SWITCH command for ticket ${ticket.id}`, "info");
          
          try {
            await this.handleCategoryMenu(ctx);
            log(`[COMMAND DEBUG] Successfully displayed category menu for SWITCH command`, "info");
          } catch (error) {
            log(`[COMMAND DEBUG] Error displaying category menu for SWITCH: ${error}`, "error");
            await ctx.reply("❌ Failed to display categories. Please try again.");
          }
          return true;
        }
        // OTHER COMMANDS - handle directly by top-level command handlers
        else {
          // Let the original command handler take care of it
          log(`[COMMAND DEBUG] Delegating command ${command} to top-level handler`, "info");
          return false;
        }
      } catch (error) {
        log(`[COMMAND DEBUG] Unhandled error processing command ${command}: ${error}`, "error");
        await ctx.reply(`There was an error processing the /${command} command. Please try again.`);
        return true;
      }
    } else {
      log(`[COMMAND DEBUG] Unrecognized command /${command}, letting it forward as normal message`, "info");
      return false; // Not a known command, let the message processing continue
    }
  }

  private async handleTicketMessage(ctx: Context, user: any, ticket: any) {
    if (!ctx.message || !('text' in ctx.message)) return;

    const userId = ctx.from?.id;
    if (!userId) return;

    // DIRECT COMMAND HANDLING APPROACH
    // If the message is a command, handle it directly without using complex handlers
    const messageText = ctx.message.text || "";
    if (messageText.startsWith('/')) {
      // Extract the command (e.g., '/close' -> 'close')
      const commandParts = messageText.split(' ')[0].split('@');
      const command = commandParts[0].substring(1); // Remove the leading '/'
      
      // Mark as command to prevent forwarding to Discord
      (ctx.message as any)._isCommand = true;
      
      log(`[DIRECT COMMAND] Processing command /${command} in ticket ${ticket.id}`, "info");
      
      // Handle specific commands directly
      if (command === 'close') {
        log(`[DIRECT COMMAND] Processing /close for ticket ${ticket.id}`, "info");
        
        // Use our dedicated handler for maximum reliability
        await handleCloseCommand(userId, ctx, this.bridge);
        return;
      }
      else if (command === 'switch') {
        log(`[DIRECT COMMAND] Processing /switch for ticket ${ticket.id}`, "info");
        try {
          await this.handleCategoryMenu(ctx);
        } catch (error) {
          log(`[DIRECT COMMAND] Error displaying category menu: ${error}`, "error");
          await ctx.reply("❌ Failed to display categories. Please try again.");
        }
        return;
      }
      else if (command === 'ping') {
        log(`[DIRECT COMMAND] Processing /ping for ticket ${ticket.id}`, "info");
        if (!ctx.from) return;
        
        try {
          const displayName = [ctx.from.first_name, ctx.from.last_name]
            .filter(Boolean)
            .join(' ') || ctx.from.username || "Telegram User";
            
          await this.bridge.forwardPingToDiscord(ticket.id, displayName);
          await ctx.reply("✅ Staff has been notified.");
        } catch (error) {
          log(`[DIRECT COMMAND] Error sending ping: ${error}`, "error");
          await ctx.reply("❌ Failed to send ping. Please try again.");
        }
        return;
      }
      
      // For other commands, suggest using the command directly
      log(`[DIRECT COMMAND] Unsupported command /${command} in ticket, showing help`, "info");
      await ctx.reply(`Please use the /${command} command outside of a ticket conversation.`);
      return;
    }
    
    // Original approach as fallback
    // First, check if this is a command and process it separately
    const isCommand = await this.handleTicketCommand(ctx, user, ticket);
    if (isCommand) {
      log(`Command was fully handled by handleTicketCommand`, "info");
      return; // Command was handled, nothing more to do
    }

    // Rate limit is already checked in the caller (text handler), we don't need to check again
    log(`Processing ticket message from user ${userId} for ticket ${ticket.id} with status ${ticket.status}`);

    try {
      // Get an updated version of the ticket directly from the database
      // This is critical as the ticket status may have changed since the user state was created
      const currentTicket = await storage.getTicket(ticket.id);
      
      // Log the current state of the ticket for debugging
      log(`Retrieved ticket ${ticket.id} from database: ${JSON.stringify(currentTicket)}`, "debug");
      
      // Comprehensive ticket validation
      if (!currentTicket) {
        log(`Ticket ${ticket.id} not found in database`, "error");
        await ctx.reply("❌ This ticket is no longer available. Use /start to create a new ticket.");
        return;
      }
      
      // Verify the ticket belongs to the current user for security
      if (currentTicket.userId !== user.id) {
        log(`Ticket ${ticket.id} belongs to user ${currentTicket.userId}, not current user ${user.id}`, "error");
        await ctx.reply("❌ This ticket doesn't belong to you. Use /start to create your own ticket.");
        return;
      }
      
      // Check if the ticket is in a valid state for receiving messages
      const invalidStates = ['closed', 'completed', 'transcript'];
      if (invalidStates.includes(currentTicket.status)) {
        log(`Ticket ${ticket.id} is in ${currentTicket.status} status, cannot accept new messages`, "warn");
        await ctx.reply("❌ This ticket is no longer active. Use /start to create a new ticket.");
        return;
      }
      
      log(`Verified ticket ${ticket.id} is active with status: ${currentTicket.status}`);
      
      // Skip storing if this is a command (we don't want commands in the transcript)
      if (!(ctx.message as any)._isCommand) {
        // Store the message in the database first for all ticket states
        await storage.createMessage({
          ticketId: ticket.id,
          content: ctx.message.text,
          authorId: user.id,
          platform: "telegram",
          timestamp: new Date()
        });
      } else {
        log(`Skipping database storage for command message: ${ctx.message.text}`, "info");
      }
      
      // If it's a pending ticket, don't forward to Discord yet
      if (currentTicket.status === 'pending') {
        // We've already stored the message in the database, so just acknowledge receipt
        await ctx.reply("✓ Message received. It will be forwarded when your ticket is processed.");
        return;
      }
      
      // Check if the ticket has a Discord channel
      if (!currentTicket.discordChannelId) {
        await ctx.reply("⚠️ Your ticket is active but not yet connected to Discord. The staff will see your message when they create a channel.");
        return;
      }

      // Get user profile picture for avatar
      let avatarUrl: string | undefined;
      try {
        if (ctx.from?.id) {
          const photos = await this.telegram.getUserProfilePhotos(ctx.from.id, 0, 1);
          if (photos && photos.total_count > 0) {
            const fileId = photos.photos[0][0].file_id;
            const file = await this.telegram.getFile(fileId);
            if (file?.file_path) {
              avatarUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
            }
          }
        }
      } catch (error) {
        log(`Error getting Telegram user avatar: ${error}`, "error");
      }

      // Get user's first and last name
      const firstName = ctx.from?.first_name || "";
      const lastName = ctx.from?.last_name || "";
      const displayName = [firstName, lastName].filter(Boolean).join(' ') || "Telegram User";

      // TRIPLE CHECK to skip forwarding if this is a command
      // 1. Check for the _isCommand flag
      // 2. Check for _commandHandled flag
      // 3. Direct text check for commands
      const messageIsCommand = 
        (ctx.message as any)._isCommand || 
        (ctx.message as any)._commandHandled || 
        (ctx.message.text && ctx.message.text.trim().startsWith('/'));
      
      if (!messageIsCommand) {
        try {
          log(`Forwarding message to Discord - Ticket: ${JSON.stringify(currentTicket)}`, "info");
          
          // Generate a deduplication key
          const dedupKey = `dc:${ticket.id}:${require('crypto').createHash('md5').update(ctx.message.text).digest('hex').slice(0, 8)}:${ctx.message.text.slice(0, 20)}:text:${displayName}`;
          log(`[DEDUP] Generated key for Discord: ${dedupKey}`, "debug");
          
          await this.bridge.forwardToDiscord(
            ctx.message.text,
            ticket.id,
            displayName,
            avatarUrl,
            undefined,
            firstName,
            lastName
          );
          log(`Message processed successfully for ticket ${ticket.id}`);
        } catch (error) {
          log(`Error forwarding message to Discord: ${error}`, "error");
          await ctx.reply("⚠️ Your message was saved but could not be forwarded to Discord staff. They will still see it in the chat history.");
        }
      } else {
        log(`Skipping Discord forwarding for command message: ${ctx.message.text}`, "info");
      }
    } catch (error) {
      log(`Error in handleTicketMessage: ${error}`, "error");
      await ctx.reply("Sorry, there was an error processing your message. Please try again.");
    }
  }

  private async handleCategoryMenu(ctx: Context) {
    try {
      const botConfig = await storage.getBotConfig();
      const categories = await storage.getCategories();

      const submenus = categories.filter(cat => cat.isSubmenu);
      const rootCategories = categories.filter(cat => !cat.parentId && !cat.isSubmenu);

      const keyboard: { text: string; callback_data: string; }[][] = [];
      let currentRow: { text: string; callback_data: string; }[] = [];

      for (const submenu of submenus) {
        const button = {
          text: submenu.isClosed ? `🔴 ${submenu.name}` : submenu.name,
          callback_data: `submenu_${submenu.id}`
        };

        if (submenu.newRow && currentRow.length > 0) {
          keyboard.push([...currentRow]);
          currentRow = [button];
        } else {
          currentRow.push(button);
          if (currentRow.length >= 2) {
            keyboard.push([...currentRow]);
            currentRow = [];
          }
        }
      }

      for (const category of rootCategories) {
        const button = {
          text: category.isClosed ? `🔴 ${category.name}` : category.name,
          callback_data: `category_${category.id}`
        };

        if (category.newRow && currentRow.length > 0) {
          keyboard.push([...currentRow]);
          currentRow = [button];
        } else {
          currentRow.push(button);
          if (currentRow.length >= 2) {
            keyboard.push([...currentRow]);
            currentRow = [];
          }
        }
      }

      if (currentRow.length > 0) {
        keyboard.push(currentRow);
      }

      // Use our new preserveMarkdown function to keep markdown formatting while escaping special chars
      const welcomeMessage = preserveMarkdown(botConfig?.welcomeMessage || "Welcome to the support bot! Please select a service:");

      // Check if we have a welcome image to send
      if (botConfig?.welcomeImageUrl) {
        log(`Found welcome image URL: ${botConfig.welcomeImageUrl}`, "info");
        try {
          // Try to send the photo with caption and inline keyboard
          await ctx.replyWithPhoto(
            botConfig.welcomeImageUrl,
            {
              caption: welcomeMessage,
              parse_mode: "MarkdownV2",
              reply_markup: { inline_keyboard: keyboard }
            }
          );
          log("Successfully sent welcome image with categories", "info");
          
          // If we successfully sent the photo, we're done
          if (ctx.callbackQuery) {
            await ctx.answerCbQuery();
          }
          return;
        } catch (error) {
          // If sending the image fails, log the error and fall back to text-only
          log(`Error sending welcome image: ${error}`, "error");
          // Continue with text-only approach below
        }
      }

      try {
        // Try to edit existing message if this was triggered by a callback
        if (ctx.callbackQuery) {
          try {
            await ctx.editMessageText(welcomeMessage, {
              parse_mode: "MarkdownV2",
              reply_markup: { inline_keyboard: keyboard }
            });
          } catch (error) {
            // If we can't edit the message (e.g., too old or not sent by bot), send a new one
            log(`Error editing welcome message: ${error}`, "warn");
            await ctx.reply(welcomeMessage, {
              parse_mode: "MarkdownV2",
              reply_markup: { inline_keyboard: keyboard }
            });
          }
        } else {
          // Otherwise send a new message
          await ctx.reply(welcomeMessage, {
            parse_mode: "MarkdownV2",
            reply_markup: { inline_keyboard: keyboard }
          });
        }
      } catch (error: any) {
        // If editing fails, send a new message
        if (error?.message?.includes("message can't be edited")) {
          await ctx.reply(welcomeMessage, {
            parse_mode: "MarkdownV2",
            reply_markup: { inline_keyboard: keyboard }
          });
        } else {
          throw error; // Re-throw other errors
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log(`Error in handleCategoryMenu: ${errorMsg}`, "error");
      await ctx.reply("❌ There was an error displaying the menu. Please try again.");
    }

    if (ctx.callbackQuery) {
      await ctx.answerCbQuery();
    }
  }

  private async handleCategorySelection(ctx: Context, categoryId: number) {
    try {
      const userId = ctx.from?.id;
      if (!userId) return;

      if (!this.checkRateLimit(userId, 'command', 'category')) {
        await ctx.reply("⚠️ Please wait before selecting another category.");
        return;
      }

      const category = await storage.getCategory(categoryId);
      if (!category) {
        await ctx.reply("❌ Category not found.");
        return;
      }

      // Display service image and summary if available
      if (category.serviceImageUrl) {
        try {
          await ctx.replyWithPhoto(
            category.serviceImageUrl,
            {
              caption: category.serviceSummary ? preserveMarkdown(category.serviceSummary) : undefined,
              parse_mode: "MarkdownV2"
            }
          );
        } catch (error) {
          log(`Error sending service image: ${error}`, "error");
          // If image fails, still show the summary as text
          if (category.serviceSummary) {
            await ctx.reply(preserveMarkdown(category.serviceSummary), {
              parse_mode: "MarkdownV2"
            });
          }
        }
      } else if (category.serviceSummary) {
        // If no image but has summary, show summary as text
        await ctx.reply(preserveMarkdown(category.serviceSummary), {
          parse_mode: "MarkdownV2"
        });
      }

      // Get the questions for this category
      const questions = category.questions || [];
      if (questions.length === 0) {
        await ctx.reply("❌ No questions configured for this category.");
        return;
      }

      // Initialize questionnaire state
      const state: UserState = {
        categoryId,
        currentQuestion: 0,
        answers: [],
        inQuestionnaire: true,
        activeTicketId: undefined
      };
      this.setState(userId, state);

      // Ask first question
      await ctx.reply(preserveMarkdown(questions[0]), {
        parse_mode: "MarkdownV2"
      });

    } catch (error) {
      log(`Error in handleCategorySelection: ${error}`, "error");
      await ctx.reply("❌ There was an error processing your selection. Please try again.");
    }
  }

  private async handleSubmenuClick(ctx: Context, submenuId: number) {
    try {
      const submenu = await storage.getCategory(submenuId);
      if (!submenu) {
        await ctx.reply("❌ Submenu not found.");
        return;
      }

      const categories = await storage.getCategories();
      const submenuCategories = categories.filter(cat => cat.parentId === submenuId);

      const keyboard: { text: string; callback_data: string; }[][] = [];
      let currentRow: { text: string; callback_data: string; }[] = [];

      for (const category of submenuCategories) {
        const button = {
          text: category.isClosed ? `🔴 ${category.name}` : category.name,
          callback_data: `category_${category.id}`
        };

        if (category.newRow && currentRow.length > 0) {
          keyboard.push([...currentRow]);
          currentRow = [button];
        } else {
          currentRow.push(button);
          if (currentRow.length >= 2) {
            keyboard.push([...currentRow]);
            currentRow = [];
          }
        }
      }

      if (currentRow.length > 0) {
        keyboard.push(currentRow);
      }

      // Add a "Back" button
      keyboard.push([{
        text: "↩️ Back",
        callback_data: "back_to_main"
      }]);

      const message = `Please select a service from ${submenu.name}:`;

      try {
        await ctx.editMessageText(preserveMarkdown(message), {
          parse_mode: "MarkdownV2",
          reply_markup: { inline_keyboard: keyboard }
        });
      } catch (error) {
        // If editing fails, send a new message
        if (error instanceof Error && error.message?.includes("message can't be edited")) {
          await ctx.reply(preserveMarkdown(message), {
            parse_mode: "MarkdownV2",
            reply_markup: { inline_keyboard: keyboard }
          });
        } else {
          throw error; // Re-throw other errors
        }
      }

      log(`Successfully displayed submenu options for submenu ${submenuId}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log(`Error in handleSubmenuClick: ${errorMsg}`, "error");
      await ctx.reply("❌ There was an error displaying the menu. Please try again.");
    }
  }

  private setupHandlers() {
    if (!this.bot) return;
    
    // RAW UPDATE HANDLER 
    // This runs at the lowest level possible to capture ALL updates including commands
    // This runs before any command handler or middleware
    this.bot.use(async (ctx, next) => {
      if (ctx.update?.message) {
        console.log("[RAW UPDATE] Processing update ID:", ctx.update.update_id);
        
        try {
          // If this is a message with text, check for critical commands
          if (ctx.update.message.text) {
            const text = ctx.update.message.text.trim();
            console.log(`[RAW UPDATE] Received message: "${text}"`);
            
            // Check if this is a direct /close command
            if (text.toLowerCase() === '/close' || text.toLowerCase().startsWith('/close ')) {
              const userId = ctx.from?.id;
              if (userId) {
                console.log(`[RAW UPDATE] /close command detected from user ${userId}`);
                
                // Try to handle it with the direct processor first
                try {
                  console.log("[RAW UPDATE] Calling directCloseTicket...");
                  await directCloseTicket(userId, ctx, this.bridge);
                  console.log("[RAW UPDATE] directCloseTicket executed");
                  
                  // Mark the message as handled to prevent it from being processed again
                  (ctx.update.message as any)._commandHandled = true;
                  
                  // We still continue to next middleware to allow other handlers to run if needed
                } catch (error) {
                  console.error("[RAW UPDATE] Error in direct close ticket:", error);
                }
              }
            }
          }
        } catch (error) {
          console.error("[RAW UPDATE] Error processing raw update:", error);
        }
      }
      
      // Always continue to next middleware
      return next();
    });
    
    // SPECIAL DIRECT HANDLING FOR CLOSE COMMAND
    // This is a special handler added at the top level to ensure it always works
    // Using on('text') with manual detection for maximum compatibility
    this.bot.on('text', async (ctx) => {
      // Extract the message text
      const text = ctx.message?.text;
      if (!text) return;
      
      // Check if this is a /close command
      const normalizedText = text.trim().toLowerCase();
      if (normalizedText === '/close' || normalizedText.startsWith('/close ')) {
        const userId = ctx.from?.id;
        if (!userId) return;
        
        // Skip if already handled by the raw update handler
        if ((ctx.message as any)._commandHandled) {
          console.log(`[SUPER DIRECT] Skipping already handled /close command from user ${userId}`);
          return;
        }
        
        console.log(`[SUPER DIRECT] TEXT HANDLER CAUGHT /close FROM USER ${userId}`);
        log(`[SUPER DIRECT] /close command received from user ${userId}`, "info");
        
        // Mark this message as processed to prevent Discord forwarding
        (ctx.message as any)._isCommand = true;
        
        // Use our dedicated handler for maximum reliability
        await handleCloseCommand(userId, ctx, this.bridge);
        
        // Return immediately to prevent other handlers
        return;
      }
    });
    
    this.bot.command("ping", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      if (!this.checkRateLimit(userId, 'command', 'ping')) {
        await ctx.reply("⚠️ Please wait before using this command again.");
        return;
      }

      try {
        // Check for active ticket first
        const user = await storage.getUserByTelegramId(userId.toString());
        if (!user) {
          await ctx.reply("You haven't created any tickets yet.");
          return;
        }

        const activeTicket = await storage.getActiveTicketByUserId(user.id);
        if (!activeTicket) {
          await ctx.reply("You don't have any active tickets to ping.");
          return;
        }

        // Get user's display name
        if (!ctx.from) return;
        const displayName = [ctx.from.first_name, ctx.from.last_name]
          .filter(Boolean)
          .join(' ') || ctx.from.username || "Telegram User";

        try {
          await this.bridge.forwardPingToDiscord(activeTicket.id, displayName);
          await ctx.reply("✅ Staff has been successfully notified.");
        } catch (error) {
          log(`Error sending ping: ${error}`, "error");
          await ctx.reply("❌ Failed to send ping. Please try again.");
        }
      } catch (error) {
        log(`Error in ping command: ${error}`, "error");
        await ctx.reply("❌ There was an error processing your request. Please try again.");
      }
    });

    this.bot.command("start", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      if (!this.checkRateLimit(userId, 'command', 'start')) {
        await ctx.reply("⚠️ Please wait before using this command again.");
        return;
      }
      
      try {
        // Check if user is banned
        let user = await storage.getUserByTelegramId(userId.toString());
        if (user?.isBanned) {
          const banReason = user.banReason || "No reason provided";
          await ctx.reply(`⛔ You are banned from using this bot.\nReason: ${banReason}`);
          return;
        }
        
        // Check for existing active ticket first
        if (user) {
          const activeTicket = await storage.getActiveTicketByUserId(user.id);
          if (activeTicket) {
            // Use a non-null assertion or provide a fallback for categoryId
            const categoryId = activeTicket.categoryId ?? 0;
            const category = await storage.getCategory(categoryId);
            const categoryName = category?.name || "Unknown";
            // Create a completely escaped message
            const message = `You already have an active ticket in the "${categoryName}" category.

You cannot create a new ticket while you have an active one.
Please use /close to close your current ticket first, or continue chatting here to update your existing ticket.`;
            
            await ctx.reply(
              `❌ ${preserveMarkdown(message)}`,
              { parse_mode: "MarkdownV2" }
            );
            return;
          }
        }

        const state = this.userStates.get(userId);
        if (state?.inQuestionnaire) {
          await ctx.reply(
            "❌ You are currently answering questions for a ticket.\nUse /cancel to cancel the current process first."
          );
          return;
        }

        await this.handleCategoryMenu(ctx);
      } catch (error) {
        log(`Error in start command: ${error}`, "error");
        await ctx.reply("❌ There was an error processing your request. Please try again in a moment.");
      }
    });

    this.bot.command("cancel", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      try {
        // Clear questionnaire state if exists
        const state = this.userStates.get(userId);
        if (state?.inQuestionnaire) {
          this.userStates.delete(userId);
          this.stateCleanups.delete(userId);
          this.activeUsers.delete(userId);
        }

        // Force close any active ticket
        const user = await storage.getUserByTelegramId(userId.toString());
        if (user) {
          const activeTicket = await storage.getActiveTicketByUserId(user.id);
          if (activeTicket) {
            // Force close the ticket regardless of transcript category
            await storage.updateTicketStatus(activeTicket.id, "closed");

            // Try to move to transcripts if possible, but don't block on failure
            if (activeTicket.discordChannelId) {
              try {
                await this.bridge.moveToTranscripts(activeTicket.id);
              } catch (error) {
                log(`Failed to move ticket ${activeTicket.id} to transcripts during force cancel: ${error}`, "warn");
              }
            }
          }
        }

        await ctx.reply("✅ All operations cancelled. Use /start when you're ready to begin again.");
      } catch (error) {
        log(`Error in cancel command: ${error}`, "error");
        // Even if there's an error, try to clear states
        this.userStates.delete(userId);
        this.stateCleanups.delete(userId);
        this.activeUsers.delete(userId);
        await ctx.reply("✅ Reset completed. Use /start to begin again.");
      }
    });

    this.bot.on("callback_query", async (ctx) => {
      // Ensure callbackQuery exists
      if (!ctx.callbackQuery) return;

      // Use type assertion for callbackQuery since the data property isn't correctly typed
      const callbackData = (ctx.callbackQuery as any).data;
      if (!callbackData) return;

      if (callbackData.startsWith("submenu_")) {
        const submenuId = parseInt(callbackData.split("_")[1]);
        await this.handleSubmenuClick(ctx, submenuId);
        return;
      }

      // Handle back to menu button
      if (callbackData === "back_to_main") {
        await this.handleCategoryMenu(ctx);
        return;
      }
      
      // Handle create new ticket from switch command
      if (callbackData === "create_new_ticket") {
        await ctx.answerCbQuery("Creating a new ticket...");
        await this.handleCategoryMenu(ctx);
        return;
      }
      
      // Handle switch to existing ticket
      if (callbackData.startsWith("switch_to_")) {
        const ticketId = parseInt(callbackData.split("_")[2]);
        try {
          const ticket = await storage.getTicket(ticketId);
          
          if (!ticket || ticket.status === 'closed' || ticket.status === 'deleted') {
            await ctx.answerCbQuery("This ticket is no longer available");
            return;
          }
          
          const categoryId = ticket.categoryId ?? 0;
          const category = await storage.getCategory(categoryId);
          const categoryName = category ? category.name : "Unknown category";
          
          // Hide the inline keyboard
          await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
          
          // Send confirmation message
          await ctx.reply(`✅ Switched to ticket #${ticket.id} (${categoryName})\n\nYou can now continue chatting here. Type your message to communicate with our staff.`);
          
          await ctx.answerCbQuery();
        } catch (error) {
          log(`Error switching to ticket: ${error}`, "error");
          await ctx.answerCbQuery("Failed to switch tickets. Please try again.");
        }
        return;
      }

      if (!callbackData.startsWith("category_")) return;

      const categoryId = parseInt(callbackData.split("_")[1]);
      await this.handleCategorySelection(ctx, categoryId);
      await ctx.answerCbQuery();
    });

    this.bot.command("status", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      const user = await storage.getUserByTelegramId(userId.toString());
      if (!user) {
        await ctx.reply("You haven't created any tickets yet.");
        return;
      }

      const activeTicket = await storage.getActiveTicketByUserId(user.id);
      if (!activeTicket) {
        await ctx.reply("You don't have any active tickets.");
        return;
      }

      const categoryId = activeTicket.categoryId ?? 0;
      const category = await storage.getCategory(categoryId);
      
      // Using preserveMarkdown for proper Markdown formatting
      const categoryName = category?.name || "Unknown";
      const statusText = activeTicket.status;
      
      const message = `Your active ticket #${activeTicket.id}:

Category: ${categoryName}
Status: ${statusText}
ID: ${activeTicket.id}`;
      
      await ctx.reply(preserveMarkdown(message), { parse_mode: "MarkdownV2" });
    });

    this.bot.command("switch", async (ctx) => {
      // COMPLETELY REWRITTEN IMPLEMENTATION
      log("===== SWITCH COMMAND HANDLER =====", "info");
      
      try {
        const userId = ctx.from?.id;
        if (!userId) {
          log("[SWITCH] No user ID in command", "error");
          return;
        }
        
        log(`[SWITCH] Command received from user: ${userId}`, "info");
        
        if (!this.checkRateLimit(userId, 'command', 'switch')) {
          await ctx.reply("⚠️ Please wait before using this command again.");
          return;
        }
        
        const user = await storage.getUserByTelegramId(userId.toString());
        if (!user) {
          await ctx.reply("You haven't created any tickets yet.");
          return;
        }

        // Get all tickets for this user
        const userTickets = await storage.getTicketsByUserId(user.id);
        const activeTickets = userTickets.filter(ticket => 
          ticket.status !== 'closed' && ticket.status !== 'deleted'
        );

        if (activeTickets.length === 0) {
          // No active tickets - just start new one
          await ctx.reply("You don't have any active tickets. Starting a new ticket...");
          await this.handleCategoryMenu(ctx);
          return;
        }

        // Create inline keyboard with active tickets and an option to create a new one
        const inlineKeyboard = [];
        
        // Add buttons for each active ticket
        for (const ticket of activeTickets) {
          const categoryId = ticket.categoryId ?? 0;
          const category = await storage.getCategory(categoryId);
          const categoryName = category ? category.name : "Unknown category";
          
          inlineKeyboard.push([{
            text: `📝 Ticket #${ticket.id} (${categoryName})`,
            callback_data: `switch_to_${ticket.id}`
          }]);
        }
        
        // Add button to create a new ticket
        inlineKeyboard.push([{
          text: "➕ Create New Ticket",
          callback_data: "create_new_ticket"
        }]);

        await ctx.reply(
          "Your active tickets:",
          {
            reply_markup: {
              inline_keyboard: inlineKeyboard
            }
          }
        );
      } catch (error) {
        log(`Error in switch command: ${error}`, "error");
        await ctx.reply("❌ There was an error processing your request. Please try again.");
      }
    });

    this.bot.command("ban", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;
      
      if (!this.checkRateLimit(userId, 'command', 'ban')) {
        await ctx.reply("⚠️ Please wait before using this command again.");
        return;
      }
      
      // Check if user is an admin
      const isAdmin = await storage.isAdmin(userId.toString());
      if (!isAdmin) {
        await ctx.reply("❌ You don't have permission to use this command.");
        return;
      }
      
      // Get command arguments: /ban [telegramId|ticketId|username] [reason]
      const message = ctx.message?.text || "";
      const args = message.split(" ");
      args.shift(); // Remove the command itself
      
      if (args.length < 1) {
        await ctx.reply("❌ Invalid command format. Use /ban [telegramId|ticketId|username] [reason]");
        return;
      }
      
      const target = args[0];
      const reason = args.slice(1).join(" ") || "No reason provided";
      if (!ctx.from) return;
      const adminName = ctx.from.username || 
        [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || 
        "Admin";
      
      try {
        // Check if target is a ticket ID
        if (/^\d+$/.test(target) && !target.startsWith("@")) {
          const ticketId = parseInt(target);
          const ticket = await storage.getTicket(ticketId);
          
          if (!ticket) {
            await ctx.reply(`❌ Ticket with ID ${ticketId} not found.`);
            return;
          }
          
          const targetUser = await storage.getUser(ticket.userId || 0);
          if (!targetUser) {
            await ctx.reply(`❌ User associated with ticket ${ticketId} not found.`);
            return;
          }
          
          // Ban user
          await storage.banUser(targetUser.id, reason, adminName);
          
          await ctx.reply(`✅ User ${targetUser.username} has been banned for: ${reason}.`);
          
          // Notify user on Discord if channel exists
          if (ticket.discordChannelId) {
            await this.bridge.forwardToDiscord(
              `⛔ **BANNED**: This user has been banned by ${adminName} for: ${reason}`,
              ticket.id,
              "SYSTEM",
            );
          }
          
          // Close ticket if active
          if (ticket.status !== "closed" && ticket.status !== "deleted") {
            await storage.updateTicketStatus(ticket.id, "closed");
            
            if (ticket.discordChannelId) {
              try {
                await this.bridge.moveToTranscripts(ticket.id);
              } catch (error) {
                console.error("Error moving banned user's ticket to transcripts:", error);
              }
            }
          }
          
          // Send direct message to user if possible
          try {
            const telegramId = targetUser?.telegramId;
            if (telegramId && typeof telegramId === 'string') {
              await this.bot.telegram.sendMessage(
                telegramId,
                `⛔ You have been banned from using this bot for: ${reason}.`
              );
            }
          } catch (error) {
            console.error("Error sending ban notification to user:", error);
          }
        } else if (target.startsWith("@") || /^[a-zA-Z0-9_.]+$/.test(target)) {
          // Try to find user by username or telegram ID
          const identifier = target.startsWith("@") ? target.substring(1) : target;
          
          // First try to find by username
          let targetUser = await storage.getUserByUsername(identifier);
          
          // If not found by username, try as telegram ID
          if (!targetUser) {
            targetUser = await storage.getUserByTelegramId(identifier);
          }
          
          if (!targetUser) {
            await ctx.reply(`❌ User with username or Telegram ID "${identifier}" not found.`);
            return;
          }
          
          // Ban user
          await storage.banUser(targetUser.id, reason, adminName);
          
          await ctx.reply(`✅ User ${targetUser.username} has been banned for: ${reason}.`);
          
          // Get active ticket if any
          const activeTicket = await storage.getActiveTicketByUserId(targetUser.id);
          if (activeTicket) {
            // Notify on Discord if channel exists
            if (activeTicket.discordChannelId) {
              await this.bridge.forwardToDiscord(
                `⛔ **BANNED**: This user has been banned by ${adminName} for: ${reason}`,
                activeTicket.id,
                "SYSTEM",
              );
            }
            
            // Close ticket
            await storage.updateTicketStatus(activeTicket.id, "closed");
            
            if (activeTicket.discordChannelId) {
              try {
                await this.bridge.moveToTranscripts(activeTicket.id);
              } catch (error) {
                console.error("Error moving banned user's ticket to transcripts:", error);
              }
            }
          }
          
          // Send direct message to user if possible
          try {
            const telegramId = targetUser?.telegramId;
            if (telegramId && typeof telegramId === 'string') {
              await this.bot.telegram.sendMessage(
                telegramId,
                `⛔ You have been banned from using this bot for: ${reason}.`
              );
            }
          } catch (error) {
            console.error("Error sending ban notification to user:", error);
          }
        } else {
          await ctx.reply("❌ Invalid format. Please provide a valid ticket ID, username, or Telegram ID.");
          return;
        }
      } catch (error) {
        console.error("Error banning user:", error);
        await ctx.reply("❌ An error occurred while trying to ban the user. Please try again.");
      }
    });
    
    this.bot.command("ping", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;
      
      if (!this.checkRateLimit(userId, 'command', 'ping')) {
        await ctx.reply("⚠️ Please wait before using this command again.");
        return;
      }
      
      try {
        const startTime = Date.now();
        await ctx.reply("🏓 Checking bot response time...");
        const endTime = Date.now();
        const responseTime = endTime - startTime;
        
        await ctx.reply(`✅ Pong! Bot is online.\nResponse time: ${responseTime}ms`);
      } catch (error) {
        log(`Error in ping command: ${error}`, "error");
        await ctx.reply("❌ Error checking bot status.");
      }
    });
    
    // Register status command to check ticket status
    this.bot.command("status", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;
      
      if (!this.checkRateLimit(userId, 'command', 'status')) {
        await ctx.reply("⚠️ Please wait before using this command again.");
        return;
      }
      
      try {
        const user = await storage.getUserByTelegramId(userId.toString());
        if (!user) {
          await ctx.reply("❌ You don't have any tickets. Use /start to create one.");
          return;
        }

        // Get all non-closed tickets
        const ticket = await storage.getNonClosedTicketByUserId(user.id);
        if (!ticket) {
          await ctx.reply("❌ You don't have any active tickets. Use /start to create one.");
          return;
        }

        // Show appropriate message based on ticket status
        let statusMessage = "";
        switch (ticket.status) {
          case "pending":
            statusMessage = "⏳ Your ticket is in pending state. We'll process it as soon as a channel becomes available.";
            break;
          case "open":
            statusMessage = "✅ Your ticket is open. A staff member will assist you soon.";
            break;
          case "in-progress":
            statusMessage = "👨‍💻 Your ticket is being worked on by a staff member.";
            break;
          default:
            statusMessage = `Your ticket status is: ${ticket.status}`;
        }

        await ctx.reply(`Ticket #${ticket.id} Status:\n${statusMessage}`);
      } catch (error) {
        log(`Error in status command: ${error}`, "error");
        await ctx.reply("❌ There was an error checking your ticket status.");
      }
    });
    
    this.bot.command("unban", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;
      
      if (!this.checkRateLimit(userId, 'command', 'unban')) {
        await ctx.reply("⚠️ Please wait before using this command again.");
        return;
      }
      
      // Check if user is an admin
      const isAdmin = await storage.isAdmin(userId.toString());
      if (!isAdmin) {
        await ctx.reply("❌ You don't have permission to use this command.");
        return;
      }
      
      // Get command arguments: /unban [telegramId|userId|username]
      const message = ctx.message?.text || "";
      const args = message.split(" ");
      args.shift(); // Remove the command itself
      
      if (args.length < 1) {
        await ctx.reply("❌ Invalid command format. Use /unban [telegramId|userId|username]");
        return;
      }
      
      const target = args[0];
      if (!ctx.from) return;
      const adminName = ctx.from.username || 
        [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || 
        "Admin";
      
      try {
        // Check if target is a user ID
        if (/^\d+$/.test(target) && !target.startsWith("@")) {
          const userId = parseInt(target);
          const targetUser = await storage.getUser(userId);
          
          if (!targetUser) {
            await ctx.reply(`❌ User with ID ${userId} not found.`);
            return;
          }
          
          if (!targetUser.isBanned) {
            await ctx.reply(`User ${targetUser.username} is not banned.`);
            return;
          }
          
          // Unban user
          await storage.unbanUser(targetUser.id);
          
          await ctx.reply(`✅ User ${targetUser.username} has been unbanned by ${adminName}.`);
          
          // Send direct message to user if possible
          try {
            const telegramId = targetUser?.telegramId;
            if (telegramId && typeof telegramId === 'string') {
              await this.bot.telegram.sendMessage(
                telegramId,
                `✅ You have been unbanned and can now use this bot again.`
              );
            }
          } catch (error) {
            console.error("Error sending unban notification to user:", error);
          }
        } else if (target.startsWith("@") || /^[a-zA-Z0-9_.]+$/.test(target)) {
          // First, try to find by username
          const username = target.startsWith("@") ? target.substring(1) : target;
          let targetUser = await storage.getUserByUsername(username);
          
          // If not found by username, try as telegram ID
          if (!targetUser) {
            targetUser = await storage.getUserByTelegramId(username);
          }
          
          if (!targetUser) {
            await ctx.reply(`❌ User with username or Telegram ID "${username}" not found.`);
            return;
          }
          
          if (!targetUser.isBanned) {
            await ctx.reply(`User ${targetUser.username} is not banned.`);
            return;
          }
          
          // Unban user
          await storage.unbanUser(targetUser.id);
          
          await ctx.reply(`✅ User ${targetUser.username} has been unbanned by ${adminName}.`);
          
          // Send direct message to user if possible
          try {
            const telegramId = targetUser?.telegramId;
            if (telegramId && typeof telegramId === 'string') {
              await this.bot.telegram.sendMessage(
                telegramId,
                `✅ You have been unbanned and can now use this bot again.`
              );
            }
          } catch (error) {
            console.error("Error sending unban notification to user:", error);
          }
        } else {
          await ctx.reply("❌ Invalid format. Please provide a valid user ID, username, or Telegram ID.");
          return;
        }
      } catch (error) {
        console.error("Error unbanning user:", error);
        await ctx.reply("❌ An error occurred while trying to unban the user. Please try again.");
      }
    });
    
    // Register actual command handler for /close with MAXIMUM VERBOSITY for debugging
    this.bot.command("close", async (ctx) => {
      console.log("===== DIRECT /close COMMAND TRIGGERED =====");
      log("===== DIRECT /close COMMAND =====", "info");
      
      console.log("FULL CTX OBJECT:", JSON.stringify(ctx, null, 2));
      
      const userId = ctx.from?.id;
      if (!userId) {
        log("No user ID in close command", "error");
        return;
      }
      
      // Immediately send a reply to confirm the command was received
      try {
        await ctx.reply("🔄 Processing close command...");
        console.log("Sent initial acknowledgment message");
      } catch (replyErr) {
        console.error("ERROR SENDING INITIAL REPLY:", replyErr);
      }
      
      try {
        console.log(`Handling /close command from user ${userId} via direct command`);
        console.log("Before handleCloseCommand call");
        const result = await handleCloseCommand(userId, ctx, this.bridge);
        console.log(`/close command handler completed with result: ${result}`);
        
        // Send additional confirmation after completion
        try {
          await ctx.reply(`✅ Close command processed with result: ${result}`);
          console.log("Sent final confirmation message");
        } catch (finalReplyErr) {
          console.error("ERROR SENDING FINAL REPLY:", finalReplyErr);
        }
      } catch (error) {
        console.error("ERROR IN DIRECT /close COMMAND HANDLER:", error);
        log(`ERROR IN DIRECT /close COMMAND HANDLER: ${error}`, "error");
        
        // Try to notify the user of the error
        try {
          await ctx.reply("❌ Error processing close command. Please try again.");
        } catch (errorReplyErr) {
          console.error("ERROR SENDING ERROR REPLY:", errorReplyErr);
        }
      }
      
      log("===== END DIRECT /close COMMAND =====", "info");
      console.log("===== END DIRECT /close COMMAND =====");
    });
    
    // Also keep the hears handler as fallback
    this.bot.hears(/^\/close($|\s)/i, async (ctx) => {
      console.log("===== SLASH CLOSE TEXT HANDLER TRIGGERED =====");
      log("===== SLASH CLOSE TEXT HANDLER =====", "info");
      
      const userId = ctx.from?.id;
      if (!userId) {
        log("No user ID in close command", "error");
        return;
      }
      
      log(`/close command received from ${userId} - Starting handler`, "info");
      console.log(`/close command received from ${userId} - Starting handler`);
      
      try {
        // Use our dedicated handler for maximum reliability
        const result = await handleCloseCommand(userId, ctx, this.bridge);
        console.log(`/close handler completed with result: ${result}`);
        log(`/close handler completed with result: ${result}`, "info");
      } catch (error) {
        console.error("ERROR IN /CLOSE HANDLER:", error);
        log(`ERROR IN /CLOSE HANDLER: ${error}`, "error");
      }
      
      log("===== END SLASH CLOSE TEXT HANDLER =====", "info");
      console.log("===== END SLASH CLOSE TEXT HANDLER =====");
    });

    // HIGHEST PRIORITY MIDDLEWARE - Runs before ANY other handlers
    this.bot.use(async (ctx, next) => {
      // Check if it's a message with text
      if (ctx.message && 'text' in ctx.message && ctx.message.text) {
        // Normalize the text by trimming and converting to lowercase
        const normalizedText = ctx.message.text.trim().toLowerCase();
        
        // Check if this is a close command but don't handle it here anymore
        // Instead, just mark it as a command to prevent forwarding
        if (normalizedText === '/close' || normalizedText.startsWith('/close ')) {
          // Mark this message as handled to prevent forwarding to Discord
          if (ctx.message) {
            // Add special markers to prevent forwarding
            (ctx.message as any)._isCommand = true;
            // Set a safe text that won't trigger other command handlers
            (ctx.message as any)._commandHandled = true;
          }
        }
      }
      
      // Continue to other handlers in all cases
      return next();
    });
    
    this.bot.on("text", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      if (!this.checkRateLimit(userId, 'message')) {
        await ctx.reply("⚠️ You are sending messages too fast. Please wait a moment.");
        return;
      }
      
      // CRITICAL PATCH: Direct command handling at the source
      // For all commands, process them immediately at this level
      const messageText = ctx.message?.text || "";
      if (messageText.startsWith('/')) {
        const commandParts = messageText.split(' ')[0].split('@');
        const command = commandParts[0].substring(1).toLowerCase(); // Remove leading / and normalize
        
        log(`[ROOT HANDLER] Detected command /${command} from user ${userId}`, "info");
        console.log(`[ROOT HANDLER] Detected command /${command} from user ${userId}`);
        
        // Super high priority - handle /close command directly at the source level
        if (command === 'close') {
          log(`[ROOT HANDLER] Directly handling /close command from user ${userId} in text handler`, "info");
          console.log(`[ROOT HANDLER] Directly handling /close command from user ${userId} in text handler`);
          
          try {
            await ctx.reply("🔄 Processing close command from raw message handler...");
            const result = await handleCloseCommand(userId, ctx, this.bridge);
            console.log(`Direct text handler close command completed with result: ${result}`);
            return; // Exit after handling the command
          } catch (error) {
            console.error("ERROR in direct text handler /close command:", error);
            await ctx.reply("❌ Error processing close command. Please try again.");
            return;
          }
        }
        
        // Handle the /switch command specially
        if (command === 'switch') {
          log(`[ROOT HANDLER] Handling /switch command from user ${userId}`, "info");
          
          // Get user information
          const user = await storage.getUserByTelegramId(userId.toString());
          if (!user) {
            await ctx.reply("You haven't created any tickets yet.");
            return;
          }
          
          try {
            await this.handleCategoryMenu(ctx);
            log(`[ROOT HANDLER] Successfully displayed category menu for user ${userId}`, "info");
          } catch (error) {
            log(`[ROOT HANDLER] Error displaying category menu: ${error}`, "error");
            await ctx.reply("❌ There was an error displaying categories. Please try again.");
          }
          
          return; // Exit after handling the command
        }
        
        // If it's not a special case, let the original command handler handle it
        // The message will continue processing below
      }

      // Check if we're in questionnaire mode first to avoid ticket checks when unnecessary
      const state = this.userStates.get(userId);
      if (state?.inQuestionnaire) {
        log(`User ${userId} is in questionnaire mode, handling response`, "info");
        await this.handleQuestionnaireResponse(ctx, state);
        return;
      }
      
      // If bot is not connected, queue the message
      if (!this._isConnected) {
        try {
          const user = await storage.getUserByTelegramId(userId.toString());
          if (!user) {
            log(`User ${userId} not found in database, cannot queue message`, "warn");
            await ctx.reply("❌ You need to start a conversation with /start first.");
            return;
          }
          
          // Query all tickets from this user directly from the database
          log(`Getting tickets for user ${user.id} for offline queue processing`, "debug");
          const userTickets = await storage.getTicketsByUserId(user.id);
          
          if (!userTickets || userTickets.length === 0) {
            log(`No tickets found for user ${user.id}`, "info");
            await ctx.reply("❌ You don't have any tickets. Use /start to create one.");
            return;
          }
          
          // Find and sort active tickets by ID in descending order (newest first)
          const activeTickets = userTickets
            .filter(t => !['closed', 'completed', 'transcript'].includes(t.status))
            .sort((a, b) => b.id - a.id);
          
          log(`Found ${activeTickets.length} active tickets for user ${user.id}`, "debug");
          
          if (activeTickets.length === 0) {
            await ctx.reply("❌ You don't have an active ticket. Use /start to create one.");
            return;
          }
          
          // Use the most recent active ticket
          const ticket = activeTickets[0];
          log(`Selected ticket ${ticket.id} with status ${ticket.status} for offline processing`, "info");
          
          // Queue the text message
          await storage.queueMessage({
            telegramUserId: userId.toString(),
            messageType: 'text',
            content: ctx.message.text,
            processed: false,
            processingAttempts: 0,
            timestamp: new Date()
          });
          
          await ctx.reply("📤 The bot is currently reconnecting. Your message has been queued and will be processed soon.");
          return;
        } catch (error) {
          log(`Error queueing message: ${error}`, "error");
          await ctx.reply("⚠️ Could not queue your message. Please try again when the bot is online.");
          return;
        }
      }

      try {
        // Get user record
        const user = await storage.getUserByTelegramId(userId.toString());
        if (!user) {
          log(`User ${userId} not found in database for text message handling`, "warn");
          await ctx.reply("❌ You need to start a conversation with /start first.");
          return;
        }
        
        // Query all tickets from this user directly from the database
        log(`Getting tickets for user ${user.id} for text message handling`, "debug");
        const userTickets = await storage.getTicketsByUserId(user.id);
        
        if (!userTickets || userTickets.length === 0) {
          log(`No tickets found for user ${user.id}`, "info");
          
          // If we have a questionnaire state, handle that instead
          if (state) {
            log(`No tickets but user has state, handling questionnaire response`, "info");
            await this.handleQuestionnaireResponse(ctx, state);
            return;
          }
          
          await ctx.reply("❌ You don't have any tickets. Use /start to create one.");
          return;
        }
        
        // Find and sort active tickets by ID in descending order (newest first)
        const activeTickets = userTickets
          .filter(t => !['closed', 'completed', 'transcript'].includes(t.status))
          .sort((a, b) => b.id - a.id);
        
        log(`Found ${activeTickets.length} active tickets for user ${user.id}, ticket statuses: ${activeTickets.map(t => t.status).join(', ')}`, "debug");
        
        if (activeTickets.length > 0) {
          // Use the most recent active ticket
          const ticket = activeTickets[0];
          log(`Selected ticket ${ticket.id} with status ${ticket.status} for message handling`, "info");
          
          // Now delegate to handleTicketMessage which will re-verify the ticket
          await this.handleTicketMessage(ctx, user, ticket);
          return;
        } else {
          log(`No active tickets found for user ${user.id}, all tickets are closed/completed/transcript`, "info");
          
          // If we're in a questionnaire, handle that instead of showing an error
          if (state) {
            log(`No active tickets but user has state, handling questionnaire response`, "info");
            await this.handleQuestionnaireResponse(ctx, state);
            return;
          }
          
          await ctx.reply("❌ You don't have an active ticket. Use /start to create one.");
          return;
        }
      } catch (error) {
        log(`Error processing text message: ${error}`, "error");
        await ctx.reply("❌ There was an error processing your message. Please try again.");
      }
    });

    this.bot.on("photo", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      if (!this.checkRateLimit(userId, 'message')) {
        await ctx.reply("⚠️ You are sending messages too fast. Please wait a moment.");
        return;
      }
      
      // If bot is not connected, queue the photo
      if (!this._isConnected) {
        try {
          const user = await storage.getUserByTelegramId(userId.toString());
          if (!user) {
            log(`User ${userId} not found in database, cannot queue photo`, "warn");
            await ctx.reply("❌ You need to start a conversation with /start first.");
            return;
          }
          
          // Query all tickets from this user directly from the database
          log(`Getting tickets for user ${user.id} for offline photo queue processing`, "debug");
          const userTickets = await storage.getTicketsByUserId(user.id);
          
          if (!userTickets || userTickets.length === 0) {
            log(`No tickets found for user ${user.id} for photo`, "info");
            await ctx.reply("❌ You don't have any tickets. Use /start to create one.");
            return;
          }
          
          // Find and sort active tickets by ID in descending order (newest first)
          const activeTickets = userTickets
            .filter(t => !['closed', 'completed', 'transcript'].includes(t.status))
            .sort((a, b) => b.id - a.id);
          
          log(`Found ${activeTickets.length} active tickets for user ${user.id} for photo queue`, "debug");
          
          if (activeTickets.length === 0) {
            await ctx.reply("❌ You don't have an active ticket. Use /start to create one.");
            return;
          }
          
          // Use the most recent active ticket
          const ticket = activeTickets[0];
          log(`Selected ticket ${ticket.id} with status ${ticket.status} for offline photo processing`, "info");
          
          // Get the best photo
          const photos = ctx.message.photo;
          const bestPhoto = photos[photos.length - 1];
          
          // Queue the photo - we only store the file_id since we can't get the file now
          await storage.queueMessage({
            telegramUserId: userId.toString(),
            messageType: 'photo',
            photoId: bestPhoto.file_id,
            content: ctx.message.caption || null,
            processed: false,
            processingAttempts: 0,
            timestamp: new Date()
          });
          
          await ctx.reply("📤 The bot is currently reconnecting. Your photo has been queued and will be processed soon.");
          return;
        } catch (error) {
          log(`Error queueing photo: ${error}`, "error");
          await ctx.reply("⚠️ Could not queue your photo. Please try again when the bot is online.");
          return;
        }
      }

      let user;
      let ticket;
      
      try {
        // Get user record
        user = await storage.getUserByTelegramId(userId.toString());
        if (!user) {
          log(`User ${userId} not found in database for photo handling`, "warn");
          await ctx.reply("❌ You need to start a conversation with /start first.");
          return;
        }
        
        // Query all tickets from this user directly from the database
        log(`Getting tickets for user ${user.id} for photo handling`, "debug");
        const userTickets = await storage.getTicketsByUserId(user.id);
        
        if (!userTickets || userTickets.length === 0) {
          // Provide more helpful message and log the issue
          log(`No tickets found for user ${user.id} (${user.telegramId}) when trying to send a photo`, "warn");
          await ctx.reply("❌ You don't have any tickets. Use /start to create one.");
          return;
        }
        
        // Find and sort active tickets by ID in descending order (newest first)
        const activeTickets = userTickets
          .filter(t => !['closed', 'completed', 'transcript'].includes(t.status))
          .sort((a, b) => b.id - a.id);
        
        log(`Found ${activeTickets.length} active tickets for user ${user.id}, ticket statuses: ${activeTickets.map(t => t.status).join(', ')}`, "debug");
        
        if (activeTickets.length === 0) {
          log(`No active tickets found for user ${user.id} (${user.telegramId}) when trying to send a photo`, "warn");
          await ctx.reply("❌ You don't have an active ticket. Use /start to create one.");
          return;
        }
        
        // Use the most recent active ticket
        ticket = activeTickets[0];
        
        // Log found ticket for debugging
        log(`Found ${ticket.status} ticket ${ticket.id} for photo upload`, "info");
        
        // If it's a pending ticket, inform the user but still accept the photo
        if (ticket.status === 'pending') {
          await ctx.reply("⚠️ Your ticket is in pending state due to high volume. Staff will see your photo when a channel becomes available.");
        }
        
        // Check if the ticket has a Discord channel if it's not pending
        if (ticket.status !== 'pending' && !ticket.discordChannelId) {
          await ctx.reply("⚠️ Your ticket is active but not yet connected to Discord. The staff will see your photo when they create a channel.");
        }

        try {
          const photos = ctx.message.photo;
          const bestPhoto = photos[photos.length - 1]; // Get highest quality photo
          const file = await ctx.telegram.getFile(bestPhoto.file_id);

          // Store message in database for all ticket states
          await storage.createMessage({
            ticketId: ticket.id,
            content: ctx.message.caption || "[Image]", // This is just for database storage, not what's displayed on Discord
            authorId: user.id,
            platform: "telegram",
            timestamp: new Date()
          });
          
          // If ticket is pending or has no Discord channel, just acknowledge receipt
          if (ticket.status === 'pending' || !ticket.discordChannelId) {
            await ctx.reply("✓ Your photo has been received and will be forwarded when your ticket is processed.");
            return;
          }

          // Get avatar URL if possible
          let avatarUrl: string | undefined;
          try {
            if (!ctx.from?.id) return;
            const photos = await ctx.telegram.getUserProfilePhotos(ctx.from.id, 0, 1);
            if (photos && photos.total_count > 0) {
              const fileId = photos.photos[0][0].file_id;
              const file = await ctx.telegram.getFile(fileId);
              if (file?.file_path) {
                avatarUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
              }
            }
          } catch (error) {
            log(`Error getting Telegram user avatar: ${error}`, "error");
          }

          // Get user's first and last name
          const firstName = ctx.from?.first_name || "";
          const lastName = ctx.from?.last_name || "";
          const displayName = [firstName, lastName].filter(Boolean).join(' ') || "Telegram User";

          try {
            // Send caption if exists
            if (ctx.message.caption) {
              await this.bridge.forwardToDiscord(
                ctx.message.caption,
                ticket.id,
                displayName,
                avatarUrl,
                undefined,
                firstName,
                lastName
              );
            }

            // Forward the photo using the file_id
            await this.bridge.forwardToDiscord(
              "",
              ticket.id,
              displayName,
              avatarUrl,
              bestPhoto.file_id, // Pass the file_id directly
              firstName,
              lastName
            );

            log(`Successfully forwarded photo from Telegram to Discord for ticket ${ticket.id}`);
          } catch (error) {
            log(`Error forwarding photo to Discord: ${error}`, "error");
            await ctx.reply("⚠️ Your photo was saved but could not be forwarded to Discord staff. They will still see it in the chat history.");
            return;
          }
        } catch (error) {
          log(`Error handling photo message: ${error}`, "error");
          await ctx.reply("Sorry, there was an error processing your photo. Please try again.");
        }
      } catch (error) {
        log(`Error in photo handler: ${error}`, "error");
        await ctx.reply("Sorry, there was an error processing your photo. Please try again.");
      }
    });
  }

  private async handleQuestionnaireResponse(ctx: Context, state: UserState) {
    const category = await storage.getCategory(state.categoryId);
    if (!category) {
      console.error(`Category ${state.categoryId} not found`);
      return;
    }

    const userId = ctx.from?.id;
    if (!userId || !ctx.message || !('text' in ctx.message)) return;

    console.log(`Processing question ${state.currentQuestion + 1}/${category.questions.length}`);

    // Store the answer
    state.answers.push(ctx.message.text);

    // Check if we have more questions
    if (state.currentQuestion < category.questions.length - 1) {
      // Move to next question
      state.currentQuestion++;

      // Update state before sending next question
      this.setState(userId, {
        ...state,
        currentQuestion: state.currentQuestion,
        inQuestionnaire: true
      });

      // Add shorter delay before next question
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Send next question
      await ctx.reply(category.questions[state.currentQuestion]);
    } else {
      try {
        // Create ticket with raw answers
        await this.createTicket(ctx);
      } catch (error) {
        log(`Error creating ticket: ${error}`, "error");
        await ctx.reply("❌ There was an error creating your ticket. Please try /start to begin again.");

        // Clean up state on error
        this.userStates.delete(userId);
        this.stateCleanups.delete(userId);
        this.activeUsers.delete(userId);
      }
    }
  }

  private async createTicket(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const state = this.userStates.get(userId);
    if (!state) {
      await ctx.reply("❌ Something went wrong. Please try /start to begin again.");
      return;
    }

    try {
      // Create or get user
      let user = await storage.getUserByTelegramId(userId.toString());
      if (!user) {
        if (!ctx.from) return;
        user = await storage.createUser({
          username: ctx.from.username || "Unknown",
          telegramId: userId.toString(),
          telegramUsername: ctx.from.username,
          telegramName: ctx.from.first_name,
          discordId: null,
          isBanned: false
        });
      }

      // Create ticket with raw answers
      const ticket = await storage.createTicket({
        userId: user.id,
        categoryId: state.categoryId,
        status: "open",
        discordChannelId: null,
        claimedBy: null,
        amount: null,
        answers: state.answers,
        completedAt: null
      });

      try {
        // Create Discord channel first
        await this.bridge.createTicketChannel(ticket);
        await ctx.reply("✅ Ticket created! A staff member will be with you shortly. You can continue chatting here, and your messages will be forwarded to our team.");
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        if (errorMessage.includes('maximum channel limit')) {
          // Update status to pending in database
          try {
            await storage.updateTicketStatus(ticket.id, "pending");
            log(`Updated ticket ${ticket.id} status to pending due to channel limit`, "info");
          } catch (statusError) {
            log(`Failed to update ticket status: ${statusError}`, "error");
          }
          
          await ctx.reply(
            "❌ Sorry, our support channels are currently at maximum capacity.\n" +
            "Your ticket has been created but is in a pending state."
          );
        } else {
          await ctx.reply(
            "❌ There was an error creating your Discord channel. Please try again or contact an administrator."
          );
          log(`Failed to create Discord channel for ticket ${ticket.id}: ${errorMessage}`, "error");
        }
      } finally {
        // Clean up state after ticket creation (success or failure)
        this.userStates.delete(userId);
        this.stateCleanups.delete(userId);
        this.activeUsers.delete(userId);
      }
    } catch (error) {
      log(`Error creating ticket: ${error}`, "error");
      await ctx.reply("❌ There was an error creating your ticket. Please try /start to begin again.");

      // Clean up state on error
      this.userStates.delete(userId);
      this.stateCleanups.delete(userId);
      this.activeUsers.delete(userId);
    }
  }

  private async checkCommandCooldown(userId: number, command: string): Promise<boolean> {
    const state = this.userStates.get(userId);
    if (!state) return true;
    return this.checkRateLimit(userId, 'command', command);
  }

  private async checkMessageRateLimit(userId: number): Promise<boolean> {
    const state = this.userStates.get(userId);
    if (!state) return true;
    return this.checkRateLimit(userId, 'message');
  }

}

if (!process.env.TELEGRAM_BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN is required");
}
