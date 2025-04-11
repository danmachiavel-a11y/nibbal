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
    'switch': 5,    // Limit for switch command
    'help': 10,     // High limit for help command
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
  // Record time of last state change to help with recovery logic
  lastUpdated?: number;
  // Flag to indicate this ticket creation is coming from the /switch command
  fromSwitchCommand?: boolean;
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

  async setState(userId: number, state: UserState) {
    // Clear existing timeout if any
    if (this.stateCleanups.has(userId)) {
      clearTimeout(this.stateCleanups.get(userId)!.timeout);
    }
    
    // Update state with lastUpdated timestamp
    state.lastUpdated = Date.now();
    
    // Set the state in memory
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
    
    // Persist to database for recovery after restart
    try {
      // Try first with the userId from memory
      let user = await storage.getUser(userId);
      
      // If not found, try to look up by telegramId as string
      if (!user || !user.telegramId) {
        log(`User not found by ID ${userId}, trying to look up by Telegram ID`, "debug");
        user = await storage.getUserByTelegramId(userId.toString());
      }
      
      if (user && user.telegramId) {
        // Convert state to JSON string
        const stateStr = JSON.stringify(state);
        await storage.saveUserState(user.id, user.telegramId, stateStr);
        log(`Persisted state for user ${userId} (telegramId: ${user.telegramId}) to database`, "debug");
      } else {
        log(`Could not persist state: User ${userId} not found in database or missing telegramId`, "warn");
      }
    } catch (error) {
      log(`Error persisting state to database: ${error}`, "error");
    }
    
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
      
      // Restore user states from database
      await this.restoreUserStates();
      
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

    // Log the telegramId as a string to help diagnose issues
    const telegramIdStr = userId.toString();
    log(`Telegram ID as string: ${telegramIdStr} for ticket ${ticket.id}`);

    // Log the full ticket and user objects to help diagnose issues
    log(`Full ticket object: ${JSON.stringify(ticket)}`);
    log(`Full user object: ${JSON.stringify(user)}`);

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

      // Check if user still has this specific active ticket
      const activeTickets = await storage.getActiveTicketsByUserId(user.id);
      const isActiveTicket = activeTickets.some(t => t.id === ticket.id);
      
      if (!isActiveTicket) {
        await ctx.reply("❌ This ticket is no longer active. Use /start to create a new ticket.");
        return;
      }

      // Process message
      // Get user display name for the transcript
      const senderName = user.telegramName || user.telegramUsername || user.username || 'Telegram User';
      
      await storage.createMessage({
        ticketId: ticket.id,
        content: ctx.message.text,
        authorId: user.id,
        platform: "telegram",
        timestamp: new Date(),
        senderName: senderName
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
        lastName,
        userId
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
      const welcomeImageUrl = botConfig?.welcomeImageUrl;

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
            if (welcomeImageUrl) {
              // Send with image if URL is provided
              await ctx.replyWithPhoto(welcomeImageUrl, {
                caption: welcomeMessage,
                parse_mode: "MarkdownV2",
                reply_markup: { inline_keyboard: keyboard }
              });
            } else {
              // Send text only
              await ctx.reply(welcomeMessage, {
                parse_mode: "MarkdownV2",
                reply_markup: { inline_keyboard: keyboard }
              });
            }
          }
        } else {
          // Otherwise send a new message
          if (welcomeImageUrl) {
            // Send with image if URL is provided
            await ctx.replyWithPhoto(welcomeImageUrl, {
              caption: welcomeMessage,
              parse_mode: "MarkdownV2",
              reply_markup: { inline_keyboard: keyboard }
            });
          } else {
            // Send text only
            await ctx.reply(welcomeMessage, {
              parse_mode: "MarkdownV2",
              reply_markup: { inline_keyboard: keyboard }
            });
          }
        }
      } catch (error: any) {
        // If editing fails, send a new message
        if (error?.message?.includes("message can't be edited")) {
          if (welcomeImageUrl) {
            try {
              // Send with image if URL is provided
              await ctx.replyWithPhoto(welcomeImageUrl, {
                caption: welcomeMessage,
                parse_mode: "MarkdownV2",
                reply_markup: { inline_keyboard: keyboard }
              });
            } catch (photoError) {
              log(`Error sending welcome image: ${photoError}`, "warn");
              // Fall back to text only if image fails
              await ctx.reply(welcomeMessage, {
                parse_mode: "MarkdownV2",
                reply_markup: { inline_keyboard: keyboard }
              });
            }
          } else {
            // Send text only
            await ctx.reply(welcomeMessage, {
              parse_mode: "MarkdownV2",
              reply_markup: { inline_keyboard: keyboard }
            });
          }
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
      
      // Check if the service is closed
      if (category.isClosed) {
        await ctx.reply("⛔ This service is currently closed. Please try another service or contact an administrator.");
        return;
      }
      
      // Get the user record
      const user = await storage.getUserByTelegramId(userId.toString());
      if (!user) {
        await ctx.reply("❌ Error: User record not found. Please use /start to begin again.");
        return;
      }
      
      // Get all active tickets for this user
      const activeTickets = await storage.getActiveTicketsByUserId(user.id);
      
      // Check if there's already a ticket in the same category
      const existingTicketInCategory = activeTickets.find(ticket => ticket.categoryId === categoryId);
      
      if (existingTicketInCategory) {
        log(`User ${user.id} already has ticket ${existingTicketInCategory.id} in category ${categoryId}`);
        
        // Create a state pointing to the existing ticket
        const state: UserState = {
          categoryId,
          currentQuestion: 0,
          answers: [],
          inQuestionnaire: false,
          activeTicketId: existingTicketInCategory.id,
          lastUpdated: Date.now()
        };
        
        await this.setState(userId, state);
        
        // Notify the user they already have a ticket in this category
        await ctx.reply(`ℹ️ You already have an active ticket in this category. Only one ticket per category is allowed.`);
        
        // Provide context about using /switch
        await ctx.reply("You can use /switch to select this ticket or create a ticket in a different category.");
        
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

      // Check if we have a callback query and a message with text to edit
      const hasEditableMessage = 
        ctx.callbackQuery && 
        ctx.callbackQuery.message && 
        'text' in ctx.callbackQuery.message && 
        ctx.callbackQuery.message.text;

      if (hasEditableMessage) {
        // Try to edit existing message
        try {
          await ctx.editMessageText(preserveMarkdown(message), {
            parse_mode: "MarkdownV2",
            reply_markup: { inline_keyboard: keyboard }
          });
          
          // Answer the callback query to stop loading indicator
          if (ctx.callbackQuery) {
            await ctx.answerCbQuery();
          }
        } catch (error) {
          log(`Error editing message: ${error}`, "warn");
          // Send a new message instead
          await ctx.reply(preserveMarkdown(message), {
            parse_mode: "MarkdownV2",
            reply_markup: { inline_keyboard: keyboard }
          });
        }
      } else {
        // Either no callback query or message has no text (e.g., it's a photo with caption)
        // Always send a new message in this case
        await ctx.reply(preserveMarkdown(message), {
          parse_mode: "MarkdownV2",
          reply_markup: { inline_keyboard: keyboard }
        });
        
        // If there's a callback query, answer it
        if (ctx.callbackQuery) {
          await ctx.answerCbQuery();
        }
      }

      log(`Successfully displayed submenu options for submenu ${submenuId}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log(`Error in handleSubmenuClick: ${errorMsg}`, "error");
      await ctx.reply("❌ There was an error displaying the menu. Please try again.");
      
      // Make sure we always answer the callback query to stop the loading indicator
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery("Error loading menu").catch(() => {});
      }
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
      
      // Check if the service is closed
      if (category.isClosed) {
        await ctx.reply("⛔ This service is currently closed. Please try another service or contact an administrator.");
        // Clear the questionnaire state
        this.userStates.delete(userId);
        if (this.stateCleanups.has(userId)) {
          clearTimeout(this.stateCleanups.get(userId)!.timeout);
          this.stateCleanups.delete(userId);
        }
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
      
      // Check for existing active tickets (open, in-progress, pending, etc.)
      // Get all active tickets for this user
      const activeTickets = await storage.getActiveTicketsByUserId(user.id);
      
      // Check if there's already a ticket in the same category
      const existingTicketInCategory = activeTickets.find(ticket => ticket.categoryId === state.categoryId);
      
      if (existingTicketInCategory) {
        console.log(`User ${user.id} already has ticket ${existingTicketInCategory.id} in category ${state.categoryId}`);
        
        // Update state to reference this existing ticket
        state.inQuestionnaire = false;
        state.activeTicketId = existingTicketInCategory.id;
        this.setState(userId, state);
        
        // Notify the user they already have a ticket in this category
        await ctx.reply(`ℹ️ You already have an active ticket in this category. Only one ticket per category is allowed.`);
        
        // Provide context about using /switch
        await ctx.reply("You can use /switch to select this ticket or create a ticket in a different category.");
        
        return;
      }
      
      // If we're here, there's no ticket in this category (though the user may have tickets in other categories)
      
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
        
        await ctx.reply("✅ Your ticket has been created! You're now connected with our staff. Your messages will be sent directly to our team, and they'll respond to you here.");
        
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

  /**
   * Restore user states from database on application restart
   */
  private async restoreUserStates(): Promise<void> {
    try {
      // We need to query all active users from the database
      const users = await storage.getUsers();
      if (!users || users.length === 0) {
        log(`No users found to restore states for`, "info");
        return;
      }

      let restoredCount = 0;
      let failedCount = 0;

      for (const user of users) {
        if (!user.telegramId) continue;
        
        try {
          // Get the most recent active state from the database
          let stateString = await storage.getUserStateByTelegramId(user.telegramId);
          let state: UserState | null = null;
          let hasRestoredFromState = false;
          
          // First try to restore from saved state
          if (stateString) {
            try {
              // Parse the state
              state = JSON.parse(stateString) as UserState;
              
              // Check if the state has lastUpdated timestamp
              const lastUpdateTime = state.lastUpdated || 0;
              const stateAgeMinutes = (Date.now() - lastUpdateTime) / (1000 * 60);
              
              // Only restore state if either:
              // 1. It has a valid activeTicketId
              // 2. It's in questionnaire mode AND was updated within the last 30 minutes
              if (state.activeTicketId || (state.inQuestionnaire && stateAgeMinutes < 30)) {
                log(`State age: ${stateAgeMinutes.toFixed(2)} minutes (max 30 minutes)`, "debug");
                hasRestoredFromState = true;
              } else if (state.inQuestionnaire && stateAgeMinutes >= 30) {
                log(`[DB] Found expired questionnaire state for telegramId: ${user.telegramId} (${stateAgeMinutes.toFixed(2)} minutes old)`, "debug");
                state = null;
              } else {
                log(`[DB] Found user state for telegramId: ${user.telegramId} but it has no active ticket or questionnaire`, "debug");
                state = null;
              }
            } catch (parseError) {
              log(`Error parsing state for telegramId: ${user.telegramId}: ${parseError}`, "error");
              state = null;
            }
          } else {
            log(`[DB] No active user state found for telegramId: ${user.telegramId}`);
          }
          
          // If we couldn't restore from saved state, check if the user has an active ticket in the database
          if (!hasRestoredFromState) {
            // Look for active tickets for this user
            const activeTicket = await storage.getActiveTicketByUserId(user.id);
            if (activeTicket) {
              log(`Found active ticket ${activeTicket.id} for user ${user.id} with telegramId ${user.telegramId} but no saved state. Reconstructing state...`, "info");
              
              // Recreate state from the active ticket
              state = {
                activeTicketId: activeTicket.id,
                categoryId: activeTicket.categoryId || 1, // Default to category 1 if not set
                currentQuestion: 0,
                answers: [],
                inQuestionnaire: false,
                lastUpdated: Date.now()
              };
            }
          }
          
          // If we have a state to restore (either from saved state or active ticket)
          if (state) {
            try {
              // Use BigInt to safely handle large Telegram IDs
              const telegramUserIdBig = BigInt(user.telegramId);
              // Convert to number for internal use, but safely handle large numbers
              let telegramUserId: number;
              
              // If the ID is too large for a safe integer, use a hash of the original string
              if (telegramUserIdBig > BigInt(Number.MAX_SAFE_INTEGER)) {
                // Create a stable number representation of large IDs using hash
                const hash = require('crypto')
                  .createHash('md5')
                  .update(user.telegramId)
                  .digest('hex');
                // Use first 8 chars of hash converted to an integer
                telegramUserId = parseInt(hash.substring(0, 8), 16);
                log(`Using hash representation for large Telegram ID ${user.telegramId}: ${telegramUserId}`, "debug");
              } else {
                telegramUserId = Number(telegramUserIdBig);
              }
              
              // Store the state in memory
              this.userStates.set(telegramUserId, state);
              
              // Also setup cleanup for this state
              const timeout = setTimeout(() => {
                this.userStates.delete(telegramUserId);
                this.stateCleanups.delete(telegramUserId);
                this.activeUsers.delete(telegramUserId);
                log(`Auto-cleared state for inactive user ${telegramUserId} (Telegram ID: ${user.telegramId})`, "debug");
              }, this.STATE_TIMEOUT);
              
              this.stateCleanups.set(telegramUserId, {
                timeout,
                createdAt: Date.now()
              });
              
              this.activeUsers.add(telegramUserId);
              restoredCount++;
              
              log(`Restored state for user ${user.id} (Telegram ID: ${user.telegramId}): ${JSON.stringify(state)}`, "info");
            } catch (idError) {
              failedCount++;
              log(`Error processing Telegram ID ${user.telegramId}: ${idError}`, "error");
            }
          }
        } catch (error) {
          failedCount++;
          log(`Error restoring state for user ${user.id} (Telegram ID: ${user.telegramId}): ${error}`, "error");
        }
      }
      
      log(`Restored ${restoredCount} user states, ${failedCount} failed`, "info");
    } catch (error) {
      log(`Error in restoreUserStates: ${error}`, "error");
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
        
        // Get user and check active ticket
        const user = await storage.getUserByTelegramId(ctx.from.id.toString());
        if (!user) {
          await ctx.reply("❌ You need to use /start first to create a user account.");
          return;
        }
        
        // Check if user has an active ticket
        const userState = this.userStates.get(ctx.from.id);
        
        if (!userState?.activeTicketId) {
          // Check if we can find their active ticket in the database
          const activeTicket = await storage.getActiveTicketByUserId(user.id);
          if (!activeTicket) {
            await ctx.reply("❌ You don't have an active ticket. Use /start to create one first.");
            return;
          }
          
          // Use the active ticket from database
          await ctx.reply("🔔 Pinging staff in your active ticket...");
          await this.bridge.pingRoleForCategory(activeTicket.categoryId!, activeTicket.discordChannelId!);
          return;
        }
        
        // Get the ticket
        const ticket = await storage.getTicket(userState.activeTicketId);
        if (!ticket || ticket.status !== 'pending') {
          await ctx.reply("❌ Your active ticket was not found or is closed. Use /start to create a new one.");
          return;
        }
        
        // Check if the ticket has a Discord channel
        if (!ticket.discordChannelId) {
          await ctx.reply("❌ This ticket doesn't have a Discord channel yet. Please wait a moment and try again.");
          return;
        }
        
        // Get category for role pinging
        if (!ticket.categoryId) {
          await ctx.reply("❌ This ticket doesn't have a valid category. Please contact support.");
          return;
        }
        
        const category = await storage.getCategory(ticket.categoryId);
        if (!category) {
          await ctx.reply("❌ Service category not found. Please contact support.");
          return;
        }
        
        // Ping the Discord role or staff
        if (ticket.claimedBy) {
          // If ticket is claimed, notify the user
          await ctx.reply("🔔 This ticket is being handled by a dedicated staff member. They have been notified of your request.");
          
          // Send a message in the Discord channel to notify the staff member
          await this.bridge.sendSystemMessageToDiscord(
            ticket.discordChannelId,
            `🔔 **Attention:** The user has pinged staff for assistance in this ticket.`
          );
        } else if (category.discordRoleId) {
          // If not claimed but has a role ID, ping the role
          await ctx.reply("🔔 Pinging staff in your ticket... Someone will respond shortly.");
          await this.bridge.pingRoleForCategory(ticket.categoryId, ticket.discordChannelId);
        } else {
          // Fallback message if no role ID is set
          await ctx.reply("🔔 Staff has been notified. Someone will respond shortly.");
          await this.bridge.sendSystemMessageToDiscord(
            ticket.discordChannelId,
            `🔔 **Attention:** The user has requested assistance in this ticket.`
          );
        }
      } catch (error) {
        log(`Error in ping command: ${error}`, "error");
        await ctx.reply("❌ An error occurred while trying to ping staff. Please try again later.");
      }
    });
    
    this.bot.command('help', async (ctx) => {
      if (!ctx.from?.id) return;
      
      if (!this.checkRateLimit(ctx.from.id, 'command', 'help')) {
        await ctx.reply("⚠️ You're sending commands too quickly. Please wait a moment.");
        return;
      }
      
      try {
        const helpMessage = `
*Available Commands:*

/start - Start a new ticket
/switch - Switch between active tickets or create a new one
/close - Close your current ticket
/cancel - Cancel the current questionnaire without creating a ticket
/ping - Notify staff in your active ticket

To message support staff, simply send a message after creating a ticket.
Images/photos are also supported.
`;
        await ctx.reply(helpMessage, { parse_mode: 'Markdown' });
      } catch (error) {
        log(`Error in help command: ${error}`, "error");
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
        
        // Check if the user already has active tickets and is in one currently
        if (existingUser) {
          // Get all active tickets
          const activeTickets = await storage.getActiveTicketsByUserId(existingUser.id);
          
          if (activeTickets.length > 0) {
            log(`User ${userId} attempted to start and has ${activeTickets.length} active tickets`);
            
            // Get current state to check if they're in an active ticket
            const userState = this.userStates.get(userId);
            
            // If they have an active ticket currently selected, ask them to close it first
            if (userState?.activeTicketId) {
              const currentTicket = activeTickets.find(t => t.id === userState.activeTicketId);
              if (currentTicket) {
                await ctx.reply(
                  `❗ You're currently in an active ticket (#${currentTicket.id}). Please use /close to close this ticket before starting a new one, or use /switch to see all your active tickets.`
                );
                return;
              }
            }
            
            // If they have active tickets but none selected currently, show list and continue
            const ticketList = activeTickets.map((ticket, i) => {
              const categoryId = ticket.categoryId || 0;
              return `${i + 1}. Ticket #${ticket.id} (Category #${categoryId})`;
            }).join('\n');
            
            await ctx.reply(
              `ℹ️ You have ${activeTickets.length} active ticket(s):\n\n${ticketList}\n\n` +
              "You're now creating a new ticket. Once created, you can use /switch to change between your tickets."
            );
            
            // If there's no active state or the active ticket isn't set, create a state with no active ticket yet
            if (!this.userStates.has(userId)) {
              await this.setState(userId, {
                activeTicketId: undefined, // No active ticket selected yet
                categoryId: 0,
                currentQuestion: 0,
                answers: [],
                inQuestionnaire: false,
                lastUpdated: Date.now()
              });
            }
          }
        }
        
        // If we got here, no active tickets, so display category menu
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
        const userState = this.userStates.get(userId);
        
        // Case 1: If user has an active ticket and not in questionnaire
        if (userState?.activeTicketId && !userState.inQuestionnaire) {
          await ctx.reply("❌ You have an active ticket. The /cancel command is only for canceling ticket creation. Use /close to close your active ticket.");
          return;
        }
        
        // Case 2: If user is in a questionnaire (ticket creation process)
        if (userState?.inQuestionnaire) {
          // Clear user state
          this.userStates.delete(userId);
          if (this.stateCleanups.has(userId)) {
            clearTimeout(this.stateCleanups.get(userId)!.timeout);
            this.stateCleanups.delete(userId);
          }
          
          await ctx.reply("✅ Ticket creation canceled. Use /start to create a new order.");
          return;
        }
        
        // Case 3: User is not in ticket creation or active ticket
        await ctx.reply("ℹ️ You are not currently creating a ticket. Use /start to begin a new order.");
        
      } catch (error) {
        log(`Error in cancel command: ${error}`, "error");
      }
    });
    
    // Switch command to change between tickets
    this.bot.command('switch', async (ctx) => {
      if (!ctx.from?.id) return;
      const userId = ctx.from.id;
      
      if (!this.checkRateLimit(userId, 'command', 'switch')) {
        await ctx.reply("⚠️ You're sending commands too quickly. Please wait a moment.");
        return;
      }
      
      try {
        const userState = this.userStates.get(userId);
        
        // Check if user is in a questionnaire
        if (userState?.inQuestionnaire) {
          await ctx.reply("❌ You are currently filling out a questionnaire. Please cancel it first by typing 'cancel' before switching tickets.");
          return;
        }
        
        // Get user from database
        const user = await storage.getUserByTelegramId(userId.toString());
        if (!user) {
          await ctx.reply("❌ Error: User not found. Please use /start to begin again.");
          return;
        }
        
        // Get all active tickets for this user
        const userTickets = await storage.getActiveTicketsByUserId(user.id);
        
        if (!userTickets || userTickets.length === 0) {
          // No active tickets, inform user
          await ctx.reply("❌ You don't have any active tickets. Use /start to create a new ticket.");
          return;
        }
        
        // Create buttons for each ticket
        const buttons = [];
        const currentTicketId = userState?.activeTicketId;
        
        // Get the categories for all tickets upfront to avoid multiple DB calls
        const categoryIds = [...new Set(userTickets.map(t => t.categoryId).filter(id => id !== null))];
        const categoriesMap = new Map();
        
        for (const categoryId of categoryIds) {
          const category = await storage.getCategory(categoryId!);
          if (category) {
            categoriesMap.set(categoryId, category);
          }
        }
        
        // Create a button for each ticket
        for (const ticket of userTickets) {
          const category = categoriesMap.get(ticket.categoryId);
          const categoryName = category ? category.name : "Unknown category";
          
          // Mark currently active ticket
          const isActive = currentTicketId === ticket.id;
          const buttonLabel = isActive 
            ? `✅ #${ticket.id}: ${categoryName} (current)` 
            : `#${ticket.id}: ${categoryName}`;
          
          buttons.push([{
            text: buttonLabel,
            callback_data: `switch_${ticket.id}`
          }]);
        }
        
        // Add button for creating a new ticket
        buttons.push([{
          text: "➕ Create New Ticket",
          callback_data: "switch_new"
        }]);
        
        // Format ticket list
        let ticketList = "🎫 *Your active tickets:*\n\n";
        ticketList += "Please select a ticket to switch to, or create a new one:";
        
        // Send list with inline keyboard buttons
        await ctx.reply(ticketList, { 
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: buttons
          }
        });
        
        // Store expectation of ticket selection in user state
        if (userState) {
          userState.inQuestionnaire = false;  // Make sure not in questionnaire mode
          await this.setState(userId, userState);
        }
      } catch (error) {
        log(`Error in /switch command: ${error}`, "error");
        await ctx.reply("❌ An error occurred while retrieving your tickets. Please try again later.");
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
      console.log(`Processing /close command for user ${userId}`);
      
      if (!this.checkRateLimit(userId, 'command', 'close')) {
        await ctx.reply("⚠️ You're sending commands too quickly. Please wait a moment.");
        return;
      }
      
      try {
        // Check if the user is in a questionnaire
        const userMemoryState = this.userStates.get(userId);
        
        // Handle /close as /cancel if user is in a questionnaire
        if (userMemoryState?.inQuestionnaire) {
          console.log(`User ${userId} is in a questionnaire, handling /close as /cancel`);
          
          // Clear user state, just like /cancel does
          this.userStates.delete(userId);
          if (this.stateCleanups.has(userId)) {
            clearTimeout(this.stateCleanups.get(userId)!.timeout);
            this.stateCleanups.delete(userId);
          }
          
          // Delete state from database as well
          try {
            await storage.deactivateUserState(userId.toString());
          } catch (stateError) {
            console.log(`Error clearing persisted state: ${stateError}`);
          }
          
          await ctx.reply("✅ Ticket creation canceled. Use /start to create a new order.");
          return;
        }
        
        // If not in questionnaire, process as normal close command
        // Find the user
        const user = await storage.getUserByTelegramId(userId.toString());
        if (!user) {
          console.log(`User with telegram ID ${userId} not found in database`);
          await ctx.reply("❌ You haven't created any tickets yet. Use /start to create a ticket.");
          return;
        }
        console.log(`Found user in database: ${JSON.stringify(user)}`);
        
        // Get all active tickets for this user
        const activeTickets = await storage.getActiveTicketsByUserId(user.id);
        
        if (activeTickets.length === 0) {
          console.log(`No active tickets found for user ${user.id}`);
          
          // Check if there are any tickets with Discord channels that might be miscategorized
          console.log(`Checking for any tickets with Discord channels for user ${user.id}`);
          const allUserTickets = await storage.getTicketsByUserId(user.id);
          const ticketsWithDiscordChannels = allUserTickets.filter(t => 
            t.discordChannelId && 
            ['closed', 'deleted', 'transcript', 'completed'].indexOf(t.status) === -1
          );
          
          if (ticketsWithDiscordChannels.length > 0) {
            console.log(`Found ${ticketsWithDiscordChannels.length} tickets with Discord channels: ${JSON.stringify(ticketsWithDiscordChannels)}`);
            const mostRecentTicket = ticketsWithDiscordChannels[0]; // Already sorted by ID desc
            
            await ctx.reply(`🔎 No active tickets found in the database, but I found a Discord channel that may be associated with your account. Attempting to close ticket #${mostRecentTicket.id}...`);
            
            // Update the ticket status to closed
            await storage.updateTicketStatus(mostRecentTicket.id, "closed");
            console.log(`Updated ticket ${mostRecentTicket.id} status to closed`);
            
            // Try to move to transcripts if applicable
            if (mostRecentTicket.discordChannelId) {
              try {
                await this.bridge.moveToTranscripts(mostRecentTicket.id);
                await ctx.reply("✅ The Discord channel has been moved to transcripts. Use /start to create a new ticket if needed.");
              } catch (error) {
                console.error(`Error moving channel to transcripts: ${error}`);
                await ctx.reply("✅ The ticket has been marked as closed, but there was an error moving the Discord channel. Use /start to create a new ticket if needed.");
              }
            } else {
              await ctx.reply("✅ The ticket has been marked as closed. Use /start to create a new ticket if needed.");
            }
            return;
          }
          
          // If no tickets with Discord channels found, show the standard message
          await ctx.reply("❌ You don't have any active tickets. Use /start to create one.");
          return;
        }
        
        // Get the active ticket ID from user's memory state
        const currentTicketId = userMemoryState?.activeTicketId;
        
        // If user has multiple active tickets and none is selected in state, ask them which one to close
        if (activeTickets.length > 1 && !currentTicketId) {
          // Create buttons for each ticket
          const buttons = [];
          
          // Get the categories for all tickets upfront to avoid multiple DB calls
          const categoryIds = [...new Set(activeTickets.map(t => t.categoryId).filter(id => id !== null))];
          const categoriesMap = new Map();
          
          for (const categoryId of categoryIds) {
            const category = await storage.getCategory(categoryId!);
            if (category) {
              categoriesMap.set(categoryId, category);
            }
          }
          
          // Create a button for each ticket
          for (const ticket of activeTickets) {
            const category = categoriesMap.get(ticket.categoryId);
            const categoryName = category ? category.name : "Unknown category";
            const buttonLabel = `#${ticket.id}: ${categoryName}`;
            
            buttons.push([{
              text: buttonLabel,
              callback_data: `close_${ticket.id}`
            }]);
          }
          
          // Format ticket list
          let ticketList = "🎫 *You have multiple active tickets. Which one would you like to close?*\n\n";
          ticketList += "Please select a ticket to close:";
          
          // Send list with inline keyboard buttons
          await ctx.reply(ticketList, {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: buttons
            }
          });
          
          return;
        }
        
        // If user has a selected ticket in memory state or just one active ticket, close that one
        const ticketToClose = currentTicketId 
          ? activeTickets.find(t => t.id === currentTicketId) 
          : activeTickets[0];
        
        if (!ticketToClose) {
          console.log(`Current ticket ID ${currentTicketId} not found in active tickets`);
          await ctx.reply("❌ Could not find your selected ticket. Use /switch to select an active ticket first.");
          return;
        }
        
        console.log(`Found active ticket to close: ${JSON.stringify(ticketToClose)}`);
        
        // Close the ticket
        console.log(`Attempting to update ticket status to 'closed' for ticket ID ${ticketToClose.id}`);
        await storage.updateTicketStatus(ticketToClose.id, "closed");
        console.log(`Database update completed for ticket ${ticketToClose.id}`);
        
        // Clear the user's active ticket from memory state if it matches
        if (userMemoryState && userMemoryState.activeTicketId === ticketToClose.id) {
          console.log(`Clearing active ticket ${ticketToClose.id} from user ${userId} memory state`);
          userMemoryState.activeTicketId = undefined;
          await this.setState(userId, userMemoryState);
        }
        
        // Verify the ticket was actually closed
        const verifyTicket = await storage.getTicket(ticketToClose.id);
        console.log(`Verification after update: Ticket ${ticketToClose.id} status is now ${verifyTicket?.status}`);
        
        // Move to transcripts if possible
        if (ticketToClose.discordChannelId) {
          try {
            console.log(`Ticket has Discord channel ID: ${ticketToClose.discordChannelId}, attempting to move to transcripts`);
            
            // Get category for transcript category ID
            const category = await storage.getCategory(ticketToClose.categoryId!);
            console.log(`Category for ticket: ${JSON.stringify(category)}`);
            
            if (category && category.transcriptCategoryId) {
              await this.bridge.moveToTranscripts(ticketToClose.id);
              console.log(`Successfully moved ticket ${ticketToClose.id} to transcripts category ${category.transcriptCategoryId}`);
              await ctx.reply("✅ Your ticket has been closed. Use /start when you're ready to create a new ticket.");
            } else {
              console.warn(`No transcript category found for category ${ticketToClose.categoryId}`);
              await ctx.reply("✅ Your ticket has been closed. Use /start when you're ready to create a new ticket.");
            }
          } catch (moveError) {
            console.error(`Error moving ticket to transcripts: ${moveError}`);
            await ctx.reply("✅ Your ticket has been closed. Use /start when you're ready to create a new ticket.");
          }
        } else {
          console.log(`Ticket ${ticketToClose.id} has no Discord channel associated, skipping transcript move`);
          await ctx.reply("✅ Your ticket has been closed. Use /start when you're ready to create a new ticket.");
        }
      } catch (error) {
        console.error(`Error in close command: ${error}`);
        await ctx.reply("❌ There was an error closing your ticket. Please try again later.");
      }
    });
    
    // Emergency close command for admins
    this.bot.command('emergency_close', async (ctx) => {
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
          await ctx.reply("Usage: /emergency_close [discord_channel_id]");
          return;
        }
        
        const channelId = args[0];
        
        await ctx.reply(`🔄 Attempting emergency close for Discord channel ID: ${channelId}...`);
        
        // Get the ticket with this Discord channel ID
        const ticket = await storage.getTicketByDiscordChannel(channelId);
        
        if (!ticket) {
          await ctx.reply(`❌ No ticket found with Discord channel ID: ${channelId}`);
          return;
        }
        
        await ctx.reply(`🔍 Found ticket #${ticket.id} with status '${ticket.status}' for user ID: ${ticket.userId}`);
        
        // Close the ticket
        await storage.updateTicketStatus(ticket.id, "closed");
        
        // If the user who created this ticket has an active state with this ticket,
        // clear it from their state 
        try {
          if (ticket.userId) { // Make sure we have a valid userId
            // Get the user who created this ticket
            const ticketUser = await storage.getUser(ticket.userId);
            if (ticketUser && ticketUser.telegramId) {
              const telegramId = parseInt(ticketUser.telegramId);
              const userState = this.userStates.get(telegramId);
              
              if (userState && userState.activeTicketId === ticket.id) {
                console.log(`Clearing active ticket ${ticket.id} from user ${telegramId} memory state during emergency close`);
                userState.activeTicketId = undefined;
                await this.setState(telegramId, userState);
              }
            }
          }
        } catch (stateError) {
          console.error(`Error clearing user state during emergency close: ${stateError}`);
          // Don't interrupt the main command flow for state cleanup errors
        }
        
        await ctx.reply(`✅ Successfully closed ticket #${ticket.id}`);
        
        // Try to move to transcripts
        if (ticket.categoryId) {
          try {
            // Get category for transcript category ID
            const category = await storage.getCategory(ticket.categoryId);
            
            if (category && category.transcriptCategoryId) {
              await this.bridge.moveToTranscripts(ticket.id);
              await ctx.reply(`✅ Successfully moved ticket to transcripts category: ${category.transcriptCategoryId}`);
            } else {
              await ctx.reply("⚠️ No transcript category found for this ticket's category.");
            }
          } catch (error) {
            await ctx.reply(`⚠️ Error moving ticket to transcripts: ${error}`);
          }
        }
      } catch (error) {
        log(`Error in emergency_close command: ${error}`, "error");
        await ctx.reply(`❌ Error processing emergency close command: ${error}`);
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
        } else if (data.startsWith('close_')) {
          // Handle ticket closing from buttons
          const ticketId = parseInt(data.substring(6));
          const userId = ctx.from.id;
          
          // Get user from database
          const user = await storage.getUserByTelegramId(userId.toString());
          if (!user) {
            await ctx.answerCbQuery("Error: User not found");
            return;
          }
          
          try {
            // Check if the ticket exists and belongs to this user
            const ticket = await storage.getTicket(ticketId);
            
            if (!ticket) {
              await ctx.answerCbQuery(`Ticket #${ticketId} not found`);
              return;
            }
            
            // Check if the ticket belongs to this user
            if (ticket.userId !== user.id) {
              await ctx.answerCbQuery(`Ticket #${ticketId} does not belong to you`);
              return;
            }
            
            // Close the ticket
            await storage.updateTicketStatus(ticket.id, "closed");
            await ctx.answerCbQuery(`Closed ticket #${ticketId}`);
            
            // Clear the user's active ticket from memory state if it matches
            const userState = this.userStates.get(userId);
            if (userState && userState.activeTicketId === ticket.id) {
              userState.activeTicketId = undefined;
              await this.setState(userId, userState);
            }
            
            // Move to transcripts if possible
            if (ticket.discordChannelId && ticket.categoryId) {
              try {
                const category = await storage.getCategory(ticket.categoryId);
                
                if (category && category.transcriptCategoryId) {
                  await this.bridge.moveToTranscripts(ticket.id);
                  await ctx.reply(`✅ Ticket #${ticket.id} has been closed. Use /switch to select another active ticket or /start to create a new one.`);
                } else {
                  await ctx.reply(`✅ Ticket #${ticket.id} has been closed. Use /switch to select another active ticket or /start to create a new one.`);
                }
              } catch (error) {
                await ctx.reply(`✅ Ticket #${ticket.id} has been closed. Use /switch to select another active ticket or /start to create a new one.`);
              }
            } else {
              await ctx.reply(`✅ Ticket #${ticket.id} has been closed. Use /switch to select another active ticket or /start to create a new one.`);
            }
          } catch (error) {
            log(`Error closing ticket: ${error}`, "error");
            await ctx.answerCbQuery("Error closing ticket");
            await ctx.reply("❌ Error closing ticket. Please try again later.");
          }
        } else if (data.startsWith('switch_')) {
          // Handle ticket switching buttons
          const switchOption = data.substring(7);
          const userId = ctx.from.id;
          
          // Get user from database
          const user = await storage.getUserByTelegramId(userId.toString());
          if (!user) {
            log(`User with telegram ID ${userId} not found in database for switch operation`, "error");
            await ctx.answerCbQuery("Error: User not found");
            return;
          }
          
          // Get current user state
          let userState = this.userStates.get(userId);
          if (!userState) {
            // If no state in memory, create a basic one
            log(`Creating new user state for user ${userId} as none was found`, "debug");
            userState = {
              activeTicketId: undefined, // Use undefined instead of null
              categoryId: 0,
              currentQuestion: 0,
              answers: [],
              inQuestionnaire: false,
              lastUpdated: Date.now()
            };
            this.userStates.set(userId, userState);
          }
          
          if (switchOption === 'new') {
            // User wants to create a new ticket
            await ctx.answerCbQuery("Creating a new ticket");
            
            // Set fromSwitchCommand flag to true to bypass the "already has ticket" check
            // userState is guaranteed to be defined here since we initialized it above
            userState.fromSwitchCommand = true;
            await this.setState(userId, userState);
            
            await ctx.reply("✅ Let's create your new support ticket. Please select a category from the options displayed.");
            await this.handleCategoryMenu(ctx);
          } else {
            // User wants to switch to an existing ticket
            const ticketId = parseInt(switchOption);
            
            try {
              // Check if the ticket exists and belongs to this user
              const ticket = await storage.getTicket(ticketId);
              
              if (!ticket) {
                await ctx.answerCbQuery(`Ticket #${ticketId} not found`);
                return;
              }
              
              // Check if the ticket belongs to this user
              if (ticket.userId !== user.id) {
                await ctx.answerCbQuery(`Ticket #${ticketId} does not belong to you`);
                return;
              }
              
              // Check if the ticket is active
              if (ticket.status !== "pending") {
                await ctx.answerCbQuery(`Ticket #${ticketId} is not active (status: ${ticket.status})`);
                return;
              }
              
              // Switch to this ticket
              userState.activeTicketId = ticketId;
              userState.categoryId = ticket.categoryId || 0;
              await this.setState(userId, userState);
              
              // Get category name for confirmation message
              const category = await storage.getCategory(ticket.categoryId || 0);
              const categoryName = category ? category.name : "Unknown category";
              
              await ctx.answerCbQuery(`Switched to ticket #${ticketId}`);
              
              // Get all active tickets again to display the updated menu
              const userTickets = await storage.getActiveTicketsByUserId(user.id);
              
              // Create updated buttons list with the new selected ticket
              const updatedButtons = [];
              
              // Get categories info for updating the menu
              const categoryIds = [...new Set(userTickets.map(t => t.categoryId).filter(id => id !== null))];
              const categoriesMap = new Map();
              
              for (const catId of categoryIds) {
                const cat = await storage.getCategory(catId!);
                if (cat) {
                  categoriesMap.set(catId, cat);
                }
              }
              
              // Create a button for each ticket with updated status
              for (const t of userTickets) {
                const cat = categoriesMap.get(t.categoryId);
                const catName = cat ? cat.name : "Unknown category";
                
                // Mark currently active ticket
                const isActive = ticketId === t.id;
                const buttonLabel = isActive 
                  ? `✅ #${t.id}: ${catName} (current)` 
                  : `#${t.id}: ${catName}`;
                
                updatedButtons.push([{
                  text: buttonLabel,
                  callback_data: `switch_${t.id}`
                }]);
              }
              
              // Add button for creating a new ticket
              updatedButtons.push([{
                text: "➕ Create New Ticket",
                callback_data: "switch_new"
              }]);
              
              // Try to edit the original message with updated buttons
              // First need to check if we can get the original message ID
              const messageId = ctx.callbackQuery?.message?.message_id;
              if (messageId) {
                try {
                  // Update the inline keyboard with the new active ticket
                  await ctx.editMessageReplyMarkup({
                    inline_keyboard: updatedButtons
                  });
                } catch (editError) {
                  log(`Could not update switch menu: ${editError}`, "warn");
                  // Continue even if we couldn't update the menu
                }
              }
              
              // Send confirmation message
              await ctx.reply(`✅ Switched to ticket #${ticketId} (${categoryName}). You can now continue your conversation here.`);
              
              // Send notification to Discord
              try {
                // Check if we have all the data needed for this ticket
                if (!ticket.discordChannelId) {
                  log(`Cannot send Discord notification: ticket #${ticketId} has no Discord channel ID`, "warn");
                  return;
                }

                // Get user display name
                const firstName = ctx.from?.first_name || "";
                const lastName = ctx.from?.last_name || "";
                const displayName = [firstName, lastName].filter(Boolean).join(' ') || "Telegram User";
                
                // Get all active tickets for this user
                const userTickets = await storage.getActiveTicketsByUserId(user.id);
                log(`User has ${userTickets.length} active tickets for Discord notification`, "debug");
                
                // Get the ticket we're switching FROM if available
                // Get it from state first, then try to find other active tickets if none is in state
                let previousTicketId = userState.activeTicketId;
                const isPreviousSameAsCurrent = previousTicketId === ticketId;
                
                // Get all OTHER active tickets (that are not the current one)
                const otherTickets = userTickets.filter(t => t.id !== ticketId);
                log(`Found ${otherTickets.length} other active tickets`, "debug");
                
                // Always send a notification to the current channel
                const message = `**Note:** User switched to this ticket`;
                
                log(`Sending Discord notification to current channel: ${ticket.discordChannelId}`, "debug");
                await this.bridge.sendSystemMessageToDiscord(
                  ticket.discordChannelId,
                  message
                );
                
                // Now notify all OTHER tickets that the user is no longer viewing them
                for (const otherTicket of otherTickets) {
                  if (otherTicket.discordChannelId) {
                    log(`Sending Discord notification to other channel: ${otherTicket.discordChannelId}`, "debug");
                    
                    // Create a button to force the user back to this ticket
                    const buttonId = `force_ticket:${user.telegramId}:${otherTicket.id}:${displayName}`;
                    
                    // Create message content without the command instruction
                    const messageContent = `**Note:** The user has switched to ticket #${ticketId} (${categoryName}) and may not see messages here anymore.`;
                    
                    // Use specialized method to send message with button
                    await this.bridge.getDiscordBot().sendMessage(
                      otherTicket.discordChannelId,
                      {
                        content: messageContent,
                        username: "System",
                        avatarURL: "https://cdn.discordapp.com/embed/avatars/0.png",
                        components: [{
                          type: 1, // Action row type
                          components: [{
                            type: 2, // Button type
                            style: 1, // Primary button style
                            label: "Force Back", // Shortened label as requested
                            custom_id: buttonId
                          }]
                        }]
                      },
                      "System"
                    );
                  }
                }
              } catch (error) {
                log(`Error sending Discord notification for ticket switch: ${error}`, "warn");
                // Don't block the main flow if Discord notification fails
              }
            } catch (error) {
              log(`Error switching tickets: ${error}`, "error");
              await ctx.answerCbQuery("Error switching tickets");
              await ctx.reply("❌ Error switching tickets. Please try again later.");
            }
          }
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
      
      // Get current state if it exists
      const initialState = this.userStates.get(userId);
      let userState = initialState ? { ...initialState } : undefined;
      log(`Initial user state check: ${JSON.stringify(userState)}`);
      
      try {
        // Get the user from DB
        const user = await storage.getUserByTelegramId(userId.toString());
        if (!user) {
          log(`No user found for telegramId: ${userId}, ignoring message`, "warn");
          return;
        }
        
        // If no state, check if the user has an active ticket in the database
        // This handles cases after bot restart where states aren't fully loaded
        if (!userState) {
          log(`No user state found for ${userId}, but user exists in DB. Checking for active tickets...`);
          
          // Check if user has an active ticket
          const activeTicket = await storage.getActiveTicketByUserId(user.id);
          if (activeTicket) {
            log(`Found active ticket ${activeTicket.id} for user ${userId} without loaded state, reconstructing state`);
            
            // Recreate state
            const newState = {
              activeTicketId: activeTicket.id,
              categoryId: activeTicket.categoryId!,
              currentQuestion: 0,
              answers: [],
              inQuestionnaire: false,
              lastUpdated: Date.now()
            };
            
            // Update our local copy and store in the global state
            userState = newState;
            await this.setState(userId, newState);
          } else {
            log(`No active tickets found for user ${userId}, ignoring message`, "info");
            await ctx.reply("You don't have an active ticket. Use /start to create a new one.");
            return;
          }
        }
        
        // Check if banned
        if (user.isBanned) {
          await ctx.reply(`⛔ You are banned from using this bot${user.banReason ? ` for: ${user.banReason}` : ""}.`);
          return;
        }
        
        // If in questionnaire, handle that
        if (userState.inQuestionnaire) {
          // Check if category is closed
          const category = await storage.getCategory(userState.categoryId);
          if (category && category.isClosed) {
            await ctx.reply("⛔ This service is currently closed. Please try another service or contact an administrator.");
            // Clear the questionnaire state
            userState.inQuestionnaire = false;
            this.setState(userId, userState);
            return;
          }
          
          await this.handleQuestionnaireResponse(ctx, userState);
          return;
        }
        
        // Handle ticket switching after /switch command
        // Check if user has just requested the switch command and is now selecting a ticket
        const lastCommand = ctx.message.text.trim().toLowerCase();
        
        // Check if the input is a ticket ID number or "new"
        if (lastCommand === "new") {
          // User wants to create a new ticket, reset state and redirect to /start
          await ctx.reply("✅ Let's create your new support ticket. Please select a category from the options displayed.");
          await this.handleCategoryMenu(ctx);
          return;
        } else if (/^\d+$/.test(lastCommand)) {
          // User is trying to switch to a specific ticket ID
          const ticketId = parseInt(lastCommand);
          
          try {
            // Check if the ticket belongs to this user
            const ticket = await storage.getTicket(ticketId);
            
            if (!ticket) {
              await ctx.reply(`❌ Ticket #${ticketId} not found.`);
              return;
            }
            
            // Check if the ticket belongs to this user
            if (ticket.userId !== user.id) {
              await ctx.reply(`❌ Ticket #${ticketId} does not belong to you.`);
              return;
            }
            
            // Check if the ticket is active
            if (ticket.status !== "pending") {
              await ctx.reply(`❌ Ticket #${ticketId} is not active (status: ${ticket.status}).`);
              return;
            }
            
            // Switch to this ticket
            userState.activeTicketId = ticketId;
            userState.categoryId = ticket.categoryId!;
            await this.setState(userId, userState);
            
            // Get category name for confirmation message
            const category = await storage.getCategory(ticket.categoryId!);
            const categoryName = category ? category.name : "Unknown category";
            
            await ctx.reply(`✅ Switched to ticket #${ticketId} (${categoryName}). You can now continue your conversation here.`);
            return;
          } catch (error) {
            log(`Error switching tickets: ${error}`, "error");
            await ctx.reply("❌ Error switching tickets. Please try again later.");
            return;
          }
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
      // Get current state if it exists
      const originalState = this.userStates.get(userId);
      let userState = originalState ? { ...originalState } : undefined;
      log(`Photo received - Initial user state check: ${JSON.stringify(userState)}`);
      
      try {
        // Get the user from DB
        const user = await storage.getUserByTelegramId(userId.toString());
        if (!user) {
          log(`No user found for telegramId: ${userId}, ignoring photo`, "warn");
          return;
        }
        
        // If no state, check if the user has an active ticket in the database
        // This handles cases after bot restart where states aren't fully loaded
        if (!userState || !userState.activeTicketId) {
          log(`No valid user state found for ${userId}, but user exists in DB. Checking for active tickets...`);
          
          // Check if user has an active ticket
          const activeTicket = await storage.getActiveTicketByUserId(user.id);
          if (activeTicket) {
            log(`Found active ticket ${activeTicket.id} for user ${userId} without loaded state, reconstructing state`);
            
            // Recreate state
            const newState = {
              activeTicketId: activeTicket.id,
              categoryId: activeTicket.categoryId!,
              currentQuestion: 0,
              answers: [],
              inQuestionnaire: false,
              lastUpdated: Date.now()
            };
            
            // Update our local copy and store in the global state
            userState = newState;
            await this.setState(userId, newState);
          } else {
            log(`No active tickets found for user ${userId}, ignoring photo`, "info");
            await ctx.reply("You don't have an active ticket. Use /start to create a new one.");
            return;
          }
        }
        
        // Check if banned
        if (user.isBanned) {
          await ctx.reply(`⛔ You are banned from using this bot${user.banReason ? ` for: ${user.banReason}` : ""}.`);
          return;
        }
        
        // Use the already defined userState
        let activeTicketId = userState?.activeTicketId;
        
        // Get all active tickets
        const activeTickets = await storage.getActiveTicketsByUserId(user.id);
        if (activeTickets.length === 0) {
          await ctx.reply("❌ You don't have any active tickets. Use /start to create one.");
          return;
        }
        
        // If the user isn't currently in a ticket but has active tickets, ask them to select one
        if (!activeTicketId) {
          if (activeTickets.length === 1) {
            // If there's only one active ticket, use that one
            activeTicketId = activeTickets[0].id;
          } else {
            await ctx.reply("ℹ️ You have multiple active tickets. Please use /switch to select a ticket before sending photos.");
            return;
          }
        }
        
        // Get the specific ticket
        const ticket = activeTickets.find(t => t.id === activeTicketId);
        if (!ticket) {
          await ctx.reply("❌ The selected ticket is no longer active. Use /start to create a new one or /switch to select another.");
          return;
        }
        
        // Get largest photo
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        if (!photo) return;
        
        // Process caption as a message
        // Only use "Image sent" as a database placeholder, not as the actual caption for Discord
        const databaseCaption = ctx.message.caption || "Image sent";
        // For Discord, either use the actual caption or an empty string (not "Image sent")
        const discordCaption = ctx.message.caption || "";
        
        // Store the message in the database
        // Get user display name for the transcript
        const senderName = user.telegramName || user.telegramUsername || user.username || 'Telegram User';
        
        await storage.createMessage({
          ticketId: ticket.id,
          content: databaseCaption,
          authorId: user.id,
          platform: "telegram",
          timestamp: new Date(),
          senderName: senderName
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
        
        // Use the variable we defined earlier for Discord caption
        await this.bridge.forwardToDiscord(
          discordCaption, // Use empty string instead of "Image sent" when there's no caption
          ticket.id,
          displayName,
          avatarUrl,
          fileUrl,
          firstName,
          lastName,
          ctx.from.id
        );
        
        log(`Photo forwarded from Telegram to Discord for ticket ${ticket.id}`);
      } catch (error) {
        log(`Error processing photo: ${error}`, "error");
        await ctx.reply("❌ Error processing your image. Please try again.");
      }
    });
  }
}