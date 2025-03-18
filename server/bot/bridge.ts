import { storage } from "../storage";
import { TelegramBot } from "./telegram";
import { DiscordBot } from "./discord";
import type { Ticket } from "@shared/schema";
import { log } from "../vite";
import fetch from 'node-fetch';
import { TextChannel } from 'discord.js';

interface ImageCacheEntry {
  telegramFileId?: string;
  discordUrl?: string;
  buffer?: Buffer;
  timestamp: number;
}

async function uploadToImgbb(buffer: Buffer): Promise<string | null> {
  try {
    const formData = new URLSearchParams();
    formData.append('image', buffer.toString('base64'));
    formData.append('name', `telegram_photo_${Date.now()}`);
    // Preserve image quality
    formData.append('quality', '100');
    // Don't auto-resize
    formData.append('width', '0');
    formData.append('height', '0');

    const response = await fetch(`https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`, {
      method: 'POST',
      body: formData,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      }
    });

    if (!response.ok) {
      throw new Error(`ImgBB API error: ${response.status}`);
    }

    const data = await response.json();

    // Log detailed image information
    log(`Successfully uploaded image to ImgBB:
    Original size: ${buffer.length} bytes
    URL: ${data.data.url}
    Display URL: ${data.data.display_url}
    Size: ${data.data.size} bytes
    Width: ${data.data.width}px
    Height: ${data.data.height}px
    Type: ${data.data.image.mime}`);

    // Use display_url which provides full resolution
    return data.data.display_url || data.data.url;
  } catch (error) {
    log(`Error uploading to ImgBB: ${error}`, "error");
    return null;
  }
}

async function forwardImageToDiscord(bridge: BridgeManager, channelId: string, buffer: Buffer, content: string | null, username: string, avatarUrl?: string): Promise<void> {
  try {
    // Try ImgBB first
    const imageUrl = await uploadToImgbb(buffer);

    if (imageUrl) {
      // Send as regular message with content and image URL
      const messageData = {
        content: `${content ? content.toString().trim() + '\n' : ''}${imageUrl}`,
        avatarURL: avatarUrl
      };

      await bridge.getDiscordBot().sendMessage(channelId, messageData, username);
      log(`Successfully sent image via ImgBB URL: ${imageUrl}`);
    } else {
      // Fallback to direct buffer upload
      log("Falling back to direct buffer upload");
      const messageData = {
        content: content ? content.toString().trim() : "\u200B",
        files: [{
          attachment: buffer,
          name: `telegram_photo_${Date.now()}.jpg`,
          description: 'Photo from Telegram'
        }],
        avatarURL: avatarUrl
      };

      await bridge.getDiscordBot().sendMessage(channelId, messageData, username);
      log("Successfully sent image via direct buffer upload");
    }
  } catch (error) {
    log(`Error forwarding image to Discord: ${error}`, "error");
    throw error;
  }
}

export class BridgeManager {
  private telegramBot: TelegramBot;
  private discordBot: DiscordBot;
  private retryAttempts: number = 0;
  private maxRetries: number = 3;
  private retryTimeout: number = 5000; // 5 seconds
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private readonly imageCacheTTL = 24 * 60 * 60 * 1000; // 24 hours
  private imageCache: Map<string, ImageCacheEntry> = new Map();
  private roleCache: Map<number, string> = new Map();

  constructor() {
    log("Initializing Bridge Manager");
    this.telegramBot = new TelegramBot(this);
    this.discordBot = new DiscordBot(this);
    this.startHealthCheck();
  }

  // Role ping methods with proper Discord formatting
  async pingRole(roleId: string, channelId: string, message?: string) {
    try {
      // Remove @ symbols and format for Discord mention
      const cleanRoleId = roleId.replace(/[@]/g, '');

      // Get channel from Discord client's cache
      const channel = this.discordBot.client.channels.cache.get(channelId) as TextChannel;
      if (channel?.isTextBased()) {
        // Send message as bot directly
        await channel.send({
          content: `<@&${cleanRoleId}>`,
          allowedMentions: { roles: [cleanRoleId] }
        });
        log(`Successfully pinged role ${cleanRoleId} in channel ${channelId}`);
      }
    } catch (error) {
      log(`Error pinging role: ${error}`, "error");
    }
  }

