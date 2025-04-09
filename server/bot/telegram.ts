/**
 * Telegram Bot Implementation for Support Ticket System
 * With enhanced null-safety using the telegram getter
 */

import { Telegraf, Context } from "telegraf";
import { BridgeManager } from "./bridge";
import { log } from "../vite";
import { storage } from "../storage";
import fetch from "node-fetch";
import { processRawMessage } from "./direct-commands";

// Default special chars to escape in markdown
const DEFAULT_SPECIAL_CHARS = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];

// Cache for escaped text to avoid repeating the same work
const escapeCache = new Map<string, string>();

interface RateLimit {
  lastRequest: number;
  count: number;
}

class RateLimitManager {
  private userRateLimits = new Map<number, Map<string, RateLimit>>();
  private readonly cleanupInterval: NodeJS.Timeout;
  private readonly RATE_LIMIT_WINDOW = 60000; // 1 minute
  private readonly MAX_REQUESTS_PER_WINDOW = 30;
  private readonly COMMAND_MAX_REQUESTS = 15;  // Increased from 10 to 15
  private readonly COMMAND_SPECIFIC_LIMITS: { [key: string]: number } = {
    'ping': 5,      // Increased from 3 to 5
    'start': 5,     // Increased from 3 to 5
    'cancel': 5,    // Increased from 3 to 5
    'close': 5,     // Added specific limit for close
    'category': 8,  // Increased from 5 to 8
    'ban': 10,
    'unban': 10,
    'info': 10
  };

  constructor() {
    this.cleanupInterval = setInterval(() => this.cleanup(), 300000); // Clean every 5 minutes
  }

  isRateLimited(userId: number, type: 'command' | 'message' = 'message', command?: string): boolean {
    const now = Date.now();
    const key = type === 'command' && command ? `cmd:${command}` : type;
    
    // Initialize user's rate limit map if it doesn't exist
    if (!this.userRateLimits.has(userId)) {
      this.userRateLimits.set(userId, new Map());
    }
    
    const userLimits = this.userRateLimits.get(userId)!;
    let limit = userLimits.get(key);

    // If no limit exists for this specific command/type, create one
    if (!limit) {
      limit = { lastRequest: now, count: 1 };
      userLimits.set(key, limit);
      return false;
    }

    // Reset if outside window
    if (now - limit.lastRequest > this.RATE_LIMIT_WINDOW) {
      limit.count = 1;
      limit.lastRequest = now;
      return false;
    }

    // Apply different limits based on type and command
    let maxRequests = this.MAX_REQUESTS_PER_WINDOW;
    if (type === 'command') {
      maxRequests = command && this.COMMAND_SPECIFIC_LIMITS[command]
        ? this.COMMAND_SPECIFIC_LIMITS[command]
        : this.COMMAND_MAX_REQUESTS;
    }

    // Check if limit exceeded
    if (limit.count >= maxRequests) {
      return true;
    }

    // Increment counter and update timestamp
    limit.count++;
    limit.lastRequest = now;
    return false;
  }

  private cleanup(): void {
    const now = Date.now();
    // Clean up expired rate limits for all users
    for (const [userId, limitMap] of this.userRateLimits.entries()) {
      let allExpired = true;
      
      // Check each command/type limit
      for (const [key, limit] of limitMap.entries()) {
        if (now - limit.lastRequest > this.RATE_LIMIT_WINDOW) {
          // Remove expired limits
          limitMap.delete(key);
        } else {
          allExpired = false;
        }
      }
      
      // If all entries for this user are expired, remove the user entirely
      if (allExpired || limitMap.size === 0) {
        this.userRateLimits.delete(userId);
      }
    }
  }

  stop(): void {
    clearInterval(this.cleanupInterval);
  }
}

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

/**
 * Simple markdown character escaping for Telegram
 * Escapes characters that would otherwise have special meaning in MarkdownV2
 */
function simpleEscape(text: string, specialChars: string[] = DEFAULT_SPECIAL_CHARS): string {
  // Check cache first
  const cacheKey = `${text}|${specialChars.join('')}`;
  if (escapeCache.has(cacheKey)) {
    return escapeCache.get(cacheKey)!;
  }

  const escaped = escapeWithoutCache(text, specialChars);
  
  // Store in cache (with a maximum size to prevent memory issues)
  if (escapeCache.size > 1000) {
    // Clear oldest entries when cache gets too large
    const keys = Array.from(escapeCache.keys()).slice(0, 200);
    for (const key of keys) {
      escapeCache.delete(key);
    }
  }
  
  escapeCache.set(cacheKey, escaped);
  return escaped;
}

