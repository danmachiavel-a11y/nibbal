import { Telegraf, Context } from "telegraf";
import { storage } from "../storage";
import { BridgeManager } from "./bridge";

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

  private async setupHandlers() {
    // Start command
    this.bot.command("start", async (ctx) => {
      const botConfig = await storage.getBotConfig();
      const categories = await storage.getCategories();

      const keyboard = {
        inline_keyboard: categories.map(c => [{
          text: c.name,
          callback_data: `category_${c.id}`
        }])
      };

      // Format welcome message with HTML line breaks
      const welcomeMessage = (botConfig?.welcomeMessage || "Welcome! Please select a service:")
        .split('\n')
        .join('<br>');

      if (botConfig?.welcomeImageUrl) {
        try {
          await ctx.replyWithPhoto(
            botConfig.welcomeImageUrl,
            {
              caption: welcomeMessage,
              reply_markup: keyboard,
              parse_mode: 'HTML'
            }
          );
        } catch (error) {
          console.error("Failed to send welcome image:", error);
          await ctx.reply(welcomeMessage, { 
            reply_markup: keyboard,
            parse_mode: 'HTML'
          });
        }
      } else {
        await ctx.reply(welcomeMessage, { 
          reply_markup: keyboard,
          parse_mode: 'HTML'
        });
      }
    });

    // Category selection
    this.bot.on("callback_query", async (ctx) => {
      const data = ctx.callbackQuery?.data;
      if (!data?.startsWith("category_")) return;

      const categoryId = parseInt(data.split("_")[1]);
      const category = await storage.getCategory(categoryId);
      if (!category) return;

      // Format service summary with HTML line breaks
      const serviceSummary = category.serviceSummary
        .split('\n')
        .join('<br>');

      // Service summary with detailed description and photo
      const photoUrl = category.serviceImageUrl || `https://picsum.photos/seed/${category.name.toLowerCase()}/800/400`;
      const summary = `<b>${category.name} Service</b>\n\n` +
        serviceSummary + '\n\n' +
        `<b>How it works:</b>\n` +
        `1. Answer our questions\n` +
        `2. A ticket will be created\n` +
        `3. Our team will assist you promptly\n\n` +
        `Let's begin with some questions:`;

      try {
        await ctx.replyWithPhoto(
          { url: photoUrl },
          {
            caption: summary,
            parse_mode: 'HTML'
          }
        );
      } catch (error) {
        await ctx.reply(summary, { parse_mode: 'HTML' });
      }

      // Initialize user state
      const userId = ctx.from?.id;
      if (!userId) return;

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

      // Answer the callback query
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
        const categories = await storage.getCategories();
        for (const category of categories) {
          const tickets = await storage.getTicketsByCategory(category.id);
          const activeTicket = tickets.find(t =>
            t.userId === user.id &&
            t.status !== "closed"
          );

          if (activeTicket) {
            await this.handleTicketMessage(ctx, user, activeTicket);
            return;
          }
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

      // Get user's profile photo if available
      let photoUrl: string | undefined;
      try {
        const photos = await ctx.telegram.getUserProfilePhotos(parseInt(user.telegramId));
        if (photos?.total_count > 0) {
          const fileId = photos.photos[0][0].file_id;
          const file = await ctx.telegram.getFile(fileId);
          if (file.file_path) {
            photoUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
          }
        }
      } catch (error) {
        console.log("Could not get user photo:", error);
      }

      // Forward message to Discord
      await this.bridge.forwardToDiscord(
        ctx.message.text,
        ticket.id,
        ctx.from.first_name || ctx.from.username || "Telegram User",
        photoUrl
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