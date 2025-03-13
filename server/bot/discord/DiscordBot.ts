import { Client, TextChannel, WebhookClient } from 'discord.js';
import { log } from "../../vite";
import { rateLimiter } from './RateLimiter';

interface WebhookPool {
  webhook: WebhookClient;
  lastUsed: number;
  failures: number;
}

export class DiscordBot {
  public client: Client;
  private webhookPool: Map<string, WebhookPool[]> = new Map();
  private readonly MAX_WEBHOOK_FAILURES = 3;
  private readonly WEBHOOK_TIMEOUT = 300000; // 5 minutes
  private readonly MAX_WEBHOOKS_PER_CHANNEL = 5;

  constructor() {
    this.client = new Client({
      intents: ['Guilds', 'GuildMessages', 'MessageContent'],
      failIfNotExists: false,
      rest: {
        timeout: 15000,
        retries: 3
      }
    });

    // Start webhook cleanup interval
    setInterval(() => this.cleanupWebhooks(), 300000);
  }

  async start() {
    try {
      await this.client.login(process.env.DISCORD_BOT_TOKEN);
      log("Discord bot started successfully");
    } catch (error) {
      log(`Error starting Discord bot: ${error}`, "error");
      throw error;
    }
  }

  async stop() {
    try {
      this.client.destroy();
      log("Discord bot stopped successfully");
    } catch (error) {
      log(`Error stopping Discord bot: ${error}`, "error");
    }
  }

  isReady(): boolean {
    return this.client.isReady();
  }

  async sendMessage(channelId: string, message: any) {
    try {
      log(`Attempting to send message to Discord channel ${channelId}`);

      // Check rate limit
      await rateLimiter.webhookCheck(channelId);
      await rateLimiter.globalCheck();

      const webhookClient = await this.getWebhookForChannel(channelId);
      if (!webhookClient) throw new Error("Failed to get webhook");

      // Ensure message options are properly set
      const webhookMessage = {
        content: String(message.content || " ").trim(),
        username: message.username, // Don't provide a fallback, let Discord handle it
        avatarURL: message.avatarURL,
        files: message.files,
        allowedMentions: message.allowedMentions
      };

      log(`Sending webhook message for user: ${webhookMessage.username}`);
      const sentMessage = await webhookClient.send(webhookMessage);
      log(`Successfully sent message to Discord channel ${channelId}`);
      return sentMessage;
    } catch (error) {
      log(`Error sending message to Discord: ${error}`, "error");
      throw error;
    }
  }

  private async cleanupWebhooks() {
    for (const [channelId, webhooks] of this.webhookPool.entries()) {
      const now = Date.now();
      const activeWebhooks = webhooks.filter(pool => {
        const isActive = now - pool.lastUsed < this.WEBHOOK_TIMEOUT && pool.failures < this.MAX_WEBHOOK_FAILURES;
        if (!isActive) {
          pool.webhook.destroy();
        }
        return isActive;
      });

      if (activeWebhooks.length === 0) {
        this.webhookPool.delete(channelId);
      } else {
        this.webhookPool.set(channelId, activeWebhooks);
      }
    }
  }

  private async getWebhookForChannel(channelId: string): Promise<WebhookClient | null> {
    try {
      let webhooks = this.webhookPool.get(channelId) || [];

      // Filter out failed webhooks
      webhooks = webhooks.filter(w => w.failures < this.MAX_WEBHOOK_FAILURES);

      // If we have working webhooks, use the least recently used one
      if (webhooks.length > 0) {
        const webhook = webhooks.reduce((prev, curr) =>
          prev.lastUsed < curr.lastUsed ? prev : curr
        );
        webhook.lastUsed = Date.now();
        return webhook.webhook;
      }

      // Create new webhook if needed
      if (webhooks.length < this.MAX_WEBHOOKS_PER_CHANNEL) {
        const channel = await this.client.channels.fetch(channelId) as TextChannel;
        if (!channel?.isTextBased()) return null;

        try {
          // Create a neutral webhook that will be overridden by message options
          const webhook = await channel.createWebhook({
            name: 'Message Relay',
            reason: 'For message bridging'
          });

          const webhookClient = new WebhookClient({ url: webhook.url });
          webhooks.push({
            webhook: webhookClient,
            lastUsed: Date.now(),
            failures: 0
          });

          this.webhookPool.set(channelId, webhooks);
          log(`Created new webhook for channel ${channelId}`);
          return webhookClient;
        } catch (error) {
          log(`Error creating webhook: ${error}`, "error");
          return null;
        }
      }

      return null;
    } catch (error) {
      log(`Error getting webhook: ${error}`, "error");
      return null;
    }
  }

  async fetchMessages(channelId: string, limit: number = 50): Promise<any[]> {
    try {
      await rateLimiter.messagesFetchCheck(channelId);
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
}