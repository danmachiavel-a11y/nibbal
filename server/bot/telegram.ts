import { Telegraf, Context } from "telegraf";
import { storage } from "../storage";
import { BridgeManager } from "./bridge";
import { Message } from "telegraf/typings/core/types/typegram";

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
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      throw new Error("TELEGRAM_BOT_TOKEN is required");
    }
    this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
    this.userStates = new Map();
    this.bridge = bridge;
    this.setupHandlers();
  }

  private async setupHandlers() {
    // Start command
    this.bot.command("start", async (ctx) => {
      const categories = await storage.getCategories();
      await ctx.reply("Select a category:", {
        reply_markup: {
          inline_keyboard: categories.map(c => [{
            text: c.name,
            callback_data: `category_${c.id}`
          }])
        }
      });
    });

    // Category selection
    this.bot.on("callback_query", async (ctx) => {
      const data = ctx.callbackQuery?.data;
      if (!data?.startsWith("category_")) return;

      const categoryId = parseInt(data.split("_")[1]);
      const category = await storage.getCategory(categoryId);
      if (!category) return;

      // Service summary with detailed description and photo
      const photoUrl = `https://picsum.photos/seed/${category.name.toLowerCase()}/800/400`;
      const summary = `<b>${category.name} Service</b>\n\n` +
        `Welcome to our ${category.name.toLowerCase()} support service! 📋\n\n` +
        `Our team specializes in handling all your ${category.name.toLowerCase()}-related needs. ` +
        `We'll guide you through a few questions to better understand your request.\n\n` +
        `<b>How it works:</b>\n` +
        `1. Answer our questions\n` +
        `2. A ticket will be created\n` +
        `3. Our team will assist you promptly\n\n` +
        `Let's begin with some questions:`;

      try {
        // Send photo with caption (combined message)
        await ctx.replyWithPhoto(
          { url: photoUrl },
          {
            caption: summary,
            parse_mode: 'HTML'
          }
        );
      } catch (error) {
        // Fallback to text-only if photo fails
        await ctx.reply(summary, { parse_mode: 'HTML' });
      }

      // Initialize user state
      const userId = ctx.from?.id;
      if (!userId) return;

      this.userStates.set(userId, {
        categoryId,
        currentQuestion: 0,
        answers: []
      });

      // Ask first question
      await ctx.reply(category.questions[0]);

      // Answer the callback query to remove loading state
      await ctx.answerCbQuery();
    });

    // Handle messages
    this.bot.on("text", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      const messageText = ctx.message?.text;
      if (!messageText) return;

      // First check if this is a message for an active ticket
      try {
        const user = await storage.getUserByTelegramId(userId.toString());
        if (!user) return;

        // Find any active tickets for this user
        const activeTickets = await storage.getTicketsByCategory(user.id);
        const activeTicket = activeTickets.find(t =>
          t.userId === user.id &&
          t.status !== "closed"
        );

        if (activeTicket) {
          console.log(`Found active ticket ${activeTicket.id} for user ${user.username}`);

          // Store message in database
          await storage.createMessage({
            ticketId: activeTicket.id,
            content: messageText,
            authorId: user.id,
            platform: "telegram",
            timestamp: new Date()
          });

          // Get user's profile photo if available
          let photoUrl: string | undefined;
          try {
            const photos = await ctx.telegram.getUserProfilePhotos(parseInt(user.telegramId));
            if (photos && photos.total_count > 0) {
              const fileId = photos.photos[0][0].file_id;
              const file = await ctx.telegram.getFile(fileId);
              if (file.file_path) {
                photoUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
              }
            }
          } catch (error) {
            console.log("Could not get user photo:", error);
          }

          // Forward to Discord
          await this.bridge.forwardToDiscord(
            messageText,
            activeTicket.id,
            ctx.from?.username || "Unknown",
            photoUrl
          );

          console.log(`Message forwarded to Discord for ticket ${activeTicket.id}`);
          return;
        }
      } catch (error) {
        console.error("Error handling message:", error);
      }

      // If no active ticket, handle as questionnaire response
      await this.handleQuestionnaireResponse(ctx, userId, messageText);
    });
  }

  private async findActiveTicket(userId: number) {
    const tickets = [];
    const categories = await storage.getCategories();

    for (const category of categories) {
      const categoryTickets = await storage.getTicketsByCategory(category.id);
      const activeTicket = categoryTickets.find(t =>
        t.userId === userId &&
        t.status !== "closed"
      );
      if (activeTicket) tickets.push(activeTicket);
    }

    return tickets;
  }

  private async handleActiveTicketMessage(ctx: Context, user: any, ticket: any, messageText: string) {
    try {
      // Store message in database
      await storage.createMessage({
        ticketId: ticket.id,
        content: messageText,
        authorId: user.id,
        platform: "telegram",
        timestamp: new Date()
      });

      // Get user's photo if available
      let photoUrl: string | undefined;
      try {
        const photos = await ctx.telegram.getUserProfilePhotos(parseInt(user.telegramId));
        if (photos && photos.total_count > 0) {
          const fileId = photos.photos[0][0].file_id;
          const file = await ctx.telegram.getFile(fileId);
          if (file.file_path) {
            photoUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
          }
        }
      } catch (error) {
        console.log("Could not get user photo:", error);
      }

      // Forward to Discord
      await this.bridge.forwardToDiscord(
        messageText,
        ticket.id,
        ctx.from?.username || "Unknown",
        photoUrl
      );

      console.log(`Message forwarded to Discord for ticket ${ticket.id}`);
    } catch (error) {
      console.error("Error handling ticket message:", error);
      await ctx.reply("Sorry, there was an error sending your message. Please try again.");
    }
  }

  private async handleQuestionnaireResponse(ctx: Context, userId: number, messageText: string) {
    const state = this.userStates.get(userId);
    if (!state?.categoryId) return;

    const category = await storage.getCategory(state.categoryId);
    if (!category) return;

    // Store answer
    state.answers.push(messageText);

    // Move to next question or create ticket
    if (state.currentQuestion < category.questions.length - 1) {
      state.currentQuestion++;
      await ctx.reply(category.questions[state.currentQuestion]);
    } else {
      await this.createTicket(ctx, userId, state);
    }
  }

  private async createTicket(ctx: Context, userId: number, state: UserState) {
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