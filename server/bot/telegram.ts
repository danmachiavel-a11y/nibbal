import { Telegraf, Context } from "telegraf";
import { storage } from "../storage";
import { BridgeManager } from "./bridge";
import { log } from "../vite";
import fetch from 'node-fetch';

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


// Simple rate limiting configuration
const RATE_LIMIT_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW || "30000", 10); // 30 seconds default
const RATE_LIMIT_MAX_COUNT = parseInt(process.env.RATE_LIMIT_MAX_COUNT || "20", 10); // 20 requests default

// User state cleanup configuration 
const USER_STATE_CLEANUP_INTERVAL = 300000; // 5 minutes
const USER_INACTIVE_TIMEOUT = 3600000; // 1 hour
const MAX_INACTIVE_STATES = 1000; // Maximum number of stored states

//Original simpleEscape function has been replaced with enhanced version

// Thread-safe markdown escaping function with caching
const markdownCache = new Map<string, string>();
const MAX_CACHE_SIZE = 1000; // Maximum number of cached entries
const DEFAULT_SPECIAL_CHARS = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];

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
      if (!this.bot?.telegram) return false;

      const me = await this.bot.telegram.getMe();
      const now = Date.now();

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
      log(`Bot verification failed: ${error}`, "error");
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
    } catch (error) {
      log(`Heartbeat check failed: ${error}`, "warn");
      this.failedHeartbeats++;

      // Only disconnect on critical errors or after multiple failures
      if ((error.message?.includes('restart') || error.message?.includes('unauthorized')) ||
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

      // Create new bot instance
      log("Creating new Telegram bot instance");
      this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

      // Add handlers
      await this.setupHandlers();

      // Add delay before launching
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Launch with conservative options
      await this.bot.launch({
        dropPendingUpdates: true,
        allowedUpdates: ["message", "callback_query"]
      });

      const botInfo = await this.bot.telegram.getMe();
      log(`Connected as @${botInfo.username}`);

      this._isConnected = true;
      this.updateConnectionState('connected');
      this.startHeartbeat();
      this.reconnectAttempts = 0;

      log("Telegram bot started successfully");
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.updateConnectionState('disconnected', errorMsg);
      log(`Error starting Telegram bot: ${error}`, "error");
      this._isConnected = false;
      this.failedHeartbeats = 0;

      if (error instanceof Error && error.message.includes("409: Conflict")) {
        log("409 Conflict detected - another bot instance is already running", "error");
        await this.stop();
        await new Promise(resolve => setTimeout(resolve, this.CLEANUP_DELAY * 2));
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
      if (!this.bot) {
        throw new Error("Bot not initialized");
      }

      await this.bot.telegram.sendMessage(chatId, simpleEscape(text), {
        parse_mode: "MarkdownV2"
      });
    } catch (error) {
      log(`Error sending message: ${error}`, "error");
      throw error;
    }
  }

  async sendPhoto(chatId: number, photo: Buffer | string, caption?: string): Promise<string | undefined> {
    try {
      if (!this.bot) {
        throw new Error("Bot not initialized");
      }

      log(`Sending photo to chat ${chatId}`);
      let sentMessage;

      // If photo is a URL, download it first
      if (typeof photo === 'string' && photo.startsWith('http')) {
        const response = await fetch(photo);
        const buffer = await response.buffer();
        sentMessage = await this.bot.telegram.sendPhoto(chatId, { source: buffer }, {
          caption: caption ? simpleEscape(caption) : undefined,
          parse_mode: "MarkdownV2"
        });
      } else if (photo instanceof Buffer) {
        // Handle buffer by using InputFile format
        sentMessage = await this.bot.telegram.sendPhoto(chatId, { source: photo }, {
          caption: caption ? simpleEscape(caption) : undefined,
          parse_mode: "MarkdownV2"
        });
      } else {
        // Handle file_id string
        sentMessage = await this.bot.telegram.sendPhoto(chatId, photo, {
          caption: caption ? simpleEscape(caption) : undefined,
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
      if (!this.bot) {
        throw new Error("Bot not initialized");
      }

      await this.bot.telegram.sendPhoto(chatId, fileId, {
        caption: caption ? simpleEscape(caption) : undefined,
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
        await this.bot?.telegram.getChat(activeId);
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

  private async handleTicketMessage(ctx: Context, user: any, ticket: any) {
    if (!ctx.message || !('text' in ctx.message)) return;

    const userId = ctx.from?.id;
    if (!userId) return;

    // Get user state before rate limit check
    const state = this.userStates.get(userId);
    log(`Received message from user ${userId}. Current state: ${JSON.stringify(state)}`);

    if (!this.checkRateLimit(userId, 'message')) {
      await ctx.reply("⚠️ You are sending messages too fast. Please wait a moment.");
      return;
    }

    try {
      // If we're in a questionnaire, handle that first
      if (state?.inQuestionnaire) {
        await this.handleQuestionnaireResponse(ctx, state);
        return;
      }

      // Check if user still has an active ticket
      const activeTicket = await storage.getActiveTicketByUserId(user.id);
      if (!activeTicket || activeTicket.id !== ticket.id) {
        await ctx.reply("❌ This ticket is no longer active. Use /start to create a new ticket.");
        return;
      }

      // Process message
      await storage.createMessage({
        ticketId: ticket.id,
        content: ctx.message.text,
        authorId: user.id,
        platform: "telegram",
        timestamp: new Date()
      });

      let avatarUrl: string | undefined;
      try {
        const photos = await this.bot?.telegram.getUserProfilePhotos(ctx.from.id, 0, 1);
        if (photos && photos.total_count > 0) {
          const fileId = photos.photos[0][0].file_id;
          const file = await this.bot?.telegram.getFile(fileId);
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

      // Use simple simpleEscape to avoid Markdown parsing errors
      const welcomeMessage = simpleEscape(botConfig?.welcomeMessage || "Welcome to the support bot! Please select a service:", ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!']);

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
      } catch (error) {
        // If editing fails, send a new message
        if (error.message?.includes("message can't be edited")) {
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
              caption: category.serviceSummary ? simpleEscape(category.serviceSummary) : undefined,
              parse_mode: "MarkdownV2"
            }
          );
        } catch (error) {
          log(`Error sending service image: ${error}`, "error");
          // If image fails, still show the summary as text
          if (category.serviceSummary) {
            await ctx.reply(simpleEscape(category.serviceSummary), {
              parse_mode: "MarkdownV2"
            });
          }
        }
      } else if (category.serviceSummary) {
        // If no image but has summary, show summary as text
        await ctx.reply(simpleEscape(category.serviceSummary), {
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
      await ctx.reply(simpleEscape(questions[0]), {
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
        await ctx.editMessageText(simpleEscape(message), {
          parse_mode: "MarkdownV2",
          reply_markup: { inline_keyboard: keyboard }
        });
      } catch (error) {
        // If editing fails, send a new message
        if (error instanceof Error && error.message?.includes("message can't be edited")) {
          await ctx.reply(simpleEscape(message), {
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
            const escapedMessage = simpleEscape(
              `You already have an active ticket in the "${categoryName}" category.

You cannot create a new ticket while you have an active one.
Please use /close to close your current ticket first, or continue chatting here to update your existing ticket.`
            );
            
            await ctx.reply(
              `❌ ${escapedMessage}`,
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
          
          const category = await storage.getCategory(ticket.categoryId);
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
      
      // Using simpleEscape for Markdown formatting
      const categoryName = category?.name || "Unknown";
      const statusText = activeTicket.status;
      
      // Since we don't have a createdAt field, format date based on ID
      // (Ticket IDs are sequential so higher IDs are newer tickets)
      const createdDate = new Date().toLocaleString();
      
      const escapedMessage = simpleEscape(
        `Your active ticket #${activeTicket.id}:

Category: ${categoryName}
Status: ${statusText}
ID: ${activeTicket.id}`
      );
      
      await ctx.reply(escapedMessage, { parse_mode: "MarkdownV2" });
    });

    this.bot.command("switch", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;
      
      if (!this.checkRateLimit(userId, 'command', 'switch')) {
        await ctx.reply("⚠️ Please wait before using this command again.");
        return;
      }

      try {
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
            if (targetUser.telegramId) {
              await this.bot.telegram.sendMessage(
                targetUser.telegramId,
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
            if (targetUser.telegramId) {
              await this.bot.telegram.sendMessage(
                targetUser.telegramId,
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
            if (targetUser.telegramId) {
              await this.bot.telegram.sendMessage(
                targetUser.telegramId,
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
            if (targetUser.telegramId) {
              await this.bot.telegram.sendMessage(
                targetUser.telegramId,
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
    
    this.bot.command("close", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;
      if (!this.checkRateLimit(userId, 'command', 'close')) {
        await ctx.reply("⚠️ Please wait before using this command again.");
        return;
      }

      const user = await storage.getUserByTelegramId(userId.toString());
      if (!user) {
        await ctx.reply("You haven't created any tickets yet.");
        return;
      }

      const activeTicket = await storage.getActiveTicketByUserId(user.id);
      if (!activeTicket) {
        await ctx.reply("You don't have any active tickets to close.");
        return;
      }

      try {
        const categoryId = activeTicket.categoryId ?? 0;
        const category = await storage.getCategory(categoryId);
        if (!category?.transcriptCategoryId) {
          await ctx.reply(
            "❌ Cannot close ticket: No transcript category set for this service. " +
            "Please contact an administrator."
          );
          return;
        }

        await storage.updateTicketStatus(activeTicket.id, "closed");

        if (activeTicket.discordChannelId) {
          try {
            await this.bridge.moveToTranscripts(activeTicket.id);
            await ctx.reply(
              "✅ Your ticket has been closed and moved to transcripts.\n" +
              "Use /start to create a new ticket if needed."
            );
          } catch (error) {
            console.error("Error moving to transcripts:", error);
            await ctx.reply(
              "✅ Your ticket has been closed, but there was an error moving the Discord channel.\n" +
              "An administrator will handle this. You can use /start to create a new ticket if needed."
            );
          }
        } else {
          await ctx.reply(
            "✅ Your ticket has been closed.\n" +
            "Use /start to create a new ticket if needed."
          );
        }
      } catch (error) {
        console.error("Error closing ticket:", error);
        await ctx.reply(
          "❌ There was an error closing your ticket. Please try again or contact an administrator."
        );
      }
    });

    this.bot.on("text", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      if (!this.checkRateLimit(userId, 'message')) {
        await ctx.reply("⚠️ You are sending messages too fast. Please wait a moment.");
        return;
      }

      const state = this.userStates.get(userId);
      console.log(`Received message from user ${userId}. Current state:`, state);

      const user = await storage.getUserByTelegramId(userId.toString());
      if (user) {
        const activeTicket = await storage.getActiveTicketByUserId(user.id);
        if (activeTicket) {
          await this.handleTicketMessage(ctx, user, activeTicket);
          return;
        }
      }

      if (state) {
        await this.handleQuestionnaireResponse(ctx, state);
      }
    });

    this.bot.on("photo", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      if (!this.checkRateLimit(userId, 'message')) {
        await ctx.reply("⚠️ You are sending messages too fast. Please wait a moment.");
        return;
      }

      const user = await storage.getUserByTelegramId(userId.toString());
      if (!user) return;

      const activeTicket = await storage.getActiveTicketByUserId(user.id);
      if (!activeTicket) {
        await ctx.reply("Please start a ticket first before sending photos.");
        return;
      }

      try {
        const photos = ctx.message.photo;
        const bestPhoto = photos[photos.length - 1]; // Get highest quality photo
        const file = await ctx.telegram.getFile(bestPhoto.file_id);

        await storage.createMessage({
          ticketId: activeTicket.id,
          content: ctx.message.caption || "Image sent",
          authorId: user.id,
          platform: "telegram",
          timestamp: new Date()
        });

        // Get avatar URL if possible
        let avatarUrl: string | undefined;
        try {
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

        // Send caption if exists
        if (ctx.message.caption) {
          await this.bridge.forwardToDiscord(
            ctx.message.caption,
            activeTicket.id,
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
          activeTicket.id,
          displayName,
          avatarUrl,
          bestPhoto.file_id, // Pass the file_id directly
          firstName,
          lastName
        );

        log(`Successfully forwarded photo from Telegram to Discord for ticket ${activeTicket.id}`);
      } catch (error) {
        log(`Error handling photo message: ${error}`, "error");
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
