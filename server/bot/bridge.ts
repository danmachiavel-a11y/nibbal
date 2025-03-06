import { storage } from "../storage";
import { TelegramBot } from "./telegram";
import { DiscordBot } from "./discord";
import type { Ticket } from "@shared/schema";
import { log } from "../vite";

export class BridgeManager {
  private telegramBot: TelegramBot;
  private discordBot: DiscordBot;
  private retryAttempts: number = 0;
  private maxRetries: number = 3;
  private retryTimeout: number = 5000; // 5 seconds
  private healthCheckInterval: NodeJS.Timeout | null = null;

  constructor() {
    log("Initializing Bridge Manager");
    this.telegramBot = new TelegramBot(this);
    this.discordBot = new DiscordBot(this);
    this.startHealthCheck();
  }

  private startHealthCheck() {
    // Run health check every 30 seconds
    this.healthCheckInterval = setInterval(async () => {
      try {
        // Add delay between checks to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 1000));
        const health = await this.healthCheck();

        if (!health.telegram || !health.discord) {
          log("Bot disconnected, attempting to reconnect...");
          // Add delay before reconnection attempt
          await new Promise(resolve => setTimeout(resolve, 2000));
          await this.reconnectDisconnectedBots(health);
        }
      } catch (error) {
        log(`Health check failed: ${error}`, "error");
      }
    }, 30000); // Keep 30 second interval but add internal delays
  }

  private async reconnectDisconnectedBots(health: { telegram: boolean; discord: boolean }) {
    try {
      if (!health.telegram) {
        log("Attempting to reconnect Telegram bot...");
        // Add delay before reconnection
        await new Promise(resolve => setTimeout(resolve, 2000));
        await this.startBotWithRetry(() => this.telegramBot.start(), "Telegram");
      }
      if (!health.discord) {
        log("Attempting to reconnect Discord bot...");
        await this.startBotWithRetry(() => this.discordBot.start(), "Discord");
      }
    } catch (error) {
      log(`Error reconnecting bots: ${error}`, "error");
    }
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
        await new Promise(resolve => setTimeout(resolve, this.retryTimeout));
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

      // Add delay before creating new instances
      await new Promise(resolve => setTimeout(resolve, 2000));

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

  async healthCheck(): Promise<{
    telegram: boolean;
    discord: boolean;
  }> {
    return {
      telegram: this.telegramBot.getIsConnected(),
      discord: this.discordBot.isReady()
    };
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

      // Format Q&A for embed
      let message = '';
      for (const question of category.questions) {
        const answer = ticket.answers?.[category.questions.indexOf(question)] || 'No answer provided';
        message += `**Q: ${question}**\n`;
        message += `A: ${answer}\n\n`;
      }

      // Send the formatted Q&A
      await this.discordBot.sendMessage(
        channelId,
        message,
        "Ticket Bot",
        undefined, // avatarUrl
        undefined  // imageUrl
      );
      log(`Ticket channel created: ${channelName}`);
    } catch (error) {
      log(`Error creating Discord channel: ${error}`, "error");
      await storage.updateTicketStatus(ticket.id, "open");
      throw error;
    }
  }

  async forwardToTelegram(content: string, ticketId: number, username: string) {
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

      // Add safety check for valid Telegram ID
      if (!user.telegramId.match(/^\d+$/)) {
        log(`Invalid Telegram ID format for user: ${user.id}`, "error");
        return;
      }

      // Store the message first
      await storage.createMessage({
        ticketId,
        content,
        authorId: user.id,
        platform: "discord",
        timestamp: new Date()
      });

      // Send to Telegram
      await this.telegramBot.sendMessage(parseInt(user.telegramId), `${username}: ${content}`);
      log(`Successfully sent message to Telegram user: ${user.username}`);
    } catch (error) {
      log(`Error forwarding to Telegram: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  async forwardToDiscord(content: string, ticketId: number, username: string, avatarUrl?: string, imageUrl?: string) {
    try {
      const ticket = await storage.getTicket(ticketId);
      log(`Forwarding to Discord - Ticket: ${JSON.stringify(ticket)}`);

      if (!ticket || !ticket.discordChannelId) {
        log(`Invalid ticket or missing Discord channel: ${ticketId}`, "error");
        return;
      }

      await this.discordBot.sendMessage(ticket.discordChannelId, content, username, avatarUrl, imageUrl);
      log(`Message forwarded to Discord channel: ${ticket.discordChannelId}`);
    } catch (error) {
      log(`Error forwarding to Discord: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  getTelegramBot(): TelegramBot {
    return this.telegramBot;
  }

  getDiscordBot(): DiscordBot {
    return this.discordBot;
  }

  // Add this method to the BridgeManager class
  async forwardImageToTelegram(imageUrl: string, ticketId: number, username: string) {
    try {
      const ticket = await storage.getTicket(ticketId);
      log(`Forwarding image to Telegram - Ticket: ${JSON.stringify(ticket)}`);

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

      // Add safety check for valid Telegram ID
      if (!user.telegramId.match(/^\d+$/)) {
        log(`Invalid Telegram ID format for user: ${user.id}`, "error");
        return;
      }

      // Forward the image to Telegram
      await this.telegramBot.sendPhoto(
        parseInt(user.telegramId),
        imageUrl,
        `Image from ${username}`
      );

      log(`Successfully sent image to Telegram user: ${user.username}`);
    } catch (error) {
      log(`Error forwarding image to Telegram: ${error instanceof Error ? error.message : String(error)}`, "error");
      throw error;
    }
  }
}