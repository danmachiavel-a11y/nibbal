import { Telegraf, Context } from "telegraf";
import { storage } from "../storage";
import { BridgeManager } from "./bridge";
import { log } from "../vite";

function escapeMarkdown(text: string): string {
  if (!text) return '';

  // Characters that need escaping in MarkdownV2
  const specialChars = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];

  // Escape backslash first to avoid double escaping
  let escaped = text.replace(/\\/g, '\\\\');

  // Escape all other special characters
  for (const char of specialChars) {
    // Use a regex that matches the character even if it's already escaped
    const regex = new RegExp(`(?<!\\\\)${char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
    escaped = escaped.replace(regex, `\\${char}`);
  }

  return escaped;
}

if (!process.env.TELEGRAM_BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN is required");
}

interface UserState {
  categoryId: number;
  currentQuestion: number;
  answers: string[];
}

export class TelegramBot {
  private bot: Telegraf;
  private bridge: BridgeManager;
  private userStates: Map<number, UserState>;
  private _isConnected: boolean = false;
  private static instance: TelegramBot | null = null;
  private isStarting: boolean = false;

  constructor(bridge: BridgeManager) {
    try {
      if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) {
        throw new Error("Invalid Telegram bot token");
      }

      // Ensure single instance
      if (TelegramBot.instance) {
        // If instance exists, stop it before creating new one
        TelegramBot.instance.stop().catch(error => {
          log(`Error stopping existing instance: ${error}`, "error");
        });
      }

      this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
      this.bridge = bridge;
      this.userStates = new Map();
      this.setupHandlers();
      TelegramBot.instance = this;
      log("Telegram bot instance created successfully");
    } catch (error) {
      log(`Error creating Telegram bot: ${error}`, "error");
      throw error;
    }
  }

  private async cleanupBeforeStart() {
    try {
      // Add retry mechanism for waiting when bot is already starting
      if (this.isStarting) {
        log("Bot is already starting, waiting for current start to complete...");
        let retries = 0;
        const maxRetries = 3;

        while (this.isStarting && retries < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          retries++;
          log(`Waiting for existing startup to complete (attempt ${retries}/${maxRetries})...`);
        }

        if (this.isStarting) {
          log("Timed out waiting for existing startup");
          return false;
        }
      }

      this.isStarting = true;

      // Stop existing instance if connected
      if (this._isConnected) {
        try {
          await this.bot.stop();
          // Add delay after stopping
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
          log(`Error stopping bot during cleanup: ${error}`, "error");
        }
      }

      // Reset state
      this._isConnected = false;
      this.userStates.clear();

      return true;
    } catch (error) {
      log(`Error during cleanup: ${error}`, "error");
      this.isStarting = false;
      return false;
    }
  }

  async start() {
    try {
      log("Starting Telegram bot...");

      // Cleanup before starting
      const canStart = await this.cleanupBeforeStart();
      if (!canStart) {
        log("Cannot start bot at this time - cleanup failed or bot is already starting");
        return;
      }

      try {
        await this.bot.launch({
          dropPendingUpdates: true
        });

        // Add delay to ensure proper startup
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Verify connection by getting bot info
        const botInfo = await this.bot.telegram.getMe();
        log(`Connected as @${botInfo.username}`);

        // Set connected status after successful launch and verification
        this._isConnected = true;
        log("Telegram bot started and connected successfully");
      } catch (error) {
        // Reset state on error
        this._isConnected = false;
        throw error;
      } finally {
        this.isStarting = false;
      }
    } catch (error) {
      this.isStarting = false;
      log(`Error starting Telegram bot: ${error}`, "error");
      throw error;
    }
  }

  async stop() {
    try {
      log("Stopping Telegram bot...");

      // Only attempt to stop if connected
      if (this._isConnected) {
        await this.bot.stop();
        // Add delay after stopping
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      // Reset state
      this._isConnected = false;
      this.isStarting = false;
      this.userStates.clear();

      log("Telegram bot stopped successfully");
    } catch (error) {
      log(`Error stopping Telegram bot: ${error}`, "error");
      throw error;
    }
  }

  private setupHandlers() {
    // Start command
    this.bot.command("start", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      // Check if user has any active tickets
      const user = await storage.getUserByTelegramId(userId.toString());
      if (user) {
        const activeTicket = await storage.getActiveTicketByUserId(user.id);
        if (activeTicket) {
          const category = await storage.getCategory(activeTicket.categoryId);
          await ctx.reply(
            "❌ You already have an active ticket in " +
              `*${category?.name || "Unknown"}* category.\n\n` +
              "Please use /close to close your current ticket before starting a new one, " +
              "or continue chatting here to update your existing ticket.",
            { parse_mode: "Markdown" }
          );
          return;
        }
      }

      const botConfig = await storage.getBotConfig();
      const categories = await storage.getCategories();

      // Organize categories and submenus
      const submenus = categories.filter(cat => cat.isSubmenu);
      const rootCategories = categories.filter(cat => !cat.parentId && !cat.isSubmenu);

      // Create keyboard with proper row layout
      const keyboard: { text: string; callback_data: string; }[][] = [];
      let currentRow: { text: string; callback_data: string; }[] = [];

      // First add submenus
      for (const submenu of submenus) {
        const button = {
          text: submenu.name,
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

      // Then add root categories
      for (const category of rootCategories) {
        const button = {
          text: category.name,
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

      const welcomeMessage = botConfig?.welcomeMessage || "Welcome to the support bot! Please select a service:";

      if (botConfig?.welcomeImageUrl) {
        try {
          await ctx.replyWithPhoto(
            botConfig.welcomeImageUrl,
            {
              caption: welcomeMessage,
              reply_markup: { inline_keyboard: keyboard }
            }
          );
        } catch (error) {
          console.error("Failed to send welcome image:", error);
          await ctx.reply(welcomeMessage, {
            reply_markup: { inline_keyboard: keyboard }
          });
        }
      } else {
        await ctx.reply(welcomeMessage, {
          reply_markup: { inline_keyboard: keyboard }
        });
      }
    });

    // Category/Submenu selection
    this.bot.on("callback_query", async (ctx) => {
      const data = ctx.callbackQuery?.data;
      if (!data) return;

      if (data.startsWith("submenu_")) {
        // Handle submenu selection
        const submenuId = parseInt(data.split("_")[1]);
        const categories = await storage.getCategories();
        const submenuCategories = categories.filter(cat => cat.parentId === submenuId);

        // Create keyboard for submenu categories
        const keyboard = submenuCategories.map(category => [{
          text: category.name,
          callback_data: `category_${category.id}`
        }]);

        await ctx.reply("Please select a category:", {
          reply_markup: { inline_keyboard: keyboard }
        });
        await ctx.answerCbQuery();
        return;
      }

      if (!data.startsWith("category_")) return;

      const categoryId = parseInt(data.split("_")[1]);
      await this.handleCategorySelection(ctx, categoryId);
      await ctx.answerCbQuery();

    });

    // Status command
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

    // Close command
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
        // Get category for transcript category ID
        const category = await storage.getCategory(activeTicket.categoryId);
        if (!category?.transcriptCategoryId) {
          await ctx.reply(
            "❌ Cannot close ticket: No transcript category set for this service. " +
              "Please contact an administrator."
          );
          return;
        }

        // Mark ticket as closed
        await storage.updateTicketStatus(activeTicket.id, "closed");

        // Try to move Discord channel if it exists
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

    // Handle all text messages
    this.bot.on("text", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      const state = this.userStates.get(userId);
      console.log(`Received message from user ${userId}. Current state:`, state);

      // Check if user has an active ticket first
      const user = await storage.getUserByTelegramId(userId.toString());
      if (user) {
        const activeTicket = await storage.getActiveTicketByUserId(user.id);
        if (activeTicket) {
          await this.handleTicketMessage(ctx, user, activeTicket);
          return;
        }
      }

      // If no active ticket, handle as part of questionnaire
      if (state) {
        await this.handleQuestionnaireResponse(ctx, state);
      }
    });

    // Add handler for photos
    this.bot.on("photo", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      // Only handle photos for active tickets
      const user = await storage.getUserByTelegramId(userId.toString());
      if (!user) return;

      const activeTicket = await storage.getActiveTicketByUserId(user.id);
      if (!activeTicket) {
        await ctx.reply("Please start a ticket first before sending photos.");
        return;
      }

      try {
        // Get the best quality photo
        const photos = ctx.message.photo;
        const bestPhoto = photos[photos.length - 1];
        const file = await ctx.telegram.getFile(bestPhoto.file_id);
        const imageUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

        // Get user's avatar URL if available
        let avatarUrl: string | undefined;
        try {
          const photos = await ctx.telegram.getUserProfilePhotos(ctx.from.id, 0, 1);
          if (photos && photos.total_count > 0) {
            const fileId = photos.photos[0][0].file_id;
            const file = await ctx.telegram.getFile(fileId);
            avatarUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
          }
        } catch (error) {
          log(`Error getting Telegram user avatar: ${error}`, "error");
          // Continue without avatar if there's an error
        }

        // Store message in database first
        await storage.createMessage({
          ticketId: activeTicket.id,
          content: ctx.message.caption || "Image sent",
          authorId: user.id,
          platform: "telegram",
          timestamp: new Date()
        });

        // Forward to Discord with caption if present
        await this.bridge.forwardToDiscord(
          ctx.message.caption || "Sent an image:",
          activeTicket.id,
          ctx.from.first_name || ctx.from.username || "Telegram User",
          avatarUrl // Use the user's profile photo as avatar
        );

        // Also forward the actual image
        await this.bridge.forwardToDiscord(
          "",
          activeTicket.id,
          ctx.from.first_name || ctx.from.username || "Telegram User",
          avatarUrl, // Keep the same avatar
          imageUrl // Send the actual image as attachment
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
      this.userStates.set(userId, state); // Update state

      console.log(`Moving to question ${state.currentQuestion + 1}`);
      await ctx.reply(category.questions[state.currentQuestion]);
    } else {
      // All questions answered, create ticket
      console.log('All questions answered, creating ticket');
      await this.createTicket(ctx);
    }
  }

  private async handleTicketMessage(ctx: Context, user: any, ticket: any) {
    if (!ctx.message || !('text' in ctx.message)) return;

    try {
      // Store message in database
      await storage.createMessage({
        ticketId: ticket.id,
        content: ctx.message.text,
        authorId: user.id,
        platform: "telegram",
        timestamp: new Date()
      });

      // Get user's avatar URL if available
      let avatarUrl: string | undefined;
      try {
        const photos = await this.bot.telegram.getUserProfilePhotos(ctx.from.id, 0, 1);
        if (photos && photos.total_count > 0) {
          const fileId = photos.photos[0][0].file_id;
          const file = await this.bot.telegram.getFile(fileId);
          avatarUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        }
      } catch (error) {
        log(`Error getting Telegram user avatar: ${error}`, "error");
        // Continue without avatar if there's an error
      }

      // Forward message to Discord with avatar
      await this.bridge.forwardToDiscord(
        ctx.message.text,
        ticket.id,
        ctx.from?.first_name || ctx.from?.username || "Telegram User",
        avatarUrl
      );
      log(`Message forwarded to Discord for ticket ${ticket.id}`);
    } catch (error) {
      console.error("Error handling ticket message:", error);
      await ctx.reply("Sorry, there was an error sending your message. Please try again.");
    }
  }

  private async createTicket(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) return;

    const state = this.userStates.get(userId);
    if (!state) return;

    try {
      // Create or get user
      let user = await storage.getUserByTelegramId(userId.toString());
      if (!user) {
        user = await storage.createUser({
          telegramId: userId.toString(),
          discordId: null,
          username: ctx.from?.username || "Unknown",
          isBanned: false
        });
      }

      // Create ticket
      const ticket = await storage.createTicket({
        userId: user.id,
        categoryId: state.categoryId,
        status: "open",
        discordChannelId: null,
        claimedBy: null,
        amount: null,
        answers: state.answers
      });

      // Clear user state
      this.userStates.delete(userId);

      try {
        // Try to create Discord channel
        await this.bridge.createTicketChannel(ticket);
        await ctx.reply("✅ Ticket created! Our support team will assist you shortly. You can continue chatting here, and your messages will be forwarded to our team.");
      } catch (error) {
        // If Discord channel creation fails, still create ticket but inform user
        await ctx.reply("✅ Ticket created! However, there might be a slight delay before our team can respond. Please be patient.");
        console.error("Discord channel creation error:", error);
      }
    } catch (error) {
      console.error("Error creating ticket:", error);
      await ctx.reply("❌ There was an error creating your ticket. Please try /start to begin again.");
    }
  }


  getIsConnected(): boolean {
    try {
      // Consider bot connected if we have the botInfo and _isConnected flag
      const connected = this._isConnected && this.bot.botInfo !== undefined && !this.isStarting;
      if (!connected) {
        log("Telegram bot is not connected", "warn");
      }
      return connected;
    } catch (error) {
      log(`Error checking Telegram bot connection: ${error}`, "error");
      return false;
    }
  }

  async sendMessage(chatId: number, message: string) {
    try {
      // Validate chat ID
      if (!Number.isInteger(chatId) || chatId <= 0) {
        throw new Error(`Invalid Telegram chat ID: ${chatId}`);
      }

      // Validate message
      if (!message || typeof message !== 'string') {
        throw new Error('Invalid message content');
      }

      // Trim message if it's too long (Telegram limit is 4096 characters)
      const trimmedMessage = message.slice(0, 4000);

      await this.bot.telegram.sendMessage(chatId, trimmedMessage);
      log(`Successfully sent message to Telegram chat: ${chatId}`);
    } catch (error) {
      log(`Error sending Telegram message: ${error}`, "error");
      throw error;
    }
  }
  async sendPhoto(chatId: number, imageUrl: string, caption?: string) {
    try {
      // Validate chat ID
      if (!Number.isInteger(chatId) || chatId <= 0) {
        throw new Error(`Invalid Telegram chat ID: ${chatId}`);
      }

      // Validate URL
      if (!imageUrl || typeof imageUrl !== 'string') {
        throw new Error('Invalid image URL');
      }

      await this.bot.telegram.sendPhoto(chatId, imageUrl, {
        caption: caption ? escapeMarkdown(caption) : undefined,
        parse_mode: 'MarkdownV2'
      });

      log(`Successfully sent photo to Telegram chat: ${chatId}`);
    } catch (error) {
      log(`Error sending Telegram photo: ${error}`, "error");
      throw error;
    }
  }

  private async handleCategorySelection(ctx: Context, categoryId: number) {
    const category = await storage.getCategory(categoryId);
    if (!category) return;

    const photoUrl = category.serviceImageUrl || `https://picsum.photos/seed/${category.name.toLowerCase()}/800/400`;
    const name = escapeMarkdown(category.name);
    const summary = category.serviceSummary;

    // Format the message with proper Markdown escaping
    const messageText = `*${name}*\n\n${summary}`;

    try {
      await ctx.replyWithPhoto(
        { url: photoUrl },
        {
          caption: messageText,
          parse_mode: 'MarkdownV2'
        }
      );

      // Initialize questionnaire after sending intro message
      const userId = ctx.from?.id;
      if (!userId) return;

      // Check for active tickets before starting questionnaire
      const user = await storage.getUserByTelegramId(userId.toString());
      if (user) {
        const activeTicket = await storage.getActiveTicketByUserId(user.id);
        if (activeTicket) {
          const activeCategory = await storage.getCategory(activeTicket.categoryId!);
          await ctx.reply(
            `You already have an active ticket in ${activeCategory?.name || "Unknown"} category.\n\nPlease use /close to close your current ticket before starting a new one.`
          );
          return;
        }
      }

      // Initialize questionnaire state
      this.userStates.set(userId, {
        categoryId,
        currentQuestion: 0,
        answers: []
      });

      // Start with first question after a small delay
      if (category.questions && category.questions.length > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        await ctx.reply(category.questions[0]);
      } else {
        // If no questions, create ticket directly
        await this.createTicket(ctx);
      }

    } catch (error) {
      log(`Error sending category photo: ${error}`, "error");
      // Fallback to text-only message if photo fails
      await ctx.reply(messageText, { 
        parse_mode: 'MarkdownV2'
      });
    }
  }
}