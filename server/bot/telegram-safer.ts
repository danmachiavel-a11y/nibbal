/**
 * Telegram Bot Implementation for Support Ticket System
 * With enhanced null-safety using the telegram getter
 */

import { Telegraf, Context } from "telegraf";
import { BridgeManager } from "./bridge";
import { log } from "../vite";
import { storage } from "../storage";
import fetch from "node-fetch";

// Default special chars to escape in markdown
const DEFAULT_SPECIAL_CHARS = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];

// Cache for escaped text to avoid repeating the same work
const escapeCache = new Map<string, string>();

interface RateLimit {
  lastRequest: number;
  count: number;
}

class RateLimitManager {
  private userRateLimits = new Map<number, RateLimit>();
  private readonly cleanupInterval: NodeJS.Timeout;
  private readonly RATE_LIMIT_WINDOW = 60000; // 1 minute
  private readonly MAX_REQUESTS_PER_WINDOW = 30;
  private readonly COMMAND_MAX_REQUESTS = 10;
  private readonly COMMAND_SPECIFIC_LIMITS: { [key: string]: number } = {
    'ping': 3,
    'start': 3,
    'cancel': 3,
    'category': 5,
    'ban': 10,
    'unban': 10,
    'info': 10
  };

  constructor() {
    this.cleanupInterval = setInterval(() => this.cleanup(), 300000); // Clean every 5 minutes
  }

  isRateLimited(userId: number, type: 'command' | 'message' = 'message', command?: string): boolean {
    const now = Date.now();
    let limit = this.userRateLimits.get(userId);

    if (!limit) {
      limit = { lastRequest: now, count: 1 };
      this.userRateLimits.set(userId, limit);
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
    for (const [userId, limit] of this.userRateLimits.entries()) {
      if (now - limit.lastRequest > this.RATE_LIMIT_WINDOW) {
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
  let result = '';
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (specialChars.includes(char)) {
      result += '\\' + char;
    } else {
      result += char;
    }
  }
  
  return result;
}

/**
 * Preserve intentional Markdown formatting while escaping other special characters
 * This is a more sophisticated handling of markdown to allow specific formatting
 */
function preserveMarkdown(text: string): string {
  if (!text) return '';
  
  // Process text character by character to handle nested formatting
  let result = '';
  let inBold = false;
  let inItalic = false;
  let inCode = false;
  let linkText = '';
  let collectingLinkText = false;
  let linkUrl = '';
  let collectingLinkUrl = false;
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = i < text.length - 1 ? text[i + 1] : '';
    const prevChar = i > 0 ? text[i - 1] : '';
    
    // Handle markdown special sequences
    if (char === '*' && nextChar === '*' && !inCode) {
      // Bold marker
      inBold = !inBold;
      result += '**';
      i++; // Skip next asterisk
    } else if ((char === '*' || char === '_') && !inCode && !collectingLinkText && !collectingLinkUrl) {
      // Italic marker
      inItalic = !inItalic;
      result += char;
    } else if (char === '`' && !inBold && !inItalic && !collectingLinkText && !collectingLinkUrl) {
      // Code marker
      inCode = !inCode;
      result += '`';
    } else if (char === '[' && !inBold && !inItalic && !inCode && !collectingLinkText && !collectingLinkUrl) {
      // Start link text
      collectingLinkText = true;
      linkText = '';
      result += '[';
    } else if (char === ']' && collectingLinkText && !collectingLinkUrl) {
      // End link text, start link URL
      collectingLinkText = false;
      if (nextChar === '(') {
        collectingLinkUrl = true;
        linkUrl = '';
        result += ']';
      } else {
        // Not followed by (, not a proper link
        result += simpleEscape(linkText) + '\\]';
      }
    } else if (char === '(' && prevChar === ']' && collectingLinkUrl) {
      // Already handled with the ']' case
      result += '(';
    } else if (char === ')' && collectingLinkUrl) {
      // End link URL
      collectingLinkUrl = false;
      result += ')';
    } else if (collectingLinkText) {
      // Collecting link text
      linkText += char;
    } else if (collectingLinkUrl) {
      // Collecting link URL
      linkUrl += char;
      result += char;
    } else if (DEFAULT_SPECIAL_CHARS.includes(char) && !inBold && !inItalic && !inCode) {
      // Escape special characters outside of formatting
      result += '\\' + char;
    } else {
      // Regular character
      result += char;
    }
  }
  
  return result;
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
    // Implementation for handling user responses to questionnaire questions
    // (This would handle collecting answers and creating tickets)
  }

  private async createTicket(ctx: Context) {
    // Implementation for creating a new ticket from questionnaire responses
    // (This would use storage to create a ticket and send confirmation)
  }

  private setupHandlers() {
    if (!this.bot) return;
    
    // Set up all handlers for commands and messages
    // Commands: ping, start, cancel, close, info, ban, unban, etc.
    // Message handlers for tickets and questionnaires
    
    this.bot.on('text', async (ctx) => {
      // Process incoming text messages
      // This would include ticket messages and questionnaire responses
    });
    
    // Other handlers for photos, files, etc.
  }
}