function escapeWithoutCache(text: string, specialChars: string[]): string {
  if (!text) return '';
  
  // This is the correct way to escape characters for Telegram MarkdownV2
  // Replace each special character with its escaped version
  let result = text;
  
  // These characters must be escaped in MarkdownV2
  const telegramSpecialChars = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
  
  // Use the intersection of provided specialChars and telegramSpecialChars
  const charsToEscape = specialChars.filter(char => telegramSpecialChars.includes(char));
  
  // Escape each character one by one
  for (const char of charsToEscape) {
    // Use a regex with global flag to replace all occurrences
    const regex = new RegExp('\\' + char, 'g');
    result = result.replace(regex, '\\' + char);
  }
  
  return result;
}

/**
 * Preserve intentional Markdown formatting while escaping other special characters
 * Modified for better compatibility with Telegram's MarkdownV2 format
 */
function preserveMarkdown(text: string): string {
  if (!text) return '';
  
  // Define the special characters that need to be escaped in MarkdownV2
  const specialChars = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
  
  // Replace all markdown formatting patterns with placeholders
  // This is done to protect the formatting from being escaped
  let processedText = text;
  
  // Replace bold with placeholder
  processedText = processedText.replace(/\*\*(.*?)\*\*/g, '§BOLD§$1§BOLD§');
  
  // Replace italic with placeholder
  processedText = processedText.replace(/\*(.*?)\*/g, '§ITALIC§$1§ITALIC§');
  processedText = processedText.replace(/_(.*?)_/g, '§ITALIC§$1§ITALIC§');
  
  // Replace code with placeholder
  processedText = processedText.replace(/`(.*?)`/g, '§CODE§$1§CODE§');
  
  // Replace links with placeholder
  processedText = processedText.replace(/\[(.*?)\]\((.*?)\)/g, '§LINK_TEXT§$1§LINK_TEXT§§LINK_URL§$2§LINK_URL§');
  
  // Escape all special characters
  for (const char of specialChars) {
    processedText = processedText.replace(new RegExp('\\' + char, 'g'), '\\' + char);
  }
  
  // Restore bold formatting
  processedText = processedText.replace(/§BOLD§(.*?)§BOLD§/g, '*$1*');
  
  // Restore italic formatting
  processedText = processedText.replace(/§ITALIC§(.*?)§ITALIC§/g, '_$1_');
  
  // Restore code formatting
  processedText = processedText.replace(/§CODE§(.*?)§CODE§/g, '`$1`');
  
  // Restore link formatting
  processedText = processedText.replace(/§LINK_TEXT§(.*?)§LINK_TEXT§§LINK_URL§(.*?)§LINK_URL§/g, '[$1]($2)');
  
  return processedText;
}

/**
 * Remove all markdown formatting from text
 * Useful for plain text contexts
 */
