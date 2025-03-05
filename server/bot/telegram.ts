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
  private userStates: Map<number, UserState>;
  private bridge: BridgeManager;

  constructor(bridge: BridgeManager) {
    this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
    this.userStates = new Map();
    this.bridge = bridge;
    this.setupHandlers();
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

      // Sort categories by display order
      const sortedCategories = [...categories].sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));

      // Create keyboard with proper row layout
      const keyboard: { text: string; callback_data: string; }[][] = [];
      let currentRow: { text: string; callback_data: string; }[] = [];

      for (const category of sortedCategories) {
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

    // Category selection
    this.bot.on("callback_query", async (ctx) => {
      const data = ctx.callbackQuery?.data;
      if (!data?.startsWith("category_")) return;

      const categoryId = parseInt(data.split("_")[1]);
      const category = await storage.getCategory(categoryId);
      if (!category) return;

      // Service summary with detailed description and photo
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

      console.log(`Initializing questionnaire for user ${userId}, category ${categoryId}`);

      // Reset user state
      this.userStates.set(userId, {
        categoryId,
        currentQuestion: 0,
        answers: []
      });

      // Start with first question
      await new Promise(resolve => setTimeout(resolve, 1000)); // Small delay for better UX
      await ctx.reply(category.questions[0]);
      await ctx.answerCbQuery();
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
    await this.bot.launch();
    console.log("Telegram bot started");
  }

  async sendMessage(chatId: number, message: string) {
    await this.bot.telegram.sendMessage(chatId, message);
  }
}