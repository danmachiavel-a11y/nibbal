import { Telegraf, Context } from "telegraf";
import { storage } from "../storage";
import { BridgeManager } from "./bridge";
import { Message } from "telegraf/typings/core/types/typegram";

if (!process.env.TELEGRAM_BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN is required");
}

export class TelegramBot {
  private bot: Telegraf;
  private userStates: Map<number, {
    categoryId?: number;
    currentQuestion?: number;
    answers: string[];
  }>;
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
      if (!ctx.callbackQuery.data) return;

      const data = ctx.callbackQuery.data;
      if (!data.startsWith("category_")) return;

      const categoryId = parseInt(data.split("_")[1]);
      const category = await storage.getCategory(categoryId);
      if (!category) return;

      // Initialize user state
      const userId = ctx.from.id;
      this.userStates.set(userId, {
        categoryId,
        currentQuestion: 0,
        answers: []
      });

      // Ask first question
      await ctx.reply(category.questions[0]);
    });

    // Handle answers
    this.bot.on("text", async (ctx) => {
      const userId = ctx.from.id;
      const state = this.userStates.get(userId);
      if (!state?.categoryId) return;

      const category = await storage.getCategory(state.categoryId);
      if (!category) return;

      // Store answer
      state.answers.push(ctx.message.text);

      // Move to next question or create ticket
      if (state.currentQuestion !== undefined && state.currentQuestion < category.questions.length - 1) {
        state.currentQuestion++;
        await ctx.reply(category.questions[state.currentQuestion]);
      } else {
        // Create user if doesn't exist
        let user = await storage.getUserByTelegramId(ctx.from.id.toString());
        if (!user) {
          user = await storage.createUser({
            telegramId: ctx.from.id.toString(),
            discordId: null,
            username: ctx.from.username || "Unknown",
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

        // Create Discord channel through bridge
        await this.bridge.createTicketChannel(ticket);

        // Clear user state
        this.userStates.delete(userId);

        await ctx.reply("Ticket created! We'll get back to you shortly.");
      }
    });
  }

  async start() {
    await this.bot.launch();
    console.log("Telegram bot started");
  }

  async sendMessage(chatId: number, message: string) {
    await this.bot.telegram.sendMessage(chatId, message);
  }
}