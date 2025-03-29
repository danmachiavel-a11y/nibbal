import { Telegraf, Context } from "telegraf";
import { storage } from "../storage";
import { BridgeManager } from "./bridge";
import { log } from "../vite";
import fetch from 'node-fetch';

// Add proper type definitions for rate limiting
interface RateLimit {
  timestamp: number;
  count: number;
}

interface CommandRateLimit extends RateLimit {
  command: string;
}

interface MessageRateLimit extends RateLimit {
  blockedUntil?: number;
}

// Add with other interfaces
interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

// Proper type safety for user states
interface UserState {
  categoryId: number;
  currentQuestion: number;
  answers: string[];
  inQuestionnaire: boolean;
  rateLimits: {
    commands: Map<string, CommandRateLimit>;
    messages: MessageRateLimit;
    bucket: TokenBucket;
  };
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

// Add at the top with other constants
const RATE_LIMIT = {
  COMMAND: {
    WINDOW: parseInt(process.env.RATE_LIMIT_COMMAND_WINDOW || "60000", 10), // 1 minute default
    MAX_COUNT: parseInt(process.env.RATE_LIMIT_COMMAND_MAX_COUNT || "5", 10) // 5 commands default
  },
  MESSAGE: {
    WINDOW: parseInt(process.env.RATE_LIMIT_MESSAGE_WINDOW || "2000", 10), // 2 seconds default
    MAX_COUNT: parseInt(process.env.RATE_LIMIT_MESSAGE_MAX_COUNT || "10", 10), // 10 messages default
    BLOCK_DURATION: parseInt(process.env.RATE_LIMIT_MESSAGE_BLOCK_DURATION || "300000", 10) // 5 minutes default
  }
};

// Add with other constants
const USER_STATE_CLEANUP_INTERVAL = 300000; // 5 minutes
const USER_INACTIVE_TIMEOUT = 3600000; // 1 hour
const MAX_INACTIVE_STATES = 1000; // Maximum number of stored states

function escapeMarkdown(text: string): string {
  if (!text) return '';
  const specialChars = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
  
  let escaped = text;
  // Properly escape characters - the issue was the incorrect regex pattern
  for (const char of specialChars) {
    // Create a global regex that matches the character literally
    const regex = new RegExp(escapeRegExp(char), 'g');
    escaped = escaped.replace(regex, '\\' + char);
  }
  
  return escaped;
}

// Helper function to escape special characters in regex
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class TelegramBot {
  private bot: Telegraf | null = null;
  private bridge: BridgeManager;
  private userStates: Map<number, UserState> = new Map();
  private stateCleanups: Map<number, StateCleanup> = new Map();
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

  private cleanupRateLimits(userId: number): void {
    const state = this.userStates.get(userId);
    if (!state) return;

    const now = Date.now();

    // Clean up command rate limits
    for (const [command, limit] of state.rateLimits.commands.entries()) {
      if (now - limit.timestamp > RATE_LIMIT.COMMAND.WINDOW) {
        state.rateLimits.commands.delete(command);
        log(`Cleaned up rate limit for command ${command} for user ${userId}`);
      }
    }

    // Clean up message rate limits
    const messageLimit = state.rateLimits.messages;
    if (messageLimit.blockedUntil && now > messageLimit.blockedUntil) {
      state.rateLimits.messages = { timestamp: now, count: 0 };
      log(`Reset message rate limit block for user ${userId}`);
    } else if (now - messageLimit.timestamp > RATE_LIMIT.MESSAGE.WINDOW) {
      state.rateLimits.messages = { timestamp: now, count: 0 };
      log(`Reset message rate limit count for user ${userId}`);
    }
  }

  private checkRateLimit(userId: number, type: 'command' | 'message', command?: string): boolean {
    const state = this.userStates.get(userId);
    if (!state) return true;

    // Clean up old rate limits first
    this.cleanupRateLimits(userId);

    const now = Date.now();

    if (type === 'command' && command) {
      const limit = state.rateLimits.commands.get(command);
      if (!limit || now - limit.timestamp > RATE_LIMIT.COMMAND.WINDOW) {
        state.rateLimits.commands.set(command, { timestamp: now, count: 1, command });
        return true;
      }

      if (limit.count >= RATE_LIMIT.COMMAND.MAX_COUNT) {
        log(`Rate limit exceeded for command ${command} by user ${userId}`);
        return false;
      }

      limit.count++;
      return true;
    }

    if (type === 'message') {
      // Initialize bucket if doesn't exist
      if (!state.rateLimits.bucket) {
        state.rateLimits.bucket = {
          tokens: RATE_LIMIT.MESSAGE.MAX_COUNT,
          lastRefill: now
        };
      }

      const bucket = state.rateLimits.bucket;
      const elapsedTime = now - bucket.lastRefill;
      const refillAmount = Math.floor(elapsedTime / RATE_LIMIT.MESSAGE.WINDOW) * RATE_LIMIT.MESSAGE.MAX_COUNT;

      bucket.tokens = Math.min(RATE_LIMIT.MESSAGE.MAX_COUNT, bucket.tokens + refillAmount);
      bucket.lastRefill = now;

      if (bucket.tokens > 0) {
        bucket.tokens--;
        return true;
      }

      // If no tokens and already blocked, check block duration
      const messageLimit = state.rateLimits.messages;
      if (messageLimit.blockedUntil && now < messageLimit.blockedUntil) {
        log(`User ${userId} is blocked from sending messages until ${new Date(messageLimit.blockedUntil)}`);
        return false;
      }

      // If no tokens and not blocked, apply block
      messageLimit.blockedUntil = now + RATE_LIMIT.MESSAGE.BLOCK_DURATION;
      log(`User ${userId} has been rate limited for messages until ${new Date(messageLimit.blockedUntil)}`);
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

    // Initialize rate limits if not present
    if (!state.rateLimits) {
      state.rateLimits = {
        commands: new Map(),
        messages: { timestamp: Date.now(), count: 0 },
        bucket: {
          tokens: RATE_LIMIT.MESSAGE.MAX_COUNT,
          lastRefill: Date.now()
        }
      };
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
      }
    } finally {
      this.isStarting = false;
    }
  }

  async stop() {
    try {
      if (this.bot) {
        log("Stopping Telegram bot...");
        this.stopHeartbeat();
        await this.bot.stop();
        this.bot = null;
        this._isConnected = false;
        this.updateConnectionState('disconnected', 'Manual stop');
        log("Telegram bot stopped successfully");
      }
    } catch (error) {
      log(`Error stopping Telegram bot: ${error}`, "error");
    }
  }

  getIsConnected(): boolean {
    return this._isConnected;
  }

  async sendMessage(chatId: number, text: string) {
    try {
      if (!this.bot?.telegram) {
        log("Cannot send message: Bot is not connected", "error");
        return;
      }

      return await this.bot.telegram.sendMessage(chatId, text, { parse_mode: "MarkdownV2" });
    } catch (error) {
      log(`Error sending message to ${chatId}: ${error}`, "error");
      if (error.message?.includes('restart') || error.message?.includes('unauthorized')) {
        this._isConnected = false;
        await this.handleDisconnect();
      }
      throw error;
    }
  }

  async sendPhoto(chatId: number, photo: Buffer | string, caption?: string): Promise<string | undefined> {
    try {
      if (!this.bot?.telegram) {
        log("Cannot send photo: Bot is not connected", "error");
        return;
      }

      const result = await this.bot.telegram.sendPhoto(chatId, photo, {
        caption,
        parse_mode: "MarkdownV2"
      });

      // Return the file ID for caching
      if (result?.photo && result.photo.length > 0) {
        return result.photo[result.photo.length - 1].file_id;
      }
    } catch (error) {
      log(`Error sending photo to ${chatId}: ${error}`, "error");
      if (error.message?.includes('restart') || error.message?.includes('unauthorized')) {
        this._isConnected = false;
        await this.handleDisconnect();
      }
      throw error;
    }
  }

  async sendCachedPhoto(chatId: number, fileId: string, caption?: string): Promise<void> {
    try {
      if (!this.bot?.telegram) {
        log("Cannot send cached photo: Bot is not connected", "error");
        return;
      }

      await this.bot.telegram.sendPhoto(chatId, fileId, {
        caption,
        parse_mode: "MarkdownV2"
      });
    } catch (error) {
      log(`Error sending cached photo to ${chatId}: ${error}`, "error");
      if (error.message?.includes('restart') || error.message?.includes('unauthorized')) {
        this._isConnected = false;
        await this.handleDisconnect();
      }
      throw error;
    }
  }

  private async checkActiveUsers(userId: number): Promise<boolean> {
    if (this.activeUsers.size >= this.MAX_CONCURRENT_USERS) {
      const inactiveTime = 10 * 60 * 1000; // 10 minutes of inactivity
      const now = Date.now();
      
      // Find users to evict (inactive ones first)
      const usersToEvict: number[] = [];
      
      for (const [id, cleanup] of this.stateCleanups.entries()) {
        if (now - cleanup.createdAt > inactiveTime) {
          usersToEvict.push(id);
          if (usersToEvict.length + 1 >= this.activeUsers.size - this.MAX_CONCURRENT_USERS + 1) {
            break;
          }
        }
      }
      
      // Evict users if needed
      if (usersToEvict.length > 0) {
        for (const id of usersToEvict) {
          const cleanup = this.stateCleanups.get(id);
          if (cleanup?.timeout) {
            clearTimeout(cleanup.timeout);
          }
          this.userStates.delete(id);
          this.stateCleanups.delete(id);
          this.activeUsers.delete(id);
        }
        log(`Evicted ${usersToEvict.length} inactive users to make room for new users`);
      } else {
        // If no inactive users to evict, refuse service
        log(`Too many concurrent users (${this.activeUsers.size}), refusing service to user ${userId}`);
        return false;
      }
    }
    
    // Add user to active set
    this.activeUsers.add(userId);
    return true;
  }

  private async handleTicketMessage(ctx: Context, user: any, ticket: any) {
    try {
      if (!user || !ticket) {
        await ctx.reply("❌ Could not find your active ticket.");
        return;
      }

      const message = ctx.message as any;
      if (!message) return;

      // Handle text messages
      if (message.text) {
        await this.bridge.forwardToDiscord(
          message.text,
          ticket.id,
          user.username || user.telegramId,
          user.avatarUrl,
          user.photo,
          user.firstName,
          user.lastName
        );
        return;
      }

      // Handle images
      if (message.photo && message.photo.length > 0) {
        try {
          const fileId = message.photo[message.photo.length - 1].file_id;
          const url = await this.bot?.telegram.getFileLink(fileId);

          if (!url) {
            await ctx.reply("❌ Could not get the image. Please try again.");
            return;
          }

          // Forward the image through the bridge
          const imageBuffer = await this.bridge.processTelegramToDiscord(fileId);
          if (imageBuffer) {
            const caption = message.caption || '';
            await this.bridge.forwardImageToDiscord(
              ticket.discordChannelId,
              imageBuffer,
              caption,
              user.username || user.telegramId,
              user.avatarUrl
            );
          } else {
            await ctx.reply("❌ Failed to process the image. Please try again with a smaller image.");
          }
        } catch (error) {
          log(`Error handling photo: ${error}`, "error");
          await ctx.reply("❌ There was an error processing your image. Please try again.");
        }
        return;
      }

      // Handle document files
      if (message.document) {
        await ctx.reply("📝 Document received. Unfortunately, file attachments are not supported. Please convert to text or image.");
        return;
      }

      // Handle other message types
      await ctx.reply("❓ This message type is not supported. Please send text or images only.");
    } catch (error) {
      log(`Error in handleTicketMessage: ${error}`, "error");
      await ctx.reply("❌ There was an error processing your message. Please try again.");
    }
  }

  private async handleCategoryMenu(ctx: Context) {
    try {
      const userId = ctx.from?.id;
      if (!userId) return;

      if (!this.checkRateLimit(userId, 'command', 'menu')) {
        await ctx.reply("⚠️ Please wait before using this command again.");
        return;
      }

      const isActive = await this.checkActiveUsers(userId);
      if (!isActive) {
        await ctx.reply("⚠️ The system is currently at maximum capacity. Please try again in a few minutes.");
        return;
      }

      // Get user to check for active tickets
      const user = await storage.getUserByTelegramId(userId.toString());
      if (user) {
        const activeTicket = await storage.getActiveTicketByUserId(user.id);
        if (activeTicket) {
          const confirmText = "You have an active ticket. Would you like to continue with it or start a new one?";
          await ctx.reply(confirmText, {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "📝 Continue Existing", callback_data: "continue_ticket" },
                  { text: "🆕 Start New", callback_data: "new_ticket" }
                ]
              ]
            }
          });
          return;
        }
      }

      // Get categories to display
      const categories = await storage.getCategories();
      
      // First, filter out for parent/root level categories only
      const parentCategories = categories.filter(cat => !cat.parentId);
      const hasSubmenus = parentCategories.some(cat => categories.some(c => c.parentId === cat.id));

      const keyboard: { text: string; callback_data: string; }[][] = [];
      let currentRow: { text: string; callback_data: string; }[] = [];

      for (const category of parentCategories) {
        const hasChildren = categories.some(c => c.parentId === category.id);
        
        // Create a button with appropriate prefix
        const button = {
          text: category.isClosed ? `🔴 ${category.name}` : (hasChildren ? `📁 ${category.name}` : category.name),
          callback_data: hasChildren ? `submenu_${category.id}` : `category_${category.id}`
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

      const message = hasSubmenus 
        ? "Please select a category or submenu:" 
        : "Please select a service category:";

      await ctx.reply(message, {
        reply_markup: { inline_keyboard: keyboard }
      });

    } catch (error) {
      log(`Error in handleCategoryMenu: ${error}`, "error");
      await ctx.reply("❌ There was an error displaying the menu. Please try again.");
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
              caption: category.serviceSummary ? escapeMarkdown(category.serviceSummary) : undefined,
              parse_mode: "MarkdownV2"
            }
          );
        } catch (error) {
          log(`Error sending service image: ${error}`, "error");
          // If image fails, still show the summary as text
          if (category.serviceSummary) {
            await ctx.reply(escapeMarkdown(category.serviceSummary), {
              parse_mode: "MarkdownV2"
            });
          }
        }
      } else if (category.serviceSummary) {
        // If no image but has summary, show summary as text
        await ctx.reply(escapeMarkdown(category.serviceSummary), {
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
        rateLimits: {
          commands: new Map(),
          messages: { timestamp: 0, count: 0 },
          bucket: {
            tokens: RATE_LIMIT.MESSAGE.MAX_COUNT,
            lastRefill: Date.now()
          }
        }
      };
      this.setState(userId, state);

      // Ask first question
      await ctx.reply(escapeMarkdown(questions[0]), {
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
        await ctx.editMessageText(escapeMarkdown(message), {
          parse_mode: "MarkdownV2",
          reply_markup: { inline_keyboard: keyboard }
        });
      } catch (error) {
        // If editing fails, send a new message
        if (error.message?.includes("message can't be edited")) {
          await ctx.reply(escapeMarkdown(message), {
            parse_mode: "MarkdownV2",
            reply_markup: { inline_keyboard: keyboard }
          });
        } else {
          throw error; // Re-throw other errors
        }
      }

      log(`Successfully displayed submenu options for submenu ${submenuId}`);
    } catch (error) {
      log(`Error in handleSubmenuClick: ${error}`, "error");
      await ctx.reply("❌ There was an error displaying the menu. Please try again.");
    }
  }

  private async handleQuestionnaireResponse(ctx: Context, state: UserState) {
    try {
      const userId = ctx.from?.id;
      if (!userId) return;

      const message = ctx.message as any;
      if (!message || !message.text) {
        await ctx.reply("❌ Please provide a text response.");
        return;
      }

      const category = await storage.getCategory(state.categoryId);
      if (!category) {
        await ctx.reply("❌ Category not found. Please start over.");
        this.userStates.delete(userId);
        return;
      }

      const questions = category.questions || [];
      if (questions.length === 0) {
        await ctx.reply("❌ No questions configured for this category. Please start over.");
        this.userStates.delete(userId);
        return;
      }

      // Save the answer
      state.answers.push(message.text);

      // Move to next question or finish questionnaire
      if (state.currentQuestion < questions.length - 1) {
        state.currentQuestion++;
        this.setState(userId, state);
        
        await ctx.reply(escapeMarkdown(questions[state.currentQuestion]), {
          parse_mode: "MarkdownV2"
        });
      } else {
        // Questionnaire completed, create ticket
        await this.createTicket(ctx);
      }
    } catch (error) {
      log(`Error in handleQuestionnaireResponse: ${error}`, "error");
      await ctx.reply("❌ There was an error processing your response. Please try again.");
    }
  }

  private async createTicket(ctx: Context) {
    try {
      const userId = ctx.from?.id;
      if (!userId) return;

      const state = this.userStates.get(userId);
      if (!state) {
        await ctx.reply("❌ Session expired. Please start over.");
        return;
      }

      const category = await storage.getCategory(state.categoryId);
      if (!category) {
        await ctx.reply("❌ Category not found. Please start over.");
        this.userStates.delete(userId);
        return;
      }

      // Get or create user
      let user = await storage.getUserByTelegramId(userId.toString());
      
      if (!user) {
        user = await storage.createUser({
          telegramId: userId.toString(),
          username: ctx.from?.username || `user_${userId}`,
          firstName: ctx.from?.first_name || null,
          lastName: ctx.from?.last_name || null,
          avatarUrl: null,
          isAdmin: false,
          isStaff: false,
          isBanned: false
        });
      }

      // Create ticket
      const ticket = await storage.createTicket({
        userId: user.id,
        categoryId: state.categoryId,
        status: "open",
        discordChannelId: null,
        amount: 0,
        claimedBy: null,
        createdAt: new Date(),
        updatedAt: new Date()
      });

      // Create a formatted ticket summary
      const questions = category.questions || [];
      let ticketSummary = `*New Ticket*\n\n*Category:* ${escapeMarkdown(category.name)}\n\n`;
      
      for (let i = 0; i < questions.length; i++) {
        if (i < state.answers.length) {
          ticketSummary += `*Q:* ${escapeMarkdown(questions[i])}\n*A:* ${escapeMarkdown(state.answers[i])}\n\n`;
        }
      }

      // Create a ticket message
      await storage.createMessage({
        ticketId: ticket.id,
        userId: user.id,
        content: ticketSummary,
        type: "system",
        createdAt: new Date()
      });

      // Forward ticket to Discord via bridge
      try {
        await this.bridge.createTicketChannel(ticket);
      } catch (error) {
        log(`Error creating Discord channel for ticket ${ticket.id}: ${error}`, "error");
        await ctx.reply("❌ There was an error creating your ticket on Discord. Support has been notified.");
        
        // Continue with the process anyway
      }

      // Clear questionnaire state and send confirmation
      state.inQuestionnaire = false;
      this.setState(userId, state);
      
      await ctx.reply(`✅ Your ticket #${ticket.id} has been created successfully. You can now start a conversation with our support team. Just send messages here and they will be forwarded to our staff.`);
      
      // Ping role for this category if configured
      if (category.roleId) {
        await this.bridge.forwardPingToDiscord(ticket.id, user.username || `user_${userId}`);
      }
    } catch (error) {
      log(`Error in createTicket: ${error}`, "error");
      await ctx.reply("❌ There was an error creating your ticket. Please try again.");
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

  private setupHandlers() {
    this.bot.command("ping", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      if (!this.checkRateLimit(userId, 'command', 'ping')) {
        await ctx.reply("⚠️ Please wait before using this command again.");
        return;
      }

      const startTime = Date.now();
      const msg = await ctx.reply("Pinging...");
      const responseTime = Date.now() - startTime;

      try {
        await this.bot.telegram.editMessageText(
          ctx.chat.id,
          msg.message_id,
          undefined,
          `Pong! Bot latency: ${responseTime}ms`
        );
      } catch (error) {
        if (error.message?.includes("message can't be edited")) {
          // If we can't edit, just send a new message
          await ctx.reply(`Pong! Bot latency: ${responseTime}ms`);
        } else {
          throw error;
        }
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
        // Check for existing active ticket first
        const user = await storage.getUserByTelegramId(userId.toString());
        if (user) {
          const activeTicket = await storage.getActiveTicketByUserId(user.id);
          if (activeTicket) {
            const category = await storage.getCategory(activeTicket.categoryId);
            const categoryName = escapeMarkdown(category?.name || "Unknown");
            await ctx.reply(
              `❌ You already have an active ticket in *${categoryName}* category.\n\n` +
              "You cannot create a new ticket while you have an active one.\n" +
              "Please use /close to close your current ticket first, or continue chatting here to update your existing ticket.",
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

        // Get bot config for welcome message
        const config = await storage.getBotConfig();
        const welcomeMessage = config?.welcomeMessage || "Welcome to our support system! Use /menu to get started.";

        await ctx.reply(welcomeMessage);
        
        // Show category menu right after welcome message
        await this.handleCategoryMenu(ctx);
      } catch (error) {
        log(`Error in start command: ${error}`, "error");
        await ctx.reply("❌ There was an error processing your request. Please try again in a moment.");
      }
    });

    this.bot.command("menu", this.handleCategoryMenu.bind(this));

    this.bot.command("ticket", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      if (!this.checkRateLimit(userId, 'command', 'ticket')) {
        await ctx.reply("⚠️ Please wait before using this command again.");
        return;
      }

      // Get user and their active tickets
      const user = await storage.getUserByTelegramId(userId.toString());
      
      if (!user) {
        await ctx.reply("❌ You don't have any tickets. Use /menu to create one.");
        return;
      }

      const tickets = await storage.getTicketsByUserId(user.id);
      
      if (tickets.length === 0) {
        await ctx.reply("❌ You don't have any tickets. Use /menu to create one.");
        return;
      }

      // Format ticket information
      let ticketInfo = "*Your Tickets:*\n\n";
      
      for (const ticket of tickets) {
        const category = await storage.getCategory(ticket.categoryId);
        const categoryName = category ? category.name : "Unknown";
        
        const statusEmoji = ticket.status === "open" ? "🟢" : 
                           ticket.status === "closed" ? "🔴" : 
                           ticket.status === "pending" ? "🟡" : "⚪";
        
        ticketInfo += `*Ticket #${ticket.id}*\n`;
        ticketInfo += `*Category:* ${escapeMarkdown(categoryName)}\n`;
        ticketInfo += `*Status:* ${statusEmoji} ${escapeMarkdown(ticket.status)}\n`;
        ticketInfo += `*Created:* ${escapeMarkdown(ticket.createdAt.toDateString())}\n\n`;
      }

      await ctx.reply(escapeMarkdown(ticketInfo), {
        parse_mode: "MarkdownV2"
      });
    });

    this.bot.command("help", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      if (!this.checkRateLimit(userId, 'command', 'help')) {
        await ctx.reply("⚠️ Please wait before using this command again.");
        return;
      }

      const helpText = `
*Available Commands:*

/start - Welcome message and bot introduction
/menu - Open the services menu to create a new ticket
/ticket - View your active and past tickets
/help - Show this help message
/ping - Check if the bot is responsive

*How to use:*
1. Use /menu to browse available services
2. Select a service category
3. Answer the questions to create a ticket
4. Chat directly with our support team
`;

      await ctx.reply(escapeMarkdown(helpText), {
        parse_mode: "MarkdownV2"
      });
    });

    // Handle callback queries (inline button clicks)
    this.bot.on("callback_query", async (ctx) => {
      try {
        const userId = ctx.from?.id;
        if (!userId) return;

        const data = ctx.callbackQuery?.data;
        if (!data) return;

        // Try to acknowledge the callback to prevent "loading" state
        try {
          await ctx.answerCbQuery();
        } catch (error) {
          log(`Error answering callback query: ${error}`, "warn");
        }

        if (data === "back_to_main") {
          await this.handleCategoryMenu(ctx);
          return;
        }

        if (data === "continue_ticket") {
          const user = await storage.getUserByTelegramId(userId.toString());
          if (user) {
            const ticket = await storage.getActiveTicketByUserId(user.id);
            if (ticket) {
              const category = await storage.getCategory(ticket.categoryId);
              await ctx.reply(`✅ Continuing with ticket #${ticket.id} in category ${category?.name || "Unknown"}. Simply send your messages here.`);
              return;
            }
          }
          await ctx.reply("❌ Could not find your active ticket. Please create a new one.");
          await this.handleCategoryMenu(ctx);
          return;
        }

        if (data === "new_ticket") {
          await this.handleCategoryMenu(ctx);
          return;
        }

        if (data.startsWith("submenu_")) {
          const submenuId = parseInt(data.substring(8), 10);
          if (isNaN(submenuId)) {
            await ctx.reply("❌ Invalid submenu ID.");
            return;
          }
          await this.handleSubmenuClick(ctx, submenuId);
          return;
        }

        if (data.startsWith("category_")) {
          const categoryId = parseInt(data.substring(9), 10);
          if (isNaN(categoryId)) {
            await ctx.reply("❌ Invalid category ID.");
            return;
          }
          await this.handleCategorySelection(ctx, categoryId);
          return;
        }

        log(`Unknown callback data: ${data}`, "warn");
        await ctx.reply("❌ Unknown action. Please try again.");
      } catch (error) {
        log(`Error handling callback query: ${error}`, "error");
        await ctx.reply("❌ There was an error processing your request. Please try again.");
      }
    });

    // Handle text messages
    this.bot.on("text", async (ctx) => {
      try {
        const userId = ctx.from?.id;
        if (!userId) return;

        // Check if in questionnaire
        const state = this.userStates.get(userId);
        if (state?.inQuestionnaire) {
          await this.handleQuestionnaireResponse(ctx, state);
          return;
        }

        // Check message rate limit
        if (!this.checkRateLimit(userId, 'message')) {
          await ctx.reply("⚠️ You're sending messages too quickly. Please wait a moment before sending more.");
          return;
        }

        // Handle normal messages (forward to active ticket)
        const user = await storage.getUserByTelegramId(userId.toString());
        if (!user) {
          await ctx.reply("❌ You don't have an account. Please use /menu to get started.");
          return;
        }

        const ticket = await storage.getActiveTicketByUserId(user.id);
        if (!ticket) {
          await ctx.reply("❌ You don't have an active ticket. Please use /menu to create one.");
          return;
        }

        // Forward the message to the active ticket
        await this.handleTicketMessage(ctx, user, ticket);
      } catch (error) {
        log(`Error handling text message: ${error}`, "error");
        await ctx.reply("❌ There was an error processing your message. Please try again.");
      }
    });

    // Handle photos
    this.bot.on("photo", async (ctx) => {
      try {
        const userId = ctx.from?.id;
        if (!userId) return;

        // Check message rate limit
        if (!this.checkRateLimit(userId, 'message')) {
          await ctx.reply("⚠️ You're sending messages too quickly. Please wait a moment before sending more.");
          return;
        }

        // Handle photos (forward to active ticket)
        const user = await storage.getUserByTelegramId(userId.toString());
        if (!user) {
          await ctx.reply("❌ You don't have an account. Please use /menu to get started.");
          return;
        }

        const ticket = await storage.getActiveTicketByUserId(user.id);
        if (!ticket) {
          await ctx.reply("❌ You don't have an active ticket. Please use /menu to create one.");
          return;
        }

        // Forward the photo to the active ticket
        await this.handleTicketMessage(ctx, user, ticket);
      } catch (error) {
        log(`Error handling photo: ${error}`, "error");
        await ctx.reply("❌ There was an error processing your photo. Please try again.");
      }
    });

    // Generic error handler
    this.bot.catch((err, ctx) => {
      const userId = ctx?.from?.id;
      const update = ctx?.update;
      log(`Bot error: ${err}\nContext: ${JSON.stringify({ userId, update })}`, "error");
    });

    return Promise.resolve();
  }
}