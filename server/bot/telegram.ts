import { Telegraf, Context } from "telegraf";
import { storage } from "../storage";
import { BridgeManager } from "./bridge";
import { log } from "../vite";
import fetch from 'node-fetch';

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
    // Handle direct messages
    this.bot.on("text", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      try {
        // Get user from storage
        const user = await storage.getUserByTelegramId(userId.toString());
        if (!user) return;

        // Check for active ticket
        const activeTicket = await storage.getActiveTicketByUserId(user.id);
        if (!activeTicket) return;

        // Forward the message to Discord
        await this.bridge.forwardToDiscord(
          ctx.message.text,
          activeTicket.id,
          ctx.from?.first_name || ctx.from?.username || "Telegram User"
        );

        log(`Message forwarded to Discord for ticket ${activeTicket.id}`);
      } catch (error) {
        log(`Error handling Telegram message: ${error}`, "error");
      }
    });

    // Handle photos
    this.bot.on("photo", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      try {
        // Get user from storage
        const user = await storage.getUserByTelegramId(userId.toString());
        if (!user) return;

        // Check for active ticket
        const activeTicket = await storage.getActiveTicketByUserId(user.id);
        if (!activeTicket) return;

        // Get the photo with highest quality
        const photos = ctx.message.photo;
        const photo = photos[photos.length - 1];

        // Get photo URL
        const fileLink = await ctx.telegram.getFileLink(photo.file_id);

        // Forward to Discord
        await this.bridge.forwardToDiscord(
          `[Image] ${fileLink.href}`,
          activeTicket.id,
          ctx.from?.first_name || ctx.from?.username || "Telegram User"
        );

        log(`Photo forwarded to Discord for ticket ${activeTicket.id}`);
      } catch (error) {
        log(`Error handling Telegram photo: ${error}`, "error");
      }
    });
  }

  async start() {
    try {
      log("Starting Telegram bot...");
      await this.bot.launch({
        dropPendingUpdates: true
      });
      this._isConnected = true;
      log("Telegram bot started and connected successfully");

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
    return this._isConnected && this.bot.botInfo !== undefined;
  }

  async sendMessage(chatId: number, message: string) {
    try {
      log(`Attempting to send message to Telegram chat ${chatId}`);

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

  async sendImage(chatId: number, imageUrl: string, caption?: string) {
    try {
      log(`Attempting to send image to Telegram chat ${chatId}. URL: ${imageUrl}`);

      // Validate chat ID
      if (!Number.isInteger(chatId) || chatId <= 0) {
        throw new Error(`Invalid Telegram chat ID: ${chatId}`);
      }

      // Validate image URL
      if (!imageUrl || typeof imageUrl !== 'string') {
        throw new Error('Invalid image URL');
      }

      try {
        // Download image from Discord URL to temporary buffer
        log(`Fetching image from URL: ${imageUrl}`);
        const response = await fetch(imageUrl);

        if (!response.ok) {
          throw new Error(`Failed to fetch image: ${response.statusText} (${response.status})`);
        }

        const contentType = response.headers.get('content-type');
        log(`Image content type: ${contentType}`);

        const buffer = await response.arrayBuffer();
        log(`Successfully downloaded image, size: ${buffer.byteLength} bytes`);

        // Send to Telegram directly using the buffer
        await this.bot.telegram.sendPhoto(chatId, {
          source: Buffer.from(buffer),
          filename: 'image.jpg'
        }, {
          caption: caption ? caption.slice(0, 1024) : undefined // Telegram caption limit
        });
        log(`Successfully sent image to Telegram chat: ${chatId}`);
      } catch (error) {
        log(`Error sending image as buffer, trying to send as URL: ${error}`, "error");
        // If sending photo fails, send as URL
        await this.sendMessage(chatId, `${caption}\n${imageUrl}`);
      }
    } catch (error) {
      log(`Error sending Telegram image: ${error}`, "error");
      throw error;
    }
  }
}