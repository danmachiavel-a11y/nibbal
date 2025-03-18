import { Telegraf, Context } from "telegraf";
import { storage } from "../storage";
import { BridgeManager } from "./bridge";
import { log } from "../vite";
import fetch from 'node-fetch';

interface CommandCooldown {
  lastUsed: number;
  count: number;
}

interface UserState {
  categoryId: number;
  currentQuestion: number;
  answers: string[];
  inQuestionnaire: boolean;
}

interface MessageRateLimit {
  messages: number;
  windowStart: number;
  blockedUntil?: number;
}

interface StateCleanup {
  timeout: NodeJS.Timeout;
  createdAt: number;
}

function escapeMarkdown(text: string): string {
  if (!text) return '';
  const specialChars = ['[', ']', '(', ')', '~', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
  const formatPatterns = [
    { start: '**', end: '**', marker: '*' },
    { start: '__', end: '__', marker: '_' },
    { start: '```', end: '```', marker: '`' },
    { start: '`', end: '`', marker: '`' }
  ];

  for (const pattern of formatPatterns) {
    if (text.startsWith(pattern.start) && text.endsWith(pattern.end)) {
      const content = text.slice(pattern.start.length, -pattern.end.length);
      let escaped = content;
      for (const char of specialChars) {
        escaped = escaped.replace(new RegExp('\\' + char, 'g'), '\\' + char);
      }
      return `${pattern.marker}${escaped}${pattern.marker}`;
    }
  }

  let escaped = text;
  for (const char of [...specialChars, '*', '_', '`']) {
    escaped = escaped.replace(new RegExp('\\' + char, 'g'), '\\' + char);
  }
  return escaped;
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
  private readonly MAX_RECONNECT_ATTEMPTS = 3;
  private readonly CLEANUP_DELAY = 10000; // 10 seconds
  private readonly HEARTBEAT_INTERVAL = 120000; // 2 minutes
  private readonly STATE_TIMEOUT = 900000; // 15 minutes
  private readonly RECONNECT_COOLDOWN = 30000; // 30 seconds
  private readonly MAX_FAILED_HEARTBEATS = 3;
  private failedHeartbeats = 0;

  // Rate limiting and cooldown functionality
  private commandCooldowns: Map<number, Map<string, CommandCooldown>> = new Map();
  private readonly COOLDOWN_WINDOW = 60000;
  private readonly MAX_COMMANDS = 5;
  private messageRateLimits: Map<number, MessageRateLimit> = new Map();
  private readonly MESSAGE_WINDOW = 2000;
  private readonly MAX_MESSAGES = 10;
  private readonly SPAM_BLOCK_DURATION = 300000;
  private readonly MAX_CONCURRENT_USERS = 500;
  private activeUsers: Set<number> = new Set();

  constructor(bridge: BridgeManager) {
    try {
      if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) {
        throw new Error("Invalid Telegram bot token");
      }

      this.bridge = bridge;

      // Start cleanup interval for stale states
      setInterval(() => this.cleanupStaleStates(), 60000);

      log("Telegram bot instance created successfully");
    } catch (error) {
      log(`Error creating Telegram bot: ${error}`, "error");
      throw error;
    }
  }

  private cleanupStaleStates() {
    const now = Date.now();
    for (const [userId, cleanup] of this.stateCleanups) {
      if (now - cleanup.createdAt > this.STATE_TIMEOUT) {
        this.userStates.delete(userId);
        this.stateCleanups.delete(userId);
        this.activeUsers.delete(userId);
        log(`Cleaned up stale state for user ${userId}`);
      }
    }
  }

  private setState(userId: number, state: UserState) {
    // Clear existing timeout if any
    const existing = this.stateCleanups.get(userId);
    if (existing?.timeout) {
      clearTimeout(existing.timeout);
    }

    // Set new state with timeout
    this.userStates.set(userId, state);
    const timeout = setTimeout(() => {
      this.userStates.delete(userId);
      this.stateCleanups.delete(userId);
      this.activeUsers.delete(userId);
      log(`State timeout for user ${userId}`);
    }, this.STATE_TIMEOUT);

    this.stateCleanups.set(userId, {
      timeout,
      createdAt: Date.now()
    });
  }

  private stopHeartbeat = (): void => {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  };

  private startHeartbeat = (): void => {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(
      () => this.handleHeartbeat(),
      this.HEARTBEAT_INTERVAL
    );
  };

  private async handleHeartbeat() {
    try {
      if (!this._isConnected || this.isStarting) return;

      const me = await this.bot?.telegram.getMe();
      if (!me) {
        this.failedHeartbeats++;
        log(`Heartbeat check failed (attempt ${this.failedHeartbeats}/${this.MAX_FAILED_HEARTBEATS}): Bot returned null`, "warn");

        // Only disconnect after multiple consecutive failures
        if (this.failedHeartbeats >= this.MAX_FAILED_HEARTBEATS) {
          this._isConnected = false;
          await this.handleDisconnect();
        }
        return;
      }

      // Reset failed heartbeats counter on successful check
      this.failedHeartbeats = 0;
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

  async start() {
    if (this.isStarting) {
      log("Bot is already starting, waiting...");
      return;
    }

    this.isStarting = true;

    try {
      log("Starting Telegram bot...");

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
      this.startHeartbeat();
      this.reconnectAttempts = 0;

      log("Telegram bot started successfully");
    } catch (error) {
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
      this.commandCooldowns.clear();
      this.messageRateLimits.clear();
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


  private async handleDisconnect() {
    if (this.isStarting) return;

    log("Bot disconnected, attempting to reconnect...");
    await new Promise(resolve => setTimeout(resolve, this.RECONNECT_COOLDOWN));

    try {
      if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
        log("Max reconnection attempts reached, waiting for longer cooldown", "warn");
        this.reconnectAttempts = 0;
        await new Promise(resolve => setTimeout(resolve, this.RECONNECT_COOLDOWN * 2));
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
      log("Reconnection successful");
    } catch (error) {
      this.reconnectAttempts++;
      log(`Reconnection attempt failed: ${error}`, "error");

      if (this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
        await this.handleDisconnect();
      } else {
        log("Max reconnection attempts reached", "error");
        this.reconnectAttempts = 0;
      }
    }
  }

  async sendMessage(chatId: number, text: string) {
    try {
      if (!this.bot) {
        throw new Error("Bot not initialized");
      }

      await this.bot.telegram.sendMessage(chatId, escapeMarkdown(text), {
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
          caption: caption ? escapeMarkdown(caption) : undefined,
          parse_mode: "MarkdownV2"
        });
      } else if (photo instanceof Buffer) {
        // Handle buffer by using InputFile format
        sentMessage = await this.bot.telegram.sendPhoto(chatId, { source: photo }, {
          caption: caption ? escapeMarkdown(caption) : undefined,
          parse_mode: "MarkdownV2"
        });
      } else {
        // Handle file_id string
        sentMessage = await this.bot.telegram.sendPhoto(chatId, photo, {
          caption: caption ? escapeMarkdown(caption) : undefined,
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
        caption: caption ? escapeMarkdown(caption) : undefined,
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

    try {
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
        undefined, // photo parameter
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

    const welcomeMessage = escapeMarkdown(botConfig?.welcomeMessage || "**Welcome to the support bot!** Please select a service:");

    await ctx.editMessageText(welcomeMessage, {
      parse_mode: "MarkdownV2",
      reply_markup: { inline_keyboard: keyboard }
    });
    await ctx.answerCbQuery();
  }

  private setupHandlers() {
    this.bot.command("ping", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

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

      if (!await this.checkCommandCooldown(userId, 'start')) {
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
              `❌ You already have an active ticket in *${categoryName}* category\\.\n\n` +
              "You cannot create a new ticket while you have an active one\\.\n" +
              "Please use /close to close your current ticket first, or continue chatting here to update your existing ticket\\.",
              { parse_mode: "MarkdownV2" }
            );
            return;
          }
        }

        const state = this.userStates.get(userId);
        if (state?.inQuestionnaire) {
          await ctx.reply(
            "❌ You are currently answering questions for a ticket.\n" +
            "Use /cancel to cancel the current process first."
          );
          return;
        }

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

        const welcomeMessage = escapeMarkdown(botConfig?.welcomeMessage || "**Welcome to the support bot!** Please select a service:");

        if (botConfig?.welcomeImageUrl) {
          try {
            await ctx.replyWithPhoto(
              botConfig.welcomeImageUrl,
              {
                caption: welcomeMessage,
                parse_mode: "MarkdownV2",
                reply_markup: { inline_keyboard: keyboard }
              }
            );
          } catch (error) {
            console.error("Failed to send welcome image:", error);
            await ctx.reply(welcomeMessage, {
              parse_mode: "MarkdownV2",
              reply_markup: { inline_keyboard: keyboard }
            });
          }
        } else {
          await ctx.reply(welcomeMessage, {
            parse_mode: "MarkdownV2",
            reply_markup: { inline_keyboard: keyboard }
          });
        }
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
      const data = ctx.callbackQuery?.data;
      if (!data) return;

      if (data.startsWith("submenu_")) {
        const submenuId = parseInt(data.split("_")[1]);
        const categories = await storage.getCategories();
        const submenuCategories = categories.filter(cat => cat.parentId === submenuId);

        log(`Processing submenu ${submenuId} with ${submenuCategories.length} categories`);

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

        // Add "Back to Menu" button in a new row
        keyboard.push([{
          text: "↩️ Back to Menu",
          callback_data: "back_to_menu"
        }]);

        try {
          await ctx.editMessageText(
            escapeMarkdown("Please select a service from the options below. Our team will be ready to assist you with your chosen service:"),
            {
              parse_mode: "MarkdownV2",
              reply_markup: { inline_keyboard: keyboard }
            }
          );
          log(`Successfully displayed submenu options for submenu ${submenuId}`);
        } catch (error) {
          log(`Error updating submenu message: ${error}`, "error");
          // If edit fails, try sending a new message as fallback
          await ctx.reply(
            "Please select a service from the options below. Our team will be ready to assist you with your chosen service:",
            {
              reply_markup: { inline_keyboard: keyboard }
            }
          );
        }

        await ctx.answerCbQuery();
        return;
      }

      // Handle back to menu button
      if (data === "back_to_menu") {
        await this.handleCategoryMenu(ctx);
        return;
      }

      if (!data.startsWith("category_")) return;

      const categoryId = parseInt(data.split("_")[1]);
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

      const category = await storage.getCategory(activeTicket.categoryId);
      await ctx.reply(
        `Your active ticket:\n\n` +
        `Category: *${category?.name || "Unknown"}*\n` +
        `Status: *${activeTicket.status}*\n` +
        `Created: *${new Date(activeTicket.createdAt || Date.now()).toLocaleString()}*`,
        { parse_mode: "Markdown" }
      );
    });

    this.bot.command("close", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

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
        const category = await storage.getCategory(activeTicket.categoryId);
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

  private async handleCategorySelection(ctx: Context, categoryId: number) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const category = await storage.getCategory(categoryId);
    if (!category) {
      await this.sendMessage(userId, "❌ Invalid category selected.");
      return;
    }

    if (!await this.checkActiveUsers(userId)) {
      await this.sendMessage(userId, "❌ Too many active users. Please try again later.");
      return;
    }


    if (category.questions.length > 0) {
      // Start questionnaire
      const state: UserState = {
        categoryId,
        currentQuestion: 0,
        answers: [],
        inQuestionnaire: true
      };
      this.setState(userId, state);
      await ctx.reply(category.questions[0]);
    } else {
      // Create ticket directly
      const user = await storage.getUserByTelegramId(userId.toString());
      if (!user) {
        await this.sendMessage(userId, "❌ User not found. Please try /start.");
        return;
      }
      await this.createTicket({ from: { id: userId, first_name: user.telegramName, username: user.telegramUsername }, reply: this.sendMessage.bind(this, userId) });
    }
  }



  private async checkCommandCooldown(userId: number, command: string): Promise<boolean> {
    if (!this.commandCooldowns.has(userId)) {
      this.commandCooldowns.set(userId, new Map());
    }

    const userCooldowns = this.commandCooldowns.get(userId)!;
    const now = Date.now();

    if (!userCooldowns.has(command)) {
      userCooldowns.set(command, { lastUsed: now, count: 1 });
      return true;
    }

    const cooldown = userCooldowns.get(command)!;

    if (now - cooldown.lastUsed > this.COOLDOWN_WINDOW) {
      cooldown.count = 1;
      cooldown.lastUsed = now;
      return true;
    }

    if (cooldown.count >= this.MAX_COMMANDS) {
      return false;
    }

    cooldown.count++;
    cooldown.lastUsed = now;
    return true;
  }

  private async checkMessageRateLimit(userId: number): Promise<boolean> {
    const now = Date.now();
    if (!this.messageRateLimits.has(userId)) {
      this.messageRateLimits.set(userId, {
        messages: 1,
        windowStart: now
      });
      return true;
    }

    const limit = this.messageRateLimits.get(userId)!;

    // Check if user is currently blocked
    if (limit.blockedUntil && now < limit.blockedUntil) {
      return false;
    }

    // Reset window if it's expired
    if (now - limit.windowStart > this.MESSAGE_WINDOW) {
      limit.messages = 1;
      limit.windowStart = now;
      limit.blockedUntil = undefined;
      return true;
    }

    // Increment message count
    limit.messages++;

    // Check if user exceeded limit
    if (limit.messages > this.MAX_MESSAGES) {
      limit.blockedUntil = now + this.SPAM_BLOCK_DURATION;
      return false;
    }

    return true;
  }
  // Removed duplicate handleCategoryMenu function
  // Removed duplicate setupHandlers function

}

if (!process.env.TELEGRAM_BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN is required");
}