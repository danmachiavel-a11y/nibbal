import { Telegraf, Context } from "telegraf";
import { storage } from "../storage";
import { BridgeManager } from "./bridge";
import { log } from "../vite";

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

  constructor(bridge: BridgeManager) {
    try {
      if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) {
        throw new Error("Invalid Telegram bot token");
      }
      this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
      this.bridge = bridge;
      this.userStates = new Map();
      this.setupHandlers();
      log("Telegram bot instance created successfully");
    } catch (error) {
      log(`Error creating Telegram bot: ${error}`, "error");
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
      const category = await storage.getCategory(categoryId);
      if (!category) return;

      // Display category info and start questionnaire
      const photoUrl = category.serviceImageUrl || `https://picsum.photos/seed/${category.name.toLowerCase()}/800/400`;
      const summary = `*${category.name} Service*\n\n` +
        `${category.serviceSummary}\n\n` +
        `*How it works:*\n` +
        `1. Answer our questions\n` +
        `2. A ticket will be created\n` +
        `3. Our team will assist you promptly\n\n` +
        `Let's begin with some questions:`;

      try {
        await ctx.replyWithPhoto(
          { url: photoUrl },
          {
            caption: summary,
            parse_mode: 'Markdown'
          }
        );
      } catch (error) {
        await ctx.reply(summary, { parse_mode: 'Markdown' });
      }

      // Initialize user state
      const userId = ctx.from?.id;
      if (!userId) return;

      // Check for active tickets again before starting questionnaire
      const user = await storage.getUserByTelegramId(userId.toString());
      if (user) {
        const activeTicket = await storage.getActiveTicketByUserId(user.id);
        if (activeTicket) {
          const activeCategory = await storage.getCategory(activeTicket.categoryId);
          await ctx.reply(
            "❌ You already have an active ticket in " +
              `*${activeCategory?.name || "Unknown"}* category.\n\n` +
              "Please use /close to close your current ticket before starting a new one.",
            { parse_mode: "Markdown" }
          );
          return;
        }
      }

      // Initialize questionnaire
      this.userStates.set(userId, {
        categoryId,
        currentQuestion: 0,
        answers: []
      });

      // Start with first question
      if (category.questions && category.questions.length > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Small delay for better UX
        await ctx.reply(category.questions[0]);
      } else {
        // If no questions, create ticket directly
        await this.createTicket(ctx);
      }

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

      // Forward message to Discord
      await this.bridge.forwardToDiscord(
        ctx.message.text,
        ticket.id,
        ctx.from?.first_name || ctx.from?.username || "Telegram User"
      );
      console.log(`Message forwarded to Discord for ticket ${ticket.id}`);
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

  async start() {
    try {
      log("Starting Telegram bot...");
      await this.bot.launch({
        dropPendingUpdates: true,
        onLaunch: () => {
          this._isConnected = true;
          log("Telegram bot started and connected successfully");
        }
      });

      // Verify connection by getting bot info
      const botInfo = await this.bot.telegram.getMe();
      log(`Connected as @${botInfo.username}`);

    } catch (error) {
      log(`Error starting Telegram bot: ${error}`, "error");
      this._isConnected = false;
      throw error;
    }
  }

  async stop() {
    try {
      log("Stopping Telegram bot...");
      await this.bot.stop();
      this._isConnected = false;
      log("Telegram bot stopped successfully");
    } catch (error) {
      log(`Error stopping Telegram bot: ${error}`, "error");
      throw error;
    }
  }

  getIsConnected(): boolean {
    try {
      // Check if bot is actually running by attempting to get bot info
      const connected = this._isConnected && this.bot.botInfo !== undefined;
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
}