function removeMarkdown(text: string): string {
  // Remove bold
  text = text.replace(/\*\*(.*?)\*\*/g, '$1');
  
  // Remove italic
  text = text.replace(/\*(.*?)\*/g, '$1');
  text = text.replace(/_(.*?)_/g, '$1');
  
  // Remove code
  text = text.replace(/`(.*?)`/g, '$1');
  
  // Remove links, keep link text
  text = text.replace(/\[(.*?)\]\((.*?)\)/g, '$1');
  
  return text;
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
  
  /**
   * Safe getter for the telegram property
   * Returns a proxy that throws a helpful error if the bot is null
   */
  private get telegram() {
    if (!this.bot) {
      throw new Error("Bot not initialized");
    }
    return this.bot.telegram;
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
    initialDelay: 1000,
    maxDelay: 60000,
    factor: 2
  };
  
  private connectionState: ConnectionState = {
    status: 'disconnected',
    lastTransition: Date.now()
  };

  constructor(bridge: BridgeManager) {
    this.bridge = bridge;
  }

  private async verifyConnection(): Promise<boolean> {
    if (!this.bot) return false;
    
    try {
      await this.telegram.getMe();
      return true;
    } catch (error) {
      return false;
    }
  }

  private async handleHeartbeat() {
    if (!this._isConnected) {
      log(`Skipping heartbeat - bot is disconnected`, "debug");
      return;
    }

    try {
      const isConnected = await this.verifyConnection();
      if (isConnected) {
        this.failedHeartbeats = 0;
        this.lastHeartbeatSuccess = Date.now();
        log(`Telegram heartbeat successful`, "debug");
      } else {
        this.failedHeartbeats++;
        log(`Telegram heartbeat failed, count: ${this.failedHeartbeats}/${this.MAX_FAILED_HEARTBEATS}`, "warn");
        
        if (this.failedHeartbeats >= this.MAX_FAILED_HEARTBEATS) {
          log(`Too many failed heartbeats, attempting reconnection`, "warn");
          await this.handleDisconnect();
        }
      }
    } catch (error) {
      this.failedHeartbeats++;
      log(`Error during Telegram heartbeat: ${error}`, "error");
      
      if (this.failedHeartbeats >= this.MAX_FAILED_HEARTBEATS) {
        log(`Too many failed heartbeats, attempting reconnection`, "warn");
        await this.handleDisconnect();
      }
    }
  }

  private startHeartbeat = (): void => {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    this.heartbeatInterval = setInterval(() => this.handleHeartbeat(), this.HEARTBEAT_INTERVAL);
    log(`Started Telegram heartbeat monitoring (every ${this.HEARTBEAT_INTERVAL / 60000} minutes)`, "debug");
  }

  private stopHeartbeat = (): void => {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      log(`Stopped heartbeat monitoring`, "debug");
    }
  }

  private startCleanupInterval(): void {
    setInterval(() => this.cleanupStaleStates(), this.CLEANUP_DELAY);
  }

  private cleanupStaleStates(): void {
    const now = Date.now();
    
    // Clean up expired state timeouts
    for (const [userId, cleanup] of this.stateCleanups.entries()) {
      const age = now - cleanup.createdAt;
      if (age > this.STATE_TIMEOUT) {
        clearTimeout(cleanup.timeout);
        this.stateCleanups.delete(userId);
        this.userStates.delete(userId);
        this.activeUsers.delete(userId);
        log(`Cleared stale state for user ${userId}`, "debug");
      }
    }
  }

  private checkRateLimit(userId: number, type: 'command' | 'message', command?: string): boolean {
    if (this.rateLimitManager.isRateLimited(userId, type, command)) {
      log(`Rate limit exceeded for user ${userId}, type: ${type}, command: ${command || 'N/A'}`, "warn");
      return false;
    }
    return true;
  }

  private setState(userId: number, state: UserState) {
    // Clear existing timeout if any
    if (this.stateCleanups.has(userId)) {
      clearTimeout(this.stateCleanups.get(userId)!.timeout);
    }
    
    // Set the state
    this.userStates.set(userId, state);
    
    // Set up a timeout to clear the state
    const timeout = setTimeout(() => {
      this.userStates.delete(userId);
      this.stateCleanups.delete(userId);
      this.activeUsers.delete(userId);
      log(`Auto-cleared state for inactive user ${userId}`, "debug");
    }, this.STATE_TIMEOUT);
    
    // Save the cleanup info
    this.stateCleanups.set(userId, {
      timeout,
      createdAt: Date.now()
    });
    
    log(`Set state for user ${userId}: ${JSON.stringify(state)}`, "debug");
  }

  private updateConnectionState(newStatus: 'connected' | 'disconnected' | 'reconnecting', error?: string) {
    const oldStatus = this.connectionState.status;
    
    if (oldStatus !== newStatus) {
      log(`Connection state transition: ${oldStatus} -> ${newStatus}${error ? ` (${error})` : ''}`, "warn");
      
      this.connectionState = {
        status: newStatus,
        lastTransition: Date.now(),
        lastError: error
      };
      
      this._isConnected = newStatus === 'connected';
    }
  }

  private calculateBackoffDelay(): number {
    // Exponential backoff with jitter
    let delay = this.backoffConfig.initialDelay * Math.pow(this.backoffConfig.factor, this.reconnectAttempts);
    delay = Math.min(delay, this.backoffConfig.maxDelay);
    
    // Add random jitter (±20%)
    const jitter = delay * 0.2;
    delay = delay - jitter + (Math.random() * jitter * 2);
    
    return Math.floor(delay);
  }

  private async handleDisconnect() {
    this._isConnected = false;
    this.updateConnectionState('disconnected');
    
    // Stop the bot and clear resources
    try {
      if (this.bot) {
        await this.bot.stop();
      }
    } catch (error) {
      log(`Error stopping Telegram bot during disconnect: ${error}`, "error");
    }
    
    this.bot = null;
    this.stopHeartbeat();
    
    // Attempt to reconnect if within limits
    if (this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
      const delay = this.calculateBackoffDelay();
      this.reconnectAttempts++;
      log(`Will attempt to reconnect Telegram bot in ${delay}ms (attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})`, "warn");
      
      this.updateConnectionState('reconnecting');
      
      setTimeout(async () => {
        try {
          await this.start();
        } catch (error) {
          log(`Error during reconnect attempt: ${error}`, "error");
          await this.handleDisconnect();
        }
      }, delay);
    } else {
      log(`Maximum reconnect attempts reached (${this.MAX_RECONNECT_ATTEMPTS}), giving up`, "error");
      this.updateConnectionState('disconnected', "Max reconnect attempts exceeded");
    }
  }

  async start() {
    if (this.isStarting) {
      log("Telegram bot start already in progress", "warn");
      return;
    }
    
    if (this._isConnected && this.bot) {
      log("Telegram bot already started", "warn");
      return;
    }
    
    this.isStarting = true;
    log("Starting Telegram bot...", "info");
    
    try {
      // Reset reconnect attempts if this is a manual start
      if (this.connectionState.status === 'disconnected') {
        this.reconnectAttempts = 0;
      }
      
      this.updateConnectionState('reconnecting');
      this.stopHeartbeat();
      
      // Create new bot instance
      if (!process.env.TELEGRAM_BOT_TOKEN) {
        throw new Error("TELEGRAM_BOT_TOKEN environment variable is not set");
      }
      
      log("Creating new Telegram bot instance", "debug");
      this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
      
      // Check connection
      const botInfo = await this.telegram.getMe();
      log(`Connected to Telegram as @${botInfo.username}`, "info");
      
      // Setup event handlers
      this.setupHandlers();
      
      // Start polling for updates
      await this.bot.launch();
      
      // Start recurring tasks
      this.startHeartbeat();
      this.startCleanupInterval();
      
      // Update state
      this._isConnected = true;
      this.updateConnectionState('connected');
      this.failedHeartbeats = 0;
      this.lastHeartbeatSuccess = Date.now();
      
      log("Telegram bot started successfully", "info");
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log(`Error starting Telegram bot: ${errorMsg}`, "error");
      
      // Check for conflict error (another bot instance running)
      if (errorMsg.includes("409") || errorMsg.includes("Conflict")) {
        log("409 Conflict detected - another bot instance is already running", "error");
      }
      
      this.updateConnectionState('disconnected', errorMsg);
      this._isConnected = false;
      throw error;
    } finally {
      this.isStarting = false;
    }
  }

  async stop() {
    log("Stopping Telegram bot...", "info");
    
    try {
      this.stopHeartbeat();
      
      if (this.bot) {
        await this.bot.stop();
        this.bot = null;
      }
      
      this.rateLimitManager.stop();
      this._isConnected = false;
      this.updateConnectionState('disconnected');
      
      log("Telegram bot stopped successfully", "info");
    } catch (error) {
      log(`Error stopping Telegram bot: ${error}`, "error");
      throw error;
    }
  }

  getIsConnected(): boolean {
    return this._isConnected;
  }

  isStartingProcess(): boolean {
    return this.isStarting;
  }

  getLastError(): string | undefined {
    return this.connectionState.lastError;
  }
  
  async getFile(fileId: string) {
    try {
      // Use the telegram getter for null safety
      return await this.telegram.getFile(fileId);
    } catch (error) {
      log(`Error getting file: ${error}`, "error");
      throw error;
    }
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
        // Use telegram getter for null safety
        const photos = await this.telegram.getUserProfilePhotos(ctx.from.id, 0, 1);
        if (photos && photos.total_count > 0) {
          const fileId = photos.photos[0][0].file_id;
          const file = await this.telegram.getFile(fileId);
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

      // Use our new preserveMarkdown function to keep markdown formatting while escaping special chars
      const welcomeMessage = preserveMarkdown(botConfig?.welcomeMessage || "Welcome to the support bot! Please select a service:");

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

  private async handleQuestionnaireResponse(ctx: Context, state: UserState) {
    if (!ctx.from?.id || !ctx.message || !('text' in ctx.message)) return;
    
    try {
      const userId = ctx.from.id;
      const user = await storage.getUserByTelegramId(userId.toString());
      if (!user) {
        await ctx.reply("❌ Error: User not found. Please use /start to begin again.");
        return;
      }
      
      const category = await storage.getCategory(state.categoryId);
      if (!category) {
        await ctx.reply("❌ Error: Category not found. Please use /start to begin again.");
        return;
      }
      
      // Get the questions for this category
      const questions = category.questions || [];
      if (questions.length === 0) {
        await ctx.reply("❌ Error: No questions found for this category. Please contact an admin.");
        this.userStates.delete(userId);
        return;
      }
      
      // Store the answer
      state.answers[state.currentQuestion] = ctx.message.text;
      
      // Move to the next question or create ticket if all questions answered
      if (state.currentQuestion + 1 < questions.length) {
        // Move to next question
        state.currentQuestion++;
        this.setState(userId, state);
        
        // Ask the next question
        await ctx.reply(preserveMarkdown(questions[state.currentQuestion]), {
          parse_mode: "MarkdownV2"
        });
      } else {
        // All questions answered, create the ticket
        await this.createTicket(ctx);
      }
    } catch (error) {
      log(`Error in handleQuestionnaireResponse: ${error}`, "error");
      await ctx.reply("❌ There was an error processing your response. Please try again or use /cancel to start over.");
    }
  }

  private async createTicket(ctx: Context) {
    if (!ctx.from?.id) return;
    
    try {
      const userId = ctx.from.id;
      const state = this.userStates.get(userId);
      if (!state) {
        await ctx.reply("❌ Error: Session expired. Please use /start to begin again.");
        return;
      }
      
      // Get the user
      const user = await storage.getUserByTelegramId(userId.toString());
      if (!user) {
        await ctx.reply("❌ Error: User not found. Please use /start to begin again.");
        return;
      }
      
      // Get the category
      const category = await storage.getCategory(state.categoryId);
      if (!category) {
        await ctx.reply("❌ Error: Category not found. Please use /start to begin again.");
        return;
      }
      
      // Check if the service is closed
      if (category.isClosed) {
        await ctx.reply("⛔ This service is currently closed. Please try another service or contact an administrator.");
        return;
      }
      
      // Check for existing active tickets
      const existingTicket = await storage.getActiveTicketByUserId(user.id);
      if (existingTicket) {
        // Update state to reference the existing ticket
        state.inQuestionnaire = false;
        state.activeTicketId = existingTicket.id;
        this.setState(userId, state);
        
        await ctx.reply("ℹ️ You already have an active ticket. Your messages will be sent to that ticket.");
        return;
      }
      
      // Create the ticket
      const ticket = await storage.createTicket({
        userId: user.id,
        categoryId: state.categoryId,
        status: "pending",
        answers: state.answers
      });
      
      log(`Created ticket ${ticket.id} for user ${user.id} in category ${state.categoryId}`);
      
      // Update user state
      state.inQuestionnaire = false;
      state.activeTicketId = ticket.id;
      this.setState(userId, state);
      
      // Try to create Discord channel
      try {
        await this.bridge.createTicketChannel(ticket);
        
        await ctx.reply("✅ Your ticket has been created! You can now send messages and they will be forwarded to our support team.");
        
        // Send summary of the ticket
        const ticketSummary = [
          "**Ticket Summary**",
          `**Category:** ${category.name}`,
          ...category.questions.map((q, i) => `**${q}**\n${state.answers[i] || 'No answer provided'}`)
        ].join("\n\n");
        
        await ctx.reply(preserveMarkdown(ticketSummary), {
          parse_mode: "MarkdownV2"
        });
      } catch (error) {
        log(`Error creating Discord channel: ${error}`, "error");
        
        // Still mark ticket as created, just without channel
        await ctx.reply("✅ Your ticket has been created, but there was an issue setting up the support channel. A staff member will assist you shortly.");
      }
    } catch (error) {
      log(`Error in createTicket: ${error}`, "error");
      await ctx.reply("❌ There was an error creating your ticket. Please try again or contact an administrator.");
    }
  }

  private setupHandlers() {
    if (!this.bot) return;
    
    // Set up command handlers
    this.bot.command('ping', async (ctx) => {
      if (!ctx.from?.id) return;
      
      if (!this.checkRateLimit(ctx.from.id, 'command', 'ping')) {
        await ctx.reply("⚠️ You're sending commands too quickly. Please wait a moment.");
        return;
      }
      
      try {
        log(`Received ping command from user ${ctx.from.id}`);
        await ctx.reply("🏓 Pong! Bot is online and working.");
      } catch (error) {
        log(`Error in ping command: ${error}`, "error");
      }
    });
    
    this.bot.command('start', async (ctx) => {
      if (!ctx.from?.id) return;
      
      if (!this.checkRateLimit(ctx.from.id, 'command', 'start')) {
        await ctx.reply("⚠️ You're sending commands too quickly. Please wait a moment.");
        return;
      }
      
      try {
        const userId = ctx.from.id;
        
        // Check if user can be added (under concurrent limit)
        const canAdd = await this.checkActiveUsers(userId);
        if (!canAdd) {
          await ctx.reply("⚠️ Bot is currently at maximum capacity. Please try again in a few minutes.");
          return;
        }
        
        // Check if user is banned
        const existingUser = await storage.getUserByTelegramId(userId.toString());
        if (existingUser && existingUser.isBanned) {
          await ctx.reply(`⛔ You have been banned from using this bot${existingUser.banReason ? ` for: ${existingUser.banReason}` : ""}.`);
          return;
        }
        
        // Create user if doesn't exist
        if (!existingUser) {
          await storage.createUser({
            telegramId: userId.toString(),
            username: ctx.from.username || `user_${userId}`,
            telegramUsername: ctx.from.username,
            telegramName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ')
          });
          log(`Created new user with telegramId ${userId}`);
        }
        
        // Display category menu
        await this.handleCategoryMenu(ctx);
      } catch (error) {
        log(`Error in start command: ${error}`, "error");
        await ctx.reply("❌ Sorry, there was an error starting the bot. Please try again.");
      }
    });
    
    this.bot.command('cancel', async (ctx) => {
      if (!ctx.from?.id) return;
      
      if (!this.checkRateLimit(ctx.from.id, 'command', 'cancel')) {
        await ctx.reply("⚠️ You're sending commands too quickly. Please wait a moment.");
        return;
      }
      
      try {
        const userId = ctx.from.id;
        
        // Clear user state
        this.userStates.delete(userId);
        if (this.stateCleanups.has(userId)) {
          clearTimeout(this.stateCleanups.get(userId)!.timeout);
          this.stateCleanups.delete(userId);
        }
        
        await ctx.reply("✅ Current action canceled. Use /start to create a new ticket.");
      } catch (error) {
        log(`Error in cancel command: ${error}`, "error");
      }
    });
    
    // New proper close command to close tickets
    this.bot.command('close', async (ctx) => {
      console.log("===== /CLOSE COMMAND RECEIVED =====");
      
      if (!ctx.from?.id) {
        console.log("No user ID in close command");
        return;
      }
      
      const userId = ctx.from.id;
      
      if (!this.checkRateLimit(userId, 'command', 'close')) {
        await ctx.reply("⚠️ You're sending commands too quickly. Please wait a moment.");
        return;
      }
      
      try {
        // Find the user
        const user = await storage.getUserByTelegramId(userId.toString());
        if (!user) {
          await ctx.reply("❌ You haven't created any tickets yet. Use /start to create a ticket.");
          return;
        }
        
        // Find active ticket
        const activeTicket = await storage.getActiveTicketByUserId(user.id);
        if (!activeTicket) {
          await ctx.reply("❌ You don't have any active tickets. Use /start to create one.");
          return;
        }
        
        // Close the ticket
        await storage.updateTicketStatus(activeTicket.id, "closed");
        console.log(`Closed ticket ${activeTicket.id} for user ${user.id}`);
        
        // Move to transcripts if possible
        if (activeTicket.discordChannelId) {
          try {
            await this.bridge.moveToTranscripts(activeTicket.id);
            console.log(`Moved ticket ${activeTicket.id} to transcripts`);
          } catch (moveError) {
            console.error(`Error moving ticket to transcripts: ${moveError}`);
          }
        }
        
        // Send confirmation - THIS IS DIFFERENT FROM /CANCEL!
        await ctx.reply("✅ Your ticket has been closed! Use /start when you're ready to begin again.");
      } catch (error) {
        console.error(`Error in close command: ${error}`);
        await ctx.reply("❌ There was an error closing your ticket. Please try again later.");
      }
    });
    
    // Admin commands
    this.bot.command('ban', async (ctx) => {
      if (!ctx.from?.id) return;
      
      try {
        // Check if user is admin
        const isAdmin = await storage.isAdmin(ctx.from.id.toString());
        if (!isAdmin) {
          await ctx.reply("⛔ You don't have permission to use this command.");
          return;
        }
        
        const args = ctx.message.text.split(' ').slice(1);
        if (args.length === 0) {
          await ctx.reply("Usage: /ban [user_id] [reason]");
          return;
        }
        
        const targetId = args[0];
        const reason = args.slice(1).join(' ') || "No reason provided";
        
        const targetUser = await storage.getUserByTelegramId(targetId);
        if (!targetUser) {
          await ctx.reply(`❌ User with ID ${targetId} not found.`);
          return;
        }
        
        await storage.banUser(targetUser.id, reason, ctx.from.id.toString());
        
        await ctx.reply(`✅ User ${targetUser.username} (ID: ${targetId}) has been banned for: ${reason}`);
        
        // Notify the banned user
        try {
          if (targetUser.telegramId) {
            await this.sendMessage(
              parseInt(targetUser.telegramId),
              `⛔ You have been banned from using this bot for: ${reason}.`
            );
          }
        } catch (error) {
          log(`Error notifying banned user: ${error}`, "error");
        }
      } catch (error) {
        log(`Error in ban command: ${error}`, "error");
        await ctx.reply("❌ Error processing ban command.");
      }
    });
    
    this.bot.command('unban', async (ctx) => {
      if (!ctx.from?.id) return;
      
      try {
        // Check if user is admin
        const isAdmin = await storage.isAdmin(ctx.from.id.toString());
        if (!isAdmin) {
          await ctx.reply("⛔ You don't have permission to use this command.");
          return;
        }
        
        const args = ctx.message.text.split(' ').slice(1);
        if (args.length === 0) {
          await ctx.reply("Usage: /unban [user_id]");
          return;
        }
        
        const targetId = args[0];
        
        const targetUser = await storage.getUserByTelegramId(targetId);
        if (!targetUser) {
          await ctx.reply(`❌ User with ID ${targetId} not found.`);
          return;
        }
        
        if (!targetUser.isBanned) {
          await ctx.reply(`✅ User ${targetUser.username} is not banned.`);
          return;
        }
        
        await storage.unbanUser(targetUser.id);
        
        await ctx.reply(`✅ User ${targetUser.username} (ID: ${targetId}) has been unbanned.`);
        
        // Notify the unbanned user
        try {
          if (targetUser.telegramId) {
            await this.sendMessage(
              parseInt(targetUser.telegramId),
              "✅ You have been unbanned and can now use the bot again."
            );
          }
        } catch (error) {
          log(`Error notifying unbanned user: ${error}`, "error");
        }
      } catch (error) {
        log(`Error in unban command: ${error}`, "error");
        await ctx.reply("❌ Error processing unban command.");
      }
    });
    
    // Handle callback queries (button clicks)
    this.bot.on('callback_query', async (ctx) => {
      if (!ctx.from?.id || !ctx.callbackQuery) return;
      
      // Access data safely through the callbackQuery object
      const data = 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
      if (!data) return;
      
      if (!this.checkRateLimit(ctx.from.id, 'command')) {
        await ctx.answerCbQuery("You're clicking buttons too quickly. Please wait a moment.");
        return;
      }
      
      log(`Received callback query: ${data} from user ${ctx.from.id}`);
      
      try {
        if (data === 'back_to_main') {
          await this.handleCategoryMenu(ctx);
        } else if (data.startsWith('submenu_')) {
          const submenuId = parseInt(data.substring(8));
          await this.handleSubmenuClick(ctx, submenuId);
        } else if (data.startsWith('category_')) {
          const categoryId = parseInt(data.substring(9));
          await this.handleCategorySelection(ctx, categoryId);
        } else {
          await ctx.answerCbQuery("Unknown button action");
        }
      } catch (error) {
        log(`Error processing button click: ${error}`, "error");
        await ctx.answerCbQuery("Error processing your request");
      }
    });
    
    // Handle text messages
    this.bot.on('text', async (ctx) => {
      if (!ctx.from?.id || !ctx.message?.text) return;
      
      const userId = ctx.from.id;
      
      // First check if this is a critical command using the raw processor
      // This is a fallback mechanism for commands like /close that might fail
      try {
        const handled = await processRawMessage(ctx.message, ctx, this.bridge);
        if (handled) {
          log(`Message processed by raw handler: ${ctx.message.text}`, "debug");
          return;
        }
      } catch (error) {
        log(`Error in raw message processor: ${error}`, "error");
      }
      
      const userState = this.userStates.get(userId);
      
      // If no state, ignore the message
      if (!userState) return;
      
      try {
        // Get the user from DB
        const user = await storage.getUserByTelegramId(userId.toString());
        if (!user) return;
        
        // Check if banned
        if (user.isBanned) {
          await ctx.reply(`⛔ You are banned from using this bot${user.banReason ? ` for: ${user.banReason}` : ""}.`);
          return;
        }
        
        // If in questionnaire, handle that
        if (userState.inQuestionnaire) {
          await this.handleQuestionnaireResponse(ctx, userState);
          return;
        }
        
        // If active ticket, handle that
        if (userState.activeTicketId) {
          const ticket = await storage.getTicket(userState.activeTicketId);
          if (ticket && ticket.status !== 'closed' && ticket.status !== 'deleted') {
            await this.handleTicketMessage(ctx, user, ticket);
            return;
          }
        }
      } catch (error) {
        log(`Error processing text message: ${error}`, "error");
      }
    });
    
    // Handle photos
    this.bot.on('photo', async (ctx) => {
      if (!ctx.from?.id || !ctx.message?.photo) return;
      
      const userId = ctx.from.id;
      const userState = this.userStates.get(userId);
      
      // If no state, ignore the message
      if (!userState || !userState.activeTicketId) return;
      
      try {
        // Get the user from DB
        const user = await storage.getUserByTelegramId(userId.toString());
        if (!user) return;
        
        // Check if banned
        if (user.isBanned) {
          await ctx.reply(`⛔ You are banned from using this bot${user.banReason ? ` for: ${user.banReason}` : ""}.`);
          return;
        }
        
        // Get active ticket
        const ticket = await storage.getActiveTicketByUserId(user.id);
        if (!ticket) {
          await ctx.reply("❌ You don't have an active ticket. Use /start to create one.");
          return;
        }
        
        // Get largest photo
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        if (!photo) return;
        
        // Process caption as a message
        const caption = ctx.message.caption || "Image sent";
        await storage.createMessage({
          ticketId: ticket.id,
          content: caption,
          authorId: user.id,
          platform: "telegram",
          timestamp: new Date()
        });
        
        // Get photo file
        const file = await this.getFile(photo.file_id);
        if (!file?.file_path) {
          await ctx.reply("❌ Error processing your image. Please try again.");
          return;
        }
        
        // Get URL for the file
        const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        
        // Forward to Discord with image
        const firstName = ctx.from?.first_name || "";
        const lastName = ctx.from?.last_name || "";
        const displayName = [firstName, lastName].filter(Boolean).join(' ') || "Telegram User";
        
        // Get avatar URL
        let avatarUrl: string | undefined;
        try {
          const photos = await this.telegram.getUserProfilePhotos(ctx.from.id, 0, 1);
          if (photos && photos.total_count > 0) {
            const fileId = photos.photos[0][0].file_id;
            const avatarFile = await this.getFile(fileId);
            if (avatarFile?.file_path) {
              avatarUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${avatarFile.file_path}`;
            }
          }
        } catch (error) {
          log(`Error getting avatar: ${error}`, "error");
        }
        
        await this.bridge.forwardToDiscord(
          caption,
          ticket.id,
          displayName,
          avatarUrl,
          fileUrl,
          firstName,
          lastName
        );
        
        log(`Photo forwarded from Telegram to Discord for ticket ${ticket.id}`);
      } catch (error) {
        log(`Error processing photo: ${error}`, "error");
        await ctx.reply("❌ Error processing your image. Please try again.");
      }
    });
  }
}