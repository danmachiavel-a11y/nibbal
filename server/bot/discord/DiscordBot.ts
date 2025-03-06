import { Client, TextChannel } from 'discord.js';
import { log } from "../../vite";
import { rateLimiter } from './RateLimiter';

interface WorkerCooldown {
  lastUsed: number;
  commands: Map<string, number>;
}

export class DiscordBot {
  private client: Client;
  private webhooks: Map<string, string> = new Map();
  private workerCooldowns: Map<string, WorkerCooldown> = new Map();
  private readonly PAID_COOLDOWN = 300000; // 5 minutes

  private async checkWorkerCooldown(workerId: string, command: string): Promise<boolean> {
    if (!this.workerCooldowns.has(workerId)) {
      this.workerCooldowns.set(workerId, {
        lastUsed: Date.now(),
        commands: new Map()
      });
    }

    const cooldown = this.workerCooldowns.get(workerId)!;
    const now = Date.now();

    // Check command-specific cooldown
    if (command === 'paid') {
      const lastPaid = cooldown.commands.get('paid') || 0;
      if (now - lastPaid < this.PAID_COOLDOWN) {
        return false;
      }
      cooldown.commands.set('paid', now);
    }

    return true;
  }

  // Add this to your existing command handling logic:
  async handlePaidCommand(message: any, workerId: string): Promise<void> {
    try {
      if (!await this.checkWorkerCooldown(workerId, 'paid')) {
        await message.reply("⚠️ Please wait 5 minutes between /paid commands.");
        return;
      }

      // Existing paid command logic...
    } catch (error) {
      log(`Error handling paid command: ${error}`, "error");
    }
  }

  async createChannel(name: string, categoryId: string): Promise<TextChannel | null> {
    try {
      // Check channel creation rate limit
      await rateLimiter.channelCreateCheck(this.guild?.id || 'unknown');

      // Global rate limit check
      await rateLimiter.globalCheck();

      const channel = await this.guild?.channels.create({
        name,
        parent: categoryId,
        type: 0
      });

      return channel as TextChannel;
    } catch (error) {
      log(`Error creating channel: ${error}`, "error");
      return null;
    }
  }

  async sendWebhookMessage(channelId: string, message: string): Promise<void> {
    try {
      // Check webhook rate limit
      await rateLimiter.webhookCheck(channelId);
      
      // Global rate limit check
      await rateLimiter.globalCheck();

      // Get or create webhook
      const webhookId = await this.getWebhookForChannel(channelId);
      if (!webhookId) throw new Error("Failed to get webhook");

      // Send message
      await this.client.fetchWebhook(webhookId).then(webhook => 
        webhook.send(message)
      );
    } catch (error) {
      log(`Error sending webhook message: ${error}`, "error");
    }
  }

  async editChannel(channelId: string, options: any): Promise<void> {
    try {
      // Check channel edit rate limit
      await rateLimiter.channelEditCheck(channelId);
      
      // Global rate limit check
      await rateLimiter.globalCheck();

      const channel = await this.client.channels.fetch(channelId);
      if (channel?.isTextBased()) {
        await channel.edit(options);
      }
    } catch (error) {
      log(`Error editing channel: ${error}`, "error");
    }
  }

  async fetchMessages(channelId: string, limit: number = 50): Promise<any[]> {
    try {
      // Check messages fetch rate limit
      await rateLimiter.messagesFetchCheck(channelId);
      
      // Global rate limit check
      await rateLimiter.globalCheck();

      const channel = await this.client.channels.fetch(channelId);
      if (channel?.isTextBased()) {
        const messages = await (channel as TextChannel).messages.fetch({ limit });
        return Array.from(messages.values());
      }
      return [];
    } catch (error) {
      log(`Error fetching messages: ${error}`, "error");
      return [];
    }
  }
  // ... other methods ...
  private getWebhookForChannel(channelId: string): Promise<string | null> {
    throw new Error("Method not implemented.");
  }

}