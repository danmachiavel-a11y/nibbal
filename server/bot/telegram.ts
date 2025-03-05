import { Telegraf } from "telegraf";
import { storage } from "../storage";
import { BridgeManager } from "./bridge";
import { log } from "../vite";
import fetch from 'node-fetch';
import imgbbUploader from 'imgbb-uploader';

if (!process.env.TELEGRAM_BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN is required");
}

if (!process.env.IMGBB_API_KEY) {
  throw new Error("IMGBB_API_KEY is required for image forwarding");
}

export class TelegramBot {
  private bot: Telegraf;
  private bridge: BridgeManager;
  private _isConnected: boolean = false;

  constructor(bridge: BridgeManager) {
    this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN as string);
    this.bridge = bridge;
    this.setupHandlers();
    log("Telegram bot instance created successfully");
  }

  private setupHandlers() {
    // Handle text messages
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

        // Forward to Discord
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

        try {
          // Upload to ImgBB first
          const imgbbUrl = await this.uploadToImgBB(fileLink.href);

          // Forward permanent URL to Discord
          await this.bridge.forwardToDiscord(
            `[Image] ${imgbbUrl}`,
            activeTicket.id,
            ctx.from?.first_name || ctx.from?.username || "Telegram User"
          );
        } catch (error) {
          log(`Error uploading to ImgBB: ${error}`, "error");
          // If ImgBB upload fails, send original Telegram URL
          await this.bridge.forwardToDiscord(
            `[Image] ${fileLink.href}`,
            activeTicket.id,
            ctx.from?.first_name || ctx.from?.username || "Telegram User"
          );
        }

        log(`Photo forwarded to Discord for ticket ${activeTicket.id}`);
      } catch (error) {
        log(`Error handling Telegram photo: ${error}`, "error");
      }
    });
  }

  private async uploadToImgBB(imageUrl: string): Promise<string> {
    try {
      log(`Downloading image from URL: ${imageUrl}`);

      // Download image
      const response = await fetch(imageUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.statusText}`);
      }

      const buffer = await response.arrayBuffer();
      log(`Downloaded image, size: ${buffer.byteLength} bytes`);

      // Upload to ImgBB without expiration for permanent storage
      const result = await imgbbUploader(process.env.IMGBB_API_KEY!, {
        base64string: Buffer.from(buffer).toString('base64')
      });

      log(`Successfully uploaded image to ImgBB: ${result.url}`);
      return result.url;
    } catch (error) {
      log(`Error uploading to ImgBB: ${error}`, "error");
      throw error;
    }
  }

  async start() {
    try {
      if (this._isConnected) {
        log("Telegram bot is already running");
        return;
      }

      log("Starting Telegram bot...");
      await this.bot.launch();
      this._isConnected = true;
      log("Telegram bot started successfully");
    } catch (error) {
      this._isConnected = false;
      log(`Error starting Telegram bot: ${error}`, "error");
      throw error;
    }
  }

  async stop() {
    try {
      if (!this._isConnected) {
        log("Telegram bot is not running");
        return;
      }

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
    return this._isConnected;
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
        // Upload to ImgBB first
        const imgbbUrl = await this.uploadToImgBB(imageUrl);

        // Send to Telegram using ImgBB URL
        await this.bot.telegram.sendPhoto(chatId, imgbbUrl, {
          caption: caption ? caption.slice(0, 1024) : undefined // Telegram caption limit
        });
        log(`Successfully sent image to Telegram chat: ${chatId}`);
      } catch (error) {
        log(`Error sending image as URL: ${error}`, "error");
        // If sending photo fails, send as URL
        await this.sendMessage(chatId, `${caption}\n${imageUrl}`);
      }
    } catch (error) {
      log(`Error sending Telegram image: ${error}`, "error");
      throw error;
    }
  }

  getIsConnected(): boolean {
    return this._isConnected;
  }
}