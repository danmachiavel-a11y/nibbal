import { Telegraf, Markup } from "telegraf";
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
  private connectionAttempts: number = 0;
  private readonly MAX_RETRIES: number = 3;
  private readonly RETRY_DELAY: number = 5000;

  constructor(bridge: BridgeManager) {
    this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN as string);
    this.bridge = bridge;
    this.setupHandlers();
  }

  private setupHandlers() {
    // Add start command handler with customizable buttons
    this.bot.command('start', async (ctx) => {
      try {
        log(`Received /start command from user ${ctx.from.id}`);

        // Get custom buttons from settings or use defaults
        const buttons = await storage.getTelegramButtons() || [
          '/create - Create a new ticket',
          '/list - View your tickets',
          '/help - Show help'
        ];

        // Create markup for buttons
        const markup = Markup.keyboard(
          buttons.map(button => [button])
        ).resize();

        const welcomeMessage = "Welcome! I'll help you manage your support tickets. Your messages will be forwarded to our support team.";

        await ctx.reply(welcomeMessage, markup);
        log(`Sent welcome message with buttons to user ${ctx.from.id}`);
      } catch (error) {
        log(`Error handling start command: ${error}`, "error");
        await ctx.reply("Sorry, there was an error. Please try /start again.");
      }
    });

    // Handle messages
    this.bot.on("text", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      try {
        log(`Received message from Telegram user ${userId}: ${ctx.message.text}`);

        if (ctx.message.text.startsWith('/')) {
          // Handle commands
          const command = ctx.message.text.split(' ')[0].substring(1);
          switch (command) {
            case 'create':
              await ctx.reply('Please create a ticket through our website. Once created, you can chat here!');
              break;
            case 'list':
              await this.handleListTickets(ctx);
              break;
            case 'help':
              await this.handleHelp(ctx);
              break;
            default:
              // Unknown command
              await ctx.reply('Unknown command. Use /help to see available commands.');
          }
          return;
        }

        // Handle regular chat messages
        const user = await storage.getUserByTelegramId(userId.toString());
        if (!user) {
          log(`No user found for Telegram ID ${userId}`);
          await ctx.reply("Please register through our website first to create tickets.");
          return;
        }

        const activeTicket = await storage.getActiveTicketByUserId(user.id);
        if (!activeTicket) {
          log(`No active ticket found for user ${userId}`);
          await ctx.reply("You don't have an active ticket. Please create one through our website.");
          return;
        }

        // Forward to Discord
        await this.bridge.forwardToDiscord(
          ctx.message.text,
          activeTicket.id,
          ctx.from?.first_name || ctx.from?.username || "Telegram User"
        );
        log(`Message forwarded to Discord for ticket ${activeTicket.id}`);
      } catch (error) {
        log(`Error handling Telegram message: ${error}`, "error");
        await ctx.reply("Sorry, there was an error processing your message. Please try again later.");
      }
    });

    // Handle photos
    this.bot.on("photo", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      try {
        log(`Received photo from Telegram user ${userId}`);

        // Get user from storage
        const user = await storage.getUserByTelegramId(userId.toString());
        if (!user) {
          log(`No user found for Telegram ID ${userId}`);
          await ctx.reply("Please register through our website first to create tickets.");
          return;
        }

        // Check for active ticket
        const activeTicket = await storage.getActiveTicketByUserId(user.id);
        if (!activeTicket) {
          log(`No active ticket found for user ${userId}`);
          await ctx.reply("You don't have an active ticket. Please create one through our website.");
          return;
        }

        // Get the photo with highest quality
        const photos = ctx.message.photo;
        const photo = photos[photos.length - 1];

        // Get photo URL
        const fileLink = await ctx.telegram.getFileLink(photo.file_id);

        try {
          // Upload to ImgBB for permanent storage
          const imgbbUrl = await this.uploadToImgBB(fileLink.href);

          // Forward permanent URL to Discord
          await this.bridge.forwardToDiscord(
            `[Image] ${imgbbUrl}`,
            activeTicket.id,
            ctx.from?.first_name || ctx.from?.username || "Telegram User"
          );
          log(`Photo forwarded to Discord for ticket ${activeTicket.id}`);
        } catch (error) {
          log(`Error uploading to ImgBB: ${error}`, "error");
          await ctx.reply("Sorry, there was an error processing your image. Please try again later.");
        }
      } catch (error) {
        log(`Error handling Telegram photo: ${error}`, "error");
        await ctx.reply("Sorry, there was an error processing your photo. Please try again later.");
      }
    });

    // Error handler
    this.bot.catch((error) => {
      log(`Telegram bot error: ${error}`, "error");
    });
  }

  private async handleListTickets(ctx: any) {
    try {
      const user = await storage.getUserByTelegramId(ctx.from.id.toString());
      if (!user) {
        await ctx.reply("Please register through our website first to view tickets.");
        return;
      }

      const tickets = await storage.getTickets(user.id);
      if (!tickets || tickets.length === 0) {
        await ctx.reply("You don't have any tickets yet. Create one through our website!");
        return;
      }

      let message = "Your tickets:\n\n";
      tickets.forEach((ticket: any) => {
        message += `#${ticket.id} - ${ticket.status}\n`;
      });

      await ctx.reply(message);
    } catch (error) {
      log(`Error listing tickets: ${error}`, "error");
      await ctx.reply("Sorry, there was an error fetching your tickets.");
    }
  }

  private async handleHelp(ctx: any) {
    const helpText = `
Available commands:
/start - Show main menu
/create - Create a new ticket
/list - View your tickets
/help - Show this help message

You can also send messages and images directly when you have an active ticket.
    `;
    await ctx.reply(helpText);
  }

  async start() {
    if (this._isConnected) {
      log("Telegram bot is already running");
      return;
    }

    try {
      log("Starting Telegram bot...");
      this.connectionAttempts = 0;

      const tryConnect = async () => {
        try {
          await this.bot.launch();
          this._isConnected = true;
          log("Telegram bot started successfully");
        } catch (error) {
          this.connectionAttempts++;
          log(`Telegram connection attempt ${this.connectionAttempts} failed: ${error}`, "error");

          if (this.connectionAttempts < this.MAX_RETRIES) {
            log(`Retrying in ${this.RETRY_DELAY}ms...`);
            await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY));
            return tryConnect();
          }
          throw error;
        }
      };

      await tryConnect();
    } catch (error) {
      this._isConnected = false;
      log(`Error starting Telegram bot: ${error}`, "error");
      throw error;
    }
  }

  async stop() {
    if (!this._isConnected) {
      log("Telegram bot is not running");
      return;
    }

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
    return this._isConnected;
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
        // Use ImgBB URL directly if it's already uploaded
        await this.bot.telegram.sendPhoto(chatId, imageUrl, {
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