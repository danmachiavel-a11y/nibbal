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
      await Promise.allSettled([
        this.telegramBot.start().catch(error => {
          log(`Telegram bot error: ${error.message}`, "error");
        }),
        this.discordBot.start().catch(error => {
          log(`Discord bot error: ${error.message}`, "error");
        })
      ]);
      log("Bots initialization completed");
    } catch (error) {
      log(`Error starting bots: ${error}`, "error");
      // Don't throw, allow partial functionality
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
      const channelId = await this.discordBot.createTicketChannel(
        category.discordCategoryId,
        channelName
      );

      // Update ticket with channel ID and send initial message
      await storage.updateTicketStatus(ticket.id, "open", channelId);

      // Send initial message with answers
      const questions = category.questions;
      const answers = ticket.answers || [];
      let message = `New ticket from ${user.username}\n\n`;

      for (let i = 0; i < questions.length; i++) {
        message += `**${questions[i]}**\n${answers[i] || 'No answer provided'}\n\n`;
      }

      await this.discordBot.sendMessage(channelId, message, "Ticket Bot");
      log(`Ticket channel created: ${channelName}`);
    } catch (error) {
      log(`Error creating Discord channel: ${error}`, "error");
      // Don't rethrow - the ticket is still valid even without Discord channel
      // Just update the status to indicate it's a Telegram-only ticket
      await storage.updateTicketStatus(ticket.id, "open", null);
    }
  }

  async forwardToTelegram(content: string, ticketId: number, username: string) {
    try {
      const ticket = await storage.getTicket(ticketId);
      if (!ticket || !ticket.userId) {
        log(`Invalid ticket or missing user ID: ${ticketId}`, "error");
        return;
      }

      const user = await storage.getUser(ticket.userId);
      if (!user || !user.telegramId) {
        log(`Invalid user or missing Telegram ID for ticket: ${ticketId}`, "error");
        return;
      }

      await this.telegramBot.sendMessage(parseInt(user.telegramId), `${username}: ${content}`);
      log(`Message forwarded to Telegram user: ${user.username}`);

      // Store the message
      await storage.createMessage({
        ticketId,
        content,
        authorId: user.id,
        platform: "discord",
        timestamp: new Date()
      });
    } catch (error) {
      log(`Error forwarding to Telegram: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  async forwardToDiscord(content: string, ticketId: number, username: string, avatarUrl?: string) {
    try {
      const ticket = await storage.getTicket(ticketId);
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
}