  async pingRoleForCategory(categoryId: number, channelId: string): Promise<void> {
    try {
      const category = await storage.getCategory(categoryId);
      if (!category?.discordRoleId) {
        log(`No role ID found for category ${categoryId}`);
        return;
      }

      // Cache the role ID for future use
      const cleanRoleId = category.discordRoleId.replace(/[@]/g, '');
      this.roleCache.set(categoryId, cleanRoleId);

      // Get channel from Discord client's cache
      const channel = this.discordBot.client.channels.cache.get(channelId) as TextChannel;
      if (channel?.isTextBased()) {
        // Send message as bot directly
        await channel.send({
          content: `<@&${cleanRoleId}>`,
          allowedMentions: { roles: [cleanRoleId] }
        });
        log(`Successfully pinged role ${cleanRoleId} for category ${categoryId}`);
      }
    } catch (error) {
      log(`Error pinging role for category: ${error}`, "error");
    }
  }

  // Image processing methods
  private async processTelegramToDiscord(fileId: string): Promise<Buffer | null> {
    try {
      if (!this.telegramBot.bot?.telegram) {
        throw new Error("Telegram bot not initialized");
      }

      log(`Processing Telegram file ID: ${fileId}`);

      const file = await this.telegramBot.bot.telegram.getFile(fileId);
      if (!file?.file_path) {
        throw new Error(`Could not get file path for ID: ${fileId}`);
      }

      const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      log(`Downloading file from: ${fileUrl}`);

      const response = await fetch(fileUrl);
      log(`Response status: ${response.status}`);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer || buffer.length === 0) {
        throw new Error("Received empty buffer");
      }

      log(`Successfully downloaded file, size: ${buffer.length} bytes`);
      return buffer;
    } catch (error) {
      log(`Error processing Telegram image: ${error}`, "error");
      return null;
    }
  }

  private async processDiscordToTelegram(url: string): Promise<Buffer | null> {
    try {
      const response = await fetch(url);
      if (!response.ok) return null;

      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      log(`Error processing Discord image: ${error}`, "error");
      return null;
    }
  }

  private setCachedImage(key: string, entry: Partial<ImageCacheEntry>) {
    this.imageCache.set(key, {
      ...entry,
      timestamp: Date.now()
    });
  }

  private getCachedImage(key: string): ImageCacheEntry | undefined {
    const entry = this.imageCache.get(key);
    if (!entry) return undefined;

    if (Date.now() - entry.timestamp > this.imageCacheTTL) {
      this.imageCache.delete(key);
      return undefined;
    }

    return entry;
  }
  private startHealthCheck() {
    // Run health check every 5 minutes
    this.healthCheckInterval = setInterval(async () => {
      try {
        const health = await this.healthCheck();
        if (!health.telegram || !health.discord) {
          log("Bot disconnected, attempting to reconnect...");
          await new Promise(resolve => setTimeout(resolve, 5000));
          await this.reconnectDisconnectedBots(health);
        }
      } catch (error) {
        log(`Health check failed: ${error}`, "error");
      }
    }, 300000); // 5 minutes
  }

  async start() {
    log("Starting bots...");
    try {
      await Promise.allSettled([
        this.startBotWithRetry(
          () => this.telegramBot.start(),
          "Telegram"
        ),
        this.startBotWithRetry(
          () => this.discordBot.start(),
          "Discord"
        )
      ]);
      log("Bots initialization completed");
    } catch (error) {
      log(`Error starting bots: ${error}`, "error");
    }
  }

  private async startBotWithRetry(
    startFn: () => Promise<void>,
    botName: string
  ): Promise<void> {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        // Add significant delay between attempts
        if (attempt > 1) {
          log(`Waiting ${this.retryTimeout/1000} seconds before attempt ${attempt}...`);
          await new Promise(resolve => setTimeout(resolve, this.retryTimeout));
        }

        log(`Starting ${botName} bot (attempt ${attempt}/${this.maxRetries})...`);
        await startFn();

        this.retryAttempts = 0; // Reset on success
        log(`${botName} bot started successfully`);
        return;
      } catch (error) {
        log(`${botName} bot start attempt ${attempt} failed: ${error}`, "error");

        if (attempt === this.maxRetries) {
          log(`${botName} bot failed to start after ${this.maxRetries} attempts`, "error");
          throw error;
        }

        // Add longer delay after failure
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  async restart() {
    log("Restarting bots with new configuration...");
    try {
      // Clear health check interval
      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = null;
      }

      // Stop both bots with graceful shutdown
      await Promise.allSettled([
        this.telegramBot.stop(),
        this.discordBot.stop()
      ]);

      // Add longer delay before creating new instances
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Create new instances with updated tokens
      this.telegramBot = new TelegramBot(this);
      this.discordBot = new DiscordBot(this);

      // Start both bots with retry mechanism
      await this.start();

      // Restart health check
      this.startHealthCheck();

      log("Bots restarted successfully");
    } catch (error) {
      log(`Error restarting bots: ${error}`, "error");
      throw error;
    }
  }

  private async reconnectDisconnectedBots(health: { telegram: boolean; discord: boolean }) {
    try {
      if (!health.telegram) {
        log("Attempting to reconnect Telegram bot...");
        // Add longer delay before reconnection
        await new Promise(resolve => setTimeout(resolve, 5000));
        await this.startBotWithRetry(() => this.telegramBot.start(), "Telegram");
      }
      if (!health.discord) {
        log("Attempting to reconnect Discord bot...");
        await this.startBotWithRetry(() => this.discordBot.start(), "Discord");
      }
    } catch (error) {
      log(`Error reconnecting bots: ${error}`, "error");
      throw error;
    }
  }

  async healthCheck(): Promise<{
    telegram: boolean;
    discord: boolean;
  }> {
    try {
      // Add delay to prevent rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
      return {
        telegram: this.telegramBot.getIsConnected(),
        discord: this.discordBot.isReady()
      };
    } catch (error) {
      log(`Error in health check: ${error}`, "error");
      return {
        telegram: false,
        discord: false
      };
    }
  }

  async moveToTranscripts(ticketId: number): Promise<void> {
    try {
      const ticket = await storage.getTicket(ticketId);
      log(`Moving ticket to transcripts. Ticket data:`, JSON.stringify(ticket, null, 2));

      if (!ticket || !ticket.discordChannelId) {
        throw new Error(`Invalid ticket or missing Discord channel: ${ticketId}`);
      }

      // Get category for transcript category ID
      const category = await storage.getCategory(ticket.categoryId!);
      log(`Category data for ticket:`, JSON.stringify(category, null, 2));

      // More strict checking for transcriptCategoryId
      if (!category) {
        throw new Error("Category not found");
      }

      // More strict checking for transcriptCategoryId
      if (!category.transcriptCategoryId) {
        log(`No transcript category ID found for category ${category.id}`);
        throw new Error("No transcript category set for this service");
      }

      if (category.transcriptCategoryId.trim() === '') {
        log(`Empty transcript category ID for category ${category.id}`);
        throw new Error("No transcript category set for this service");
      }

      log(`Moving channel ${ticket.discordChannelId} to transcript category ${category.transcriptCategoryId}`);

      // Move channel to transcripts category
      await this.discordBot.moveChannelToCategory(
        ticket.discordChannelId,
        category.transcriptCategoryId
      );

      // Update ticket status
      await storage.updateTicketStatus(ticket.id, "closed");

      log(`Successfully moved ticket ${ticketId} to transcripts category ${category.transcriptCategoryId}`);
    } catch (error) {
      log(`Error moving ticket to transcripts: ${error}`, "error");
      throw error;
    }
  }

  async createTicketChannel(ticket: Ticket) {
    if (!ticket.categoryId) {
      throw new Error("Ticket must have a category");
    }

    const category = await storage.getCategory(ticket.categoryId);
    if (!category) {
      throw new Error("Category not found");
    }

    if (!ticket.userId) {
      throw new Error("Ticket must have a user");
    }

    const user = await storage.getUser(ticket.userId);
    if (!user) {
      throw new Error("User not found");
    }

    const tickets = await storage.getTicketsByCategory(ticket.categoryId);
    const ticketCount = tickets.length;
    const channelName = `${category.name.toLowerCase()}-${ticketCount + 1}`;

    log(`Creating ticket channel: ${channelName}`);

    try {
      // Create Discord channel
      const channelId = await this.discordBot.createTicketChannel(
        category.discordCategoryId,
        channelName
      );
      log(`Discord channel created with ID: ${channelId}`);

      // Update ticket with Discord channel ID
      await storage.updateTicketDiscordChannel(ticket.id, channelId);

      const updatedTicket = await storage.getTicket(ticket.id);
      log(`Updated ticket status: ${JSON.stringify(updatedTicket)}`);

      // Send only one embed for the ticket creation with pinning
      const embed = {
        username: "Ticket Bot",
        embeds: [{
          title: "🎫 New Ticket",
          description: "A new support ticket has been created",
          color: 0x5865F2,
          fields: category.questions.map((question, index) => ({
            name: question,
            value: `\`${ticket.answers?.[index] || 'No answer provided'}\``,
            inline: false
          }))
        }]
      };

      // Send and pin the ticket message
      await this.discordBot.sendTicketMessage(channelId, embed);

      // Send role ping if category has a role
      if (category.discordRoleId) {
        await this.pingRoleForCategory(ticket.categoryId, channelId);
      }

      log(`Ticket channel created: ${channelName}`);
    } catch (error) {
      log(`Error creating Discord channel: ${error}`, "error");

      // Check if error is due to channel limit
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('Maximum number of channels in category') ||
        errorMessage.includes('channel limit')) {
        // Update ticket status to pending
        await storage.updateTicketStatus(ticket.id, "pending");
        throw new Error("Category is at maximum channel limit. Please try again later or contact an administrator.");
      }

      // For other errors, mark ticket as open but without channel
      await storage.updateTicketStatus(ticket.id, "open");
      throw error;
    }
  }

  async forwardToTelegram(content: string, ticketId: number, username: string, attachments?: any[]) {
    try {
      const ticket = await storage.getTicket(ticketId);
      log(`Forwarding to Telegram - Ticket: ${JSON.stringify(ticket)}`);

      if (!ticket || !ticket.userId) {
        log(`Invalid ticket or missing user ID: ${ticketId}`, "error");
        return;
      }

      const user = await storage.getUser(ticket.userId);
      log(`Found user: ${JSON.stringify(user)}`);

      if (!user || !user.telegramId) {
        log(`Invalid user or missing Telegram ID for ticket: ${ticketId}`, "error");
        return;
      }

      if (!user.telegramId.match(/^\d+$/)) {
        log(`Invalid Telegram ID format for user: ${user.id}`, "error");
        return;
      }

      // Handle attachments if present
      if (attachments && attachments.length > 0) {
        // Store message with attachment indication
        await storage.createMessage({
          ticketId,
          content: content || "Image sent",
          authorId: user.id,
          platform: "discord",
          timestamp: new Date()
        });

        // Send text content if any
        if (content?.trim()) {
          await this.telegramBot.sendMessage(parseInt(user.telegramId), `${username}: ${content}`);
        }

        // Process each attachment
        for (const attachment of attachments) {
          if (attachment.url) {
            try {
              const cacheKey = attachment.url;
              const cachedImage = this.getCachedImage(cacheKey);

              if (cachedImage?.telegramFileId) {
                log(`Using cached Telegram fileId for ${attachment.url}`);
                await this.telegramBot.sendCachedPhoto(parseInt(user.telegramId), cachedImage.telegramFileId, `Image from ${username}`);
                continue;
              }

              log(`Processing Discord attachment: ${attachment.url}`);
              const buffer = await this.processDiscordToTelegram(attachment.url);
              if (!buffer) {
                throw new Error("Failed to process image");
              }
              log(`Successfully processed image, size: ${buffer.length} bytes`);

              const caption = `Image from ${username}`;
              const fileId = await this.telegramBot.sendPhoto(parseInt(user.telegramId), buffer, caption);

              if (fileId) {
                this.setCachedImage(cacheKey, { telegramFileId: fileId, buffer });
              }

              log(`Successfully sent photo to Telegram user ${user.telegramId}`);
            } catch (error) {
              log(`Error sending photo to Telegram: ${error}`, "error");
            }
          }
        }
        return;
      }

      // Handle text messages with image URLs
      const imageUrlMatch = content.match(/(https?:\/\/[^\s]+\.(jpg|jpeg|png|gif))/i);
      if (imageUrlMatch) {
        const imageUrl = imageUrlMatch[0];
        const textContent = content.replace(imageUrl, '').trim();

        // Store message
        await storage.createMessage({
          ticketId,
          content: textContent || "Image sent",
          authorId: user.id,
          platform: "discord",
          timestamp: new Date()
        });

        // Send text if any
        if (textContent) {
          await this.telegramBot.sendMessage(parseInt(user.telegramId), `${username}: ${textContent}`);
        }

        // Process and send the image
        try {
          const cacheKey = imageUrl;
          const cachedImage = this.getCachedImage(cacheKey);

          if (cachedImage?.telegramFileId) {
            log(`Using cached Telegram fileId for ${imageUrl}`);
            await this.telegramBot.sendCachedPhoto(parseInt(user.telegramId), cachedImage.telegramFileId, `Image from ${username}`);
            return;
          }

          log(`Processing Discord image URL: ${imageUrl}`);
          const buffer = await this.processDiscordToTelegram(imageUrl);
          if (!buffer) {
            throw new Error("Failed to process image");
          }
          log(`Successfully processed image, size: ${buffer.length} bytes`);

          const fileId = await this.telegramBot.sendPhoto(parseInt(user.telegramId), buffer, `Image from ${username}`);

          if (fileId) {
            this.setCachedImage(cacheKey, { telegramFileId: fileId, buffer });
          }

          log(`Successfully sent photo to Telegram user ${user.telegramId}`);
        } catch (error) {
          log(`Error processing and sending image: ${error}`, "error");
        }
      } else {
        // Regular text message handling
        await storage.createMessage({
          ticketId,
          content,
          authorId: user.id,
          platform: "discord",
          timestamp: new Date()
        });
        await this.telegramBot.sendMessage(parseInt(user.telegramId), `${username}: ${content}`);
      }

      log(`Successfully sent message to Telegram user: ${user.username}`);
    } catch (error) {
      log(`Error forwarding to Telegram: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  async forwardToDiscord(content: string, ticketId: number, username: string, avatarUrl?: string, photo?: string, firstName?: string, lastName?: string) {
    try {
      const ticket = await storage.getTicket(ticketId);
      log(`Forwarding to Discord - Ticket: ${JSON.stringify(ticket)}`);

      if (!ticket || !ticket.discordChannelId) {
        log(`Invalid ticket or missing Discord channel: ${ticketId}`, "error");
        return;
      }

      const displayName = [firstName, lastName]
        .filter(Boolean)
        .join(' ') || username;

      // Handle photo if present
      if (photo) {
        try {
          log(`Processing photo with ID: ${photo}`);
          const buffer = await this.processTelegramToDiscord(photo);

          if (!buffer) {
            throw new Error("Failed to process image");
          }

          log(`Successfully processed image, size: ${buffer.length} bytes`);

          // Send text content first if exists
          if (content?.trim()) {
            await this.discordBot.sendMessage(
              ticket.discordChannelId,
              {
                content: content.toString().trim(),
                avatarURL: avatarUrl
              },
              displayName
            );
          }

          // Forward the image using our helper function
          await forwardImageToDiscord(
            this,
            ticket.discordChannelId,
            buffer,
            null, // Send image without duplicate content
            displayName,
            avatarUrl
          );

        } catch (error) {
          log(`Error processing photo: ${error}`, "error");
          // If photo fails, still try to send the text content
          if (content?.trim()) {
            await this.discordBot.sendMessage(
              ticket.discordChannelId,
              {
                content: content.toString().trim(),
                avatarURL: avatarUrl
              },
              displayName
            );
          }
        }
      } else {
        // Regular text message
        await this.discordBot.sendMessage(
          ticket.discordChannelId,
          {
            content: content ? content.toString().trim() : "\u200B",
            avatarURL: avatarUrl
          },
          displayName
        );
      }

      log(`Successfully forwarded message to Discord channel: ${ticket.discordChannelId}`);
    } catch (error) {
      log(`Error in forwardToDiscord: ${error}`, "error");
    }
  }


  async forwardPingToTelegram(ticketId: number, discordUsername: string) {
    try {
      const ticket = await storage.getTicket(ticketId);
      if (!ticket || !ticket.userId) {
        throw new Error("Invalid ticket or missing user ID");
      }

      const user = await storage.getUser(ticket.userId);
      if (!user || !user.telegramId) {
        throw new Error("Could not find Telegram information for ticket creator");
      }

      // Send ping notification to Telegram user with @ mention
      await this.telegramBot.sendMessage(
        parseInt(user.telegramId),
        `🔔 @${user.username} You've been pinged by ${discordUsername} in ticket #${ticketId}`
      );

      log(`Successfully sent ping to Telegram user ${user.telegramId}`);
    } catch (error) {
      log(`Error forwarding ping to Telegram: ${error}`, "error");
      throw error;
    }
  }

  async forwardPingToDiscord(ticketId: number, telegramUsername: string) {
    try {
      const ticket = await storage.getTicket(ticketId);
      if (!ticket || !ticket.categoryId) {
        throw new Error("Invalid ticket or missing category");
      }

      const category = await storage.getCategory(ticket.categoryId);
      if (!category || !category.discordRoleId) {
        throw new Error("No role ID found for category");
      }

      if (!ticket.discordChannelId) {
        throw new Error("No Discord channel found for ticket");
      }

      // Send role ping with improved formatting
      await this.discordBot.sendMessage(
        ticket.discordChannelId,
        {
          content: `🔔 <@&${category.discordRoleId}> You've been pinged by @${telegramUsername} in ticket #${ticketId}`,
          allowedMentions: { roles: [category.discordRoleId] }
        },
        "Ticket Bot"
      );

      log(`Successfully sent ping to Discord role ${category.discordRoleId}`);
    } catch (error) {
      log(`Error forwarding ping to Discord: ${error}`, "error");
      throw error;
    }
  }

  getTelegramBot(): TelegramBot {
    return this.telegramBot;
  }

  getDiscordBot(): DiscordBot {
    return this.discordBot;
  }
}