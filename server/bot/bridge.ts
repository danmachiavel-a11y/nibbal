import { storage } from "../storage";
// Use the safer implementation with enhanced null-safety
import { TelegramBot } from "./telegram-safer";
import { DiscordBot } from "./discord";
import type { Ticket } from "@shared/schema";
import { log } from "../vite";
import fetch from 'node-fetch';
import { TextChannel } from 'discord.js';

class BridgeError extends Error {
  code?: string;
  details?: any;
  context?: string;

  constructor(message: string, details?: { context?: string; code?: string; details?: any }) {
    super(message);
    this.name = 'BridgeError';
    
    if (details) {
      this.context = details.context;
      this.code = details.code;
      this.details = details.details;
    }
  }
}

// Centralized error handler
const handleBridgeError = (error: Error, context: string): void => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorDetails = {
    context,
    code: error instanceof BridgeError ? error.code : undefined,
    details: error instanceof BridgeError ? error.details : undefined,
    timestamp: new Date().toISOString()
  };
  log(`Error in ${context}: ${errorMessage}`, "error");
  log(`Error details: ${JSON.stringify(errorDetails)}`, "error");
};

interface ImageCacheEntry {
  telegramFileId?: string;
  discordUrl?: string;
  buffer?: Buffer;
  timestamp: number;
  size: number;  // Track size in bytes
}

export class BridgeManager {
  private telegramBot: TelegramBot;
  private discordBot: DiscordBot;
  private retryAttempts: number = 0;
  private maxRetries: number = 3;
  private retryTimeout: number = 5000;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private readonly imageCacheTTL = 24 * 60 * 60 * 1000; // 24 hours
  private readonly maxImageCacheSize = 500 * 1024 * 1024; // 500MB
  private currentImageCacheSize = 0;
  private imageCache: Map<string, ImageCacheEntry> = new Map();
  private roleCache: Map<number, string> = new Map();
  private readonly imageCacheCleanupInterval = 3600000; // 1 hour
  // Add at the top with other constants
  private readonly MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB per image
  private readonly MIN_IMAGE_SIZE = 32; // 32 bytes minimum


  constructor() {
    log("Initializing Bridge Manager");
    this.telegramBot = new TelegramBot(this);
    this.discordBot = new DiscordBot(this);
    this.startHealthCheck();
    this.startImageCacheCleanup();
  }

  private startImageCacheCleanup(): void {
    setInterval(() => this.cleanupImageCache(), this.imageCacheCleanupInterval);
  }

  private cleanupImageCache(): void {
    const now = Date.now();
    let deletedSize = 0;

    // Remove expired entries
    for (const [key, entry] of this.imageCache.entries()) {
      if (now - entry.timestamp > this.imageCacheTTL) {
        this.imageCache.delete(key);
        if (entry.buffer) {
          deletedSize += entry.buffer.length;
          // Avoid potential negative values in case of race conditions
          this.currentImageCacheSize = Math.max(0, this.currentImageCacheSize - entry.buffer.length);
        }
      }
    }

    // If still over size limit, remove oldest entries
    if (this.currentImageCacheSize > this.maxImageCacheSize) {
      const entries = Array.from(this.imageCache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);

      while (this.currentImageCacheSize > this.maxImageCacheSize && entries.length > 0) {
        const [key, entry] = entries.shift()!;
        this.imageCache.delete(key);
        if (entry.buffer) {
          deletedSize += entry.buffer.length;
          // Avoid potential negative values in case of race conditions
          this.currentImageCacheSize = Math.max(0, this.currentImageCacheSize - entry.buffer.length);
        }
      }
    }

    if (deletedSize > 0) {
      log(`Cleaned up ${(deletedSize / 1024 / 1024).toFixed(2)}MB from image cache`);
    }
  }

  private setCachedImage(key: string, entry: Partial<ImageCacheEntry>) {
    const buffer = entry.buffer;
    if (buffer) {
      // Check if adding this would exceed cache size
      if (this.currentImageCacheSize + buffer.length > this.maxImageCacheSize) {
        this.cleanupImageCache(); // Try to free up space

        // If still would exceed, don't cache
        if (this.currentImageCacheSize + buffer.length > this.maxImageCacheSize) {
          log(`Skipping cache for large image: ${buffer.length} bytes`);
          return;
        }
      }
      this.currentImageCacheSize += buffer.length;
    }

    this.imageCache.set(key, {
      ...entry,
      timestamp: Date.now(),
      size: buffer?.length || 0
    } as ImageCacheEntry);
  }

  private getCachedImage(key: string): ImageCacheEntry | undefined {
    const entry = this.imageCache.get(key);
    if (!entry) return undefined;

    if (Date.now() - entry.timestamp > this.imageCacheTTL) {
      if (entry.buffer) {
        // Avoid potential negative values in case of race conditions
        this.currentImageCacheSize = Math.max(0, this.currentImageCacheSize - entry.buffer.length);
      }
      this.imageCache.delete(key);
      return undefined;
    }

    return entry;
  }

  private async validateAndProcessImage(buffer: Buffer, context: string): Promise<Buffer | null> {
    try {
      if (!buffer || buffer.length < this.MIN_IMAGE_SIZE) {
        throw new BridgeError("Image too small or empty", { context });
      }

      if (buffer.length > this.MAX_IMAGE_SIZE) {
        throw new BridgeError(`Image too large (${buffer.length} bytes)`, { context });
      }

      return buffer;
    } catch (error) {
      handleBridgeError(error as BridgeError, context);
      return null;
    }
  }

  private async processTelegramToDiscord(fileId: string): Promise<Buffer | null> {
    try {
      // Try cache first
      const cacheKey = `telegram_${fileId}`;
      const cached = this.getCachedImage(cacheKey);
      if (cached?.buffer) {
        log(`Using cached buffer for Telegram file ${fileId}`);
        return cached.buffer;
      }

      log(`Processing Telegram file ID: ${fileId}`);

      // Use the telegram getter from TelegramBot which has built-in null safety
      const file = await this.telegramBot.getFile(fileId);
      if (!file?.file_path) {
        throw new Error(`Could not get file path for ID: ${fileId}`);
      }

      const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

      // Use Promise.race to implement timeout
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Download timeout')), 30000)
      );

      const response = await Promise.race([
        fetch(fileUrl),
        timeoutPromise
      ]) as Response;

      if (!response.ok) {
        throw new BridgeError(`HTTP error! status: ${response.status}`, { context: "processTelegramToDiscord" });
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const validatedBuffer = await this.validateAndProcessImage(buffer, "processTelegramToDiscord");
      if (!validatedBuffer) {
        return null;
      }

      // Cache the result
      this.setCachedImage(cacheKey, { buffer: validatedBuffer });

      log(`Successfully downloaded file, size: ${validatedBuffer.length} bytes`);
      return validatedBuffer;
    } catch (error) {
      handleBridgeError(error as BridgeError, "processTelegramToDiscord");
      return null;
    }
  }

  private async processDiscordToTelegram(url: string): Promise<Buffer | null> {
    try {
      // Try cache first
      const cacheKey = `discord_${url}`;
      const cached = this.getCachedImage(cacheKey);
      if (cached?.buffer) {
        log(`Using cached buffer for Discord URL ${url}`);
        return cached.buffer;
      }

      // Use Promise.race to implement timeout
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Download timeout')), 30000)
      );

      const response = await Promise.race([
        fetch(url),
        timeoutPromise
      ]) as Response;

      if (!response.ok) {
        throw new BridgeError(`Failed to fetch Discord image: ${response.status}`, { context: "processDiscordToTelegram" });
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const validatedBuffer = await this.validateAndProcessImage(buffer, "processDiscordToTelegram");
      if (!validatedBuffer) {
        return null;
      }

      // Cache the result
      this.setCachedImage(cacheKey, { buffer: validatedBuffer });

      return validatedBuffer;
    } catch (error) {
      handleBridgeError(error as BridgeError, "processDiscordToTelegram");
      return null;
    }
  }
  private startHealthCheck() {
    // Run health check every 15 minutes (matching Telegram bot's heartbeat)
    this.healthCheckInterval = setInterval(async () => {
      try {
        const health = await this.healthCheck();
        if (!health.telegram || !health.discord) {
          log("Bot disconnected, attempting to reconnect...");
          // Add delay before reconnection attempt
          await new Promise(resolve => setTimeout(resolve, 5000));
          await this.reconnectDisconnectedBots(health);
        }
      } catch (error) {
        handleBridgeError(error as BridgeError, "healthCheck");
      }
    }, 900000); // 15 minutes to match Telegram bot's heartbeat
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
      handleBridgeError(error as BridgeError, "start");
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
          log(`Waiting ${this.retryTimeout / 1000} seconds before attempt ${attempt}...`);
          await new Promise(resolve => setTimeout(resolve, this.retryTimeout));
        }

        log(`Starting ${botName} bot (attempt ${attempt}/${this.maxRetries})...`);
        await startFn();

        this.retryAttempts = 0; // Reset on success
        log(`${botName} bot started successfully`);
        return;
      } catch (error) {
        handleBridgeError(error as BridgeError, `startBotWithRetry-${botName}-${attempt}`);

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
      handleBridgeError(error as BridgeError, "restart");
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
      handleBridgeError(error as BridgeError, "reconnectDisconnectedBots");
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
      handleBridgeError(error as BridgeError, "healthCheck");
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
        throw new BridgeError(`Invalid ticket or missing Discord channel: ${ticketId}`, { context: "moveToTranscripts" });
      }

      // Get category for transcript category ID
      const category = await storage.getCategory(ticket.categoryId!);
      log(`Category data for ticket:`, JSON.stringify(category, null, 2));

      // More strict checking for transcriptCategoryId
      if (!category) {
        throw new BridgeError("Category not found", { context: "moveToTranscripts" });
      }

      // More strict checking for transcriptCategoryId
      if (!category.transcriptCategoryId) {
        log(`No transcript category ID found for category ${category.id}`);
        throw new BridgeError("No transcript category set for this service", { context: "moveToTranscripts" });
      }

      if (category.transcriptCategoryId.trim() === '') {
        log(`Empty transcript category ID for category ${category.id}`);
        throw new BridgeError("No transcript category set for this service", { context: "moveToTranscripts" });
      }

      log(`Moving channel ${ticket.discordChannelId} to transcript category ${category.transcriptCategoryId}`);

      // Move channel to transcripts category with isTranscriptCategory=true
      await this.discordBot.moveChannelToCategory(
        ticket.discordChannelId,
        category.transcriptCategoryId,
        true // Specify this is a transcript category for proper permissions
      );

      // Update ticket status
      await storage.updateTicketStatus(ticket.id, "closed");

      log(`Successfully moved ticket ${ticketId} to transcripts category ${category.transcriptCategoryId}`);
    } catch (error) {
      handleBridgeError(error as BridgeError, "moveToTranscripts");
      throw error;
    }
  }
  
  async moveFromTranscripts(ticketId: number): Promise<void> {
    try {
      const ticket = await storage.getTicket(ticketId);
      log(`Moving ticket from transcripts back to active. Ticket data:`, JSON.stringify(ticket, null, 2));

      if (!ticket || !ticket.discordChannelId) {
        throw new BridgeError(`Invalid ticket or missing Discord channel: ${ticketId}`, { context: "moveFromTranscripts" });
      }

      // Get category info
      const category = await storage.getCategory(ticket.categoryId!);
      log(`Category data for ticket:`, JSON.stringify(category, null, 2));

      if (!category) {
        throw new BridgeError("Category not found", { context: "moveFromTranscripts" });
      }

      // Check if category has a Discord category ID
      if (!category.discordCategoryId) {
        log(`No Discord category ID found for category ${category.id}`);
        throw new BridgeError("No Discord category set for this service", { context: "moveFromTranscripts" });
      }

      if (category.discordCategoryId.trim() === '') {
        log(`Empty Discord category ID for category ${category.id}`);
        throw new BridgeError("No Discord category set for this service", { context: "moveFromTranscripts" });
      }

      log(`Moving channel ${ticket.discordChannelId} back to category ${category.discordCategoryId}`);

      // Move channel back to original category
      // Setting isTranscriptCategory to false will apply the appropriate permissions
      await this.discordBot.moveChannelToCategory(
        ticket.discordChannelId,
        category.discordCategoryId,
        false  // Specify this is NOT a transcript category for proper permissions
      );

      // Update ticket status
      await storage.updateTicketStatus(ticket.id, "open");

      log(`Successfully moved ticket ${ticketId} back to category ${category.discordCategoryId}`);
    } catch (error) {
      handleBridgeError(error as BridgeError, "moveFromTranscripts");
      throw error;
    }
  }

  async createTicketChannel(ticket: Ticket) {
    if (!ticket.categoryId) {
      throw new BridgeError("Ticket must have a category", { context: "createTicketChannel" });
    }

    const category = await storage.getCategory(ticket.categoryId);
    if (!category) {
      throw new BridgeError("Category not found", { context: "createTicketChannel" });
    }

    if (!ticket.userId) {
      throw new BridgeError("Ticket must have a user", { context: "createTicketChannel" });
    }

    const user = await storage.getUser(ticket.userId);
    if (!user) {
      throw new BridgeError("User not found", { context: "createTicketChannel" });
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
      handleBridgeError(error as BridgeError, "createTicketChannel");

      // Check if error is due to channel limit
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('Maximum number of channels in category') ||
        errorMessage.includes('channel limit')) {
        // Update ticket status to pending
        await storage.updateTicketStatus(ticket.id, "pending");
        throw new BridgeError("Category is at maximum channel limit. Please try again later or contact an administrator.", { context: "createTicketChannel" });
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
                throw new BridgeError("Failed to process image", { context: "forwardToTelegram" });
              }
              log(`Successfully processed image, size: ${buffer.length} bytes`);

              const caption = `Image from ${username}`;
              const fileId = await this.telegramBot.sendPhoto(parseInt(user.telegramId), buffer, caption);

              if (fileId) {
                this.setCachedImage(cacheKey, { telegramFileId: fileId, buffer });
              }

              log(`Successfully sent photo to Telegram user ${user.telegramId}`);
            } catch (error) {
              handleBridgeError(error as BridgeError, "forwardToTelegram-attachment");
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
            throw new BridgeError("Failed to process image", { context: "forwardToTelegram" });
          }
          log(`Successfully processed image, size: ${buffer.length} bytes`);

          const fileId = await this.telegramBot.sendPhoto(parseInt(user.telegramId), buffer, `Image from ${username}`);

          if (fileId) {
            this.setCachedImage(cacheKey, { telegramFileId: fileId, buffer });
          }

          log(`Successfully sent photo to Telegram user ${user.telegramId}`);
        } catch (error) {
          handleBridgeError(error as BridgeError, "forwardToTelegram-image");
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
      handleBridgeError(error as BridgeError, "forwardToTelegram");
    }
  }

  async forwardToDiscord(content: string, ticketId: number, username: string, avatarUrl?: string, photo?: string, firstName?: string, lastName?: string) {
    try {
      const ticket = await storage.getTicket(ticketId);
      log(`Forwarding to Discord - Ticket: ${JSON.stringify(ticket)}`);

      if (!ticket || !ticket.discordChannelId) {
        throw new BridgeError(`Invalid ticket or missing Discord channel: ${ticketId}`, { context: "forwardToDiscord" });
      }

      const displayName = [firstName, lastName]
        .filter(Boolean)
        .join(' ') || username;

      if (photo) {
        try {
          const buffer = await this.processTelegramToDiscord(photo);
          if (!buffer) {
            throw new BridgeError("Failed to process image", { context: "forwardToDiscord" });
          }

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

          await this.forwardImageToDiscord(
            ticket.discordChannelId,
            buffer,
            null,
            displayName,
            avatarUrl
          );

        } catch (error) {
          handleBridgeError(error as BridgeError, "forwardToDiscord-photo");
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
      handleBridgeError(error as BridgeError, "forwardToDiscord");
    }
  }


  async forwardPingToTelegram(ticketId: number, discordUsername: string) {
    try {
      const ticket = await storage.getTicket(ticketId);
      if (!ticket?.userId) {
        throw new BridgeError("Invalid ticket or missing user ID", { code: "INVALID_TICKET", context: "forwardPingToTelegram" });
      }

      const user = await storage.getUser(ticket.userId);
      if (!user?.telegramId) {
        throw new BridgeError("Could not find Telegram information for ticket creator", { code: "USER_NOT_FOUND", context: "forwardPingToTelegram" });
      }

      await this.telegramBot.sendMessage(
        parseInt(user.telegramId),
        `🔔 @${user.username} You've been pinged by ${discordUsername} in ticket #${ticketId}`
      );

      log(`Successfully sent ping to Telegram user ${user.telegramId}`);
    } catch (error) {
      handleBridgeError(error as BridgeError, "forwardPingToTelegram");
      throw error;
    }
  }

  async forwardPingToDiscord(ticketId: number, telegramUsername: string) {
    try {
      const ticket = await storage.getTicket(ticketId);
      if (!ticket?.categoryId) {
        throw new BridgeError("Invalid ticket or missing category", { code: "INVALID_TICKET", context: "forwardPingToDiscord" });
      }

      const category = await storage.getCategory(ticket.categoryId);
      if (!category?.discordRoleId) {
        throw new BridgeError("No role ID found for category", { code: "MISSING_ROLE", context: "forwardPingToDiscord" });
      }

      if (!ticket.discordChannelId) {
        throw new BridgeError("No Discord channel found for ticket", { code: "MISSING_CHANNEL", context: "forwardPingToDiscord" });
      }

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
      handleBridgeError(error as BridgeError, "forwardPingToDiscord");
      throw error;
    }
  }

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
      handleBridgeError(error as BridgeError, "pingRole");
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
      handleBridgeError(error as BridgeError, "pingRoleForCategory");
    }
  }

  // Image processing methods
  async forwardImageToDiscord(channelId: string, buffer: Buffer, content: string | null, username: string, avatarUrl?: string): Promise<void> {
    try {
      // Generate unique ID for this image transfer for better logging
      const transferId = Date.now().toString(36) + Math.random().toString(36).substring(2, 5);
      log(`[${transferId}] Starting image transfer to Discord: ${buffer.length} bytes`);
      
      // Prepare base message data regardless of upload method
      const baseMessageData = {
        content: content ? content.toString().trim() : "\u200B",
        username,
        avatarURL: avatarUrl
      };
      
      // Check if image size is within reasonable limits (1KB to 10MB)
      if (buffer.length < 1024 || buffer.length > 10 * 1024 * 1024) {
        log(`[${transferId}] Image size outside acceptable range (${buffer.length} bytes), skipping ImgBB`, "warn");
        // Skip ImgBB attempt for extremely small or large images to avoid wasting API calls
        await this.sendDirectImageToDiscord(channelId, buffer, baseMessageData, username, transferId);
        return;
      }
      
      try {
        // Start ImgBB upload with retry and timeout
        log(`[${transferId}] Attempting ImgBB upload first...`);
        
        // Use improved uploadToImgbb with retry logic
        // Create a timer for overall timeout (different from internal retry timeouts)
        const uploadTimeout = 25000; // 25 seconds max total time
        
        // Set upload start time
        const uploadStart = Date.now();
        
        // Use a Promise.race between the upload and a timeout
        const timeoutPromise = new Promise<null>((_, reject) => {
          setTimeout(() => reject(new Error('ImgBB upload timeout (global)')), uploadTimeout);
        });
        
        // Start the upload process with retry capability (3 attempts, 2 second initial delay)
        const imageUrl = await Promise.race([
          uploadToImgbb(buffer, 3, 2000),
          timeoutPromise
        ]);
        
        const uploadTime = Date.now() - uploadStart;
        
        if (imageUrl) {
          // ImgBB upload succeeded - send message with the URL
          log(`[${transferId}] ImgBB upload successful in ${uploadTime}ms, sending as URL`);
          
          // Create message with the URL at the end
          const messageData = {
            ...baseMessageData,
            content: baseMessageData.content ? 
              `${baseMessageData.content}\n${imageUrl}`.trim() : 
              imageUrl
          };
          
          // Send via Discord webhook
          await this.discordBot.sendMessage(channelId, messageData, username);
          log(`[${transferId}] Successfully sent image via ImgBB URL`);
          return;
        } else {
          // Upload returned null without throwing (unlikely but possible)
          log(`[${transferId}] ImgBB upload returned null without error after ${uploadTime}ms`, "warn");
        }
      } catch (error) {
        // Handle ImgBB upload failure
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(`[${transferId}] ImgBB upload failed: ${errorMessage}`, "warn");
        
        // Check if error suggests API key issues
        if (errorMessage.includes('API key') || errorMessage.includes('401') || errorMessage.includes('403')) {
          log(`[${transferId}] Possible API key issues detected with ImgBB`, "error");
        }
      }
      
      // Fallback to direct upload
      await this.sendDirectImageToDiscord(channelId, buffer, baseMessageData, username, transferId);
    } catch (error) {
      handleBridgeError(error as BridgeError, "forwardImageToDiscord");
      throw error;
    }
  }
  
  // Helper method for direct Discord image uploads
  private async sendDirectImageToDiscord(
    channelId: string, 
    buffer: Buffer, 
    baseMessageData: any, 
    username: string,
    transferId: string
  ): Promise<void> {
    log(`[${transferId}] Using direct buffer upload to Discord (${buffer.length} bytes)`);
    
    // Build message with file attachment
    const messageData = {
      ...baseMessageData,
      files: [{
        attachment: buffer,
        name: `photo_${transferId}.jpg`, // Use transfer ID for consistent naming
        description: 'Photo from Telegram'
      }]
    };
    
    // Send to Discord
    await this.discordBot.sendMessage(channelId, messageData, username);
    log(`[${transferId}] Successfully sent image via direct buffer upload`);
  }

  getTelegramBot(): TelegramBot {
    return this.telegramBot;
  }

  getDiscordBot(): DiscordBot {
    return this.discordBot;
  }
}

async function uploadToImgbb(buffer: Buffer, retryCount: number = 3, delayMs: number = 1000): Promise<string | null> {
  let lastError: Error | null = null;
  const startTime = Date.now();
  
  for (let attempt = 1; attempt <= retryCount; attempt++) {
    try {
      // Log message for each attempt
      if (attempt > 1) {
        log(`ImgBB upload retry ${attempt}/${retryCount}...`, "warn");
      }
      
      const formData = new URLSearchParams();
      formData.append('image', buffer.toString('base64'));
      formData.append('name', `bridge_upload_${Date.now()}`);
      // Preserve image quality
      formData.append('quality', '100');
      // Don't auto-resize
      formData.append('width', '0');
      formData.append('height', '0');
      
      const apiKey = process.env.IMGBB_API_KEY;
      if (!apiKey) {
        throw new BridgeError('IMGBB_API_KEY is not defined', { context: "uploadToImgbb" });
      }
      
      const url = `https://api.imgbb.com/1/upload?key=${apiKey}`;
      
      // Create request options
      const requestOptions: RequestInit = {
        method: 'POST',
        body: formData,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        }
      };
      
      // Set up an AbortController with timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000) as unknown as number;
      requestOptions.signal = controller.signal;
      
      // Make the request
      const response = await fetch(url, requestOptions);
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        // If rate limited or server error, retry
        if (response.status === 429 || response.status >= 500) {
          throw new BridgeError(`ImgBB API error: ${response.status} ${response.statusText}`, 
            { context: "uploadToImgbb", code: response.status.toString() });
        }
        
        // For other error codes like 403, get the response body for more info
        const errorBody = await response.text();
        throw new BridgeError(`ImgBB API error: ${response.status} ${response.statusText} - ${errorBody}`, 
          { context: "uploadToImgbb", code: response.status.toString() });
      }
      
      const responseText = await response.text();
      const data = JSON.parse(responseText);
      
      if (!data.success || !data.data?.url) {
        throw new BridgeError('ImgBB upload failed: No URL returned', { context: "uploadToImgbb" });
      }
      
      const elapsed = Date.now() - startTime;
      
      // Log detailed image information
      log(`Successfully uploaded image to ImgBB in ${elapsed}ms (attempt ${attempt}/${retryCount}):
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
      const bridgeError = error instanceof BridgeError ? error : new BridgeError(
        error instanceof Error ? error.message : String(error),
        { context: "uploadToImgbb" }
      );
      
      lastError = bridgeError;
      
      // Handle different errors differently
      const isRateLimit = bridgeError.code === '429' || bridgeError.message.includes('rate limit');
      const isTimeout = bridgeError.message.includes('abort') || bridgeError.message.includes('timeout');
      
      handleBridgeError(bridgeError, `uploadToImgbb (attempt ${attempt}/${retryCount})`);
      
      // If this is the last attempt, don't wait
      if (attempt < retryCount) {
        // Use exponential backoff for rate limits
        const waitTime = isRateLimit 
          ? delayMs * Math.pow(2, attempt - 1) 
          : isTimeout
            ? delayMs * 2 // Longer delay for timeouts
            : delayMs;
        
        log(`Waiting ${waitTime}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  // All attempts failed
  const errorMessage = lastError ? lastError.message : 'Unknown error';
  log(`All ${retryCount} ImgBB upload attempts failed: ${errorMessage}`, "error");
  return null;
}