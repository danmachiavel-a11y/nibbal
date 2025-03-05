import { storage } from "../storage";
import { TelegramBot } from "./telegram";
import { DiscordBot } from "./discord";
import type { Ticket } from "@shared/schema";
import { log } from "../vite";

export class BridgeManager {
  private telegramBot: TelegramBot;
  private discordBot: DiscordBot;

  constructor() {
    log("Initializing Bridge Manager");
    this.telegramBot = new TelegramBot(this);
    this.discordBot = new DiscordBot(this);
  }

  async start() {
    log("Starting bots...");
    try {
      // Start bots sequentially to avoid overwhelming APIs
      await this.telegramBot.start();
      await this.discordBot.start();
      log("Bots initialization completed");
    } catch (error) {
      log(`Error starting bots: ${error}`, "error");
      throw error;
    }
  }

  async stop() {
    try {
      log("Stopping bots...");
      await Promise.allSettled([
        this.telegramBot.stop(),
        this.discordBot.stop()
      ]);
      log("Bots stopped successfully");
    } catch (error) {
      log(`Error stopping bots: ${error}`, "error");
    }
  }

  async restart() {
    log("Restarting bots with new configuration...");
    try {
      // Stop existing bots
      await this.stop();

      // Create new instances
      this.telegramBot = new TelegramBot(this);
      this.discordBot = new DiscordBot(this);

      // Start new instances
      await this.start();
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

  getTelegramBot(): TelegramBot {
    return this.telegramBot;
  }

  getDiscordBot(): DiscordBot {
    return this.discordBot;
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

      // Send and pin the formatted Q&A
      await this.discordBot.sendMessage(channelId, message, "Ticket Bot", undefined, true);
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

  async forwardToDiscord(content: string, ticketId: number, username: string, avatarUrl?: string) {
    try {
      const ticket = await storage.getTicket(ticketId);
      log(`Forwarding to Discord - Ticket: ${JSON.stringify(ticket)}`);

      if (!ticket || !ticket.discordChannelId) {
        log(`Invalid ticket or missing Discord channel: ${ticketId}`, "error");
        return;
      }

      await this.discordBot.sendMessage(ticket.discordChannelId, content, username, avatarUrl);
      log(`Message forwarded to Discord channel: ${ticket.discordChannelId}`);
    } catch (error) {
      log(`Error forwarding to Discord: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

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

      // Send image to Telegram
      await this.telegramBot.sendImage(parseInt(user.telegramId), imageUrl, `${username} sent an image`);
      log(`Successfully sent image to Telegram user: ${user.username}`);
    } catch (error) {
      log(`Error forwarding image to Telegram: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }
}