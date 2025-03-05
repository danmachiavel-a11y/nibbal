import { Telegraf, Context } from "telegraf";
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
  private _stopPolling: boolean = false;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private imageProcessingQueue: Map<string, Promise<void>> = new Map();

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

    // Handle photos with rate limiting
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

        // Rate limited image processing
        const queueKey = `${activeTicket.id}-${photo.file_id}`;
        if (this.imageProcessingQueue.has(queueKey)) {
          await this.imageProcessingQueue.get(queueKey);
          return;
        }

        const processingPromise = (async () => {
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
          } finally {
            this.imageProcessingQueue.delete(queueKey);
          }
        })();

        this.imageProcessingQueue.set(queueKey, processingPromise);
        await processingPromise;

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
        throw new Error(`Failed to fetch image: ${response.statusText} (${response.status})`);
      }

      const buffer = await response.arrayBuffer();
      log(`Downloaded image, size: ${buffer.byteLength} bytes`);

      // Upload to ImgBB - Without expiration for permanent storage
      const result = await imgbbUploader(process.env.IMGBB_API_KEY!, {
        base64string: Buffer.from(buffer).toString('base64')
        // No expiration parameter = permanent storage
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

      // Reset stop flag
      this._stopPolling = false;

      // Stop any existing webhooks
      try {
        await this.bot.telegram.deleteWebhook({ drop_pending_updates: true });
      } catch (error) {
        // Ignore webhook deletion errors
        log(`Warning: Could not delete webhook: ${error}`, "warn");
      }

      // Start bot with polling
      await this.bot.launch({
        dropPendingUpdates: true
      });

      this._isConnected = true;
      log("Telegram bot started and connected successfully");

      // Verify connection by getting bot info
      const botInfo = await this.bot.telegram.getMe();
      log(`Connected as @${botInfo.username}`);

      // Start health check
      this.startHealthCheck();
    } catch (error) {
      this._isConnected = false;
      log(`Error starting Telegram bot: ${error}`, "error");
      throw error;
    }
  }

  private startHealthCheck() {
    // Clear any existing health check
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    // Check connection every 30 seconds
    this.healthCheckInterval = setInterval(async () => {
      try {
        if (!this._stopPolling && !this.getIsConnected()) {
          log("Telegram bot disconnected, attempting to reconnect...");
          await this.start();
        }
      } catch (error) {
        log(`Health check failed: ${error}`, "error");
      }
    }, 30000);
  }

  async stop() {
    try {
      log("Stopping Telegram bot...");

      // Clear health check
      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = null;
      }

      // Set stop flag
      this._stopPolling = true;

      try {
        // Stop bot gracefully
        await this.bot.stop();
      } catch (error) {
        // Ignore "Bot is not running" errors
        if (!(error instanceof Error) || !error.message.includes("Bot is not running")) {
          throw error;
        }
      }

      // Delete webhook to ensure clean shutdown
      try {
        await this.bot.telegram.deleteWebhook({ drop_pending_updates: true });
      } catch (error) {
        // Ignore webhook deletion errors
        log(`Warning: Could not delete webhook during shutdown: ${error}`, "warn");
      }

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
}