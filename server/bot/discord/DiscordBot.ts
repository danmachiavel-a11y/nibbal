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

      // Create the message payload
      const webhookMessage: any = {
        content: String(message.content || " ").trim() || " ",
        username: message.username, // This will override the webhook's default name
        avatarURL: message.avatarURL,
        allowedMentions: message.allowedMentions,
      };

      // Add files if present
      if (message.files && Array.isArray(message.files)) {
        webhookMessage.files = message.files;
      }

      // Log the actual username being sent
      log(`Sending webhook message with username: ${webhookMessage.username}`);

      // Send the message with retries
      let retries = 0;
      const maxRetries = 3;
      while (retries < maxRetries) {
        try {
          const sentMessage = await webhookClient.send(webhookMessage);
          log(`Successfully sent message to Discord channel ${channelId}`);
          return sentMessage;
        } catch (error) {
          retries++;
          if (retries === maxRetries) throw error;
          await new Promise(resolve => setTimeout(resolve, 1000 * retries));
        }
      }
    } catch (error) {
      log(`Error sending message to Discord: ${error}`, "error");
      throw error;
    }
  }

  private async getWebhookForChannel(channelId: string): Promise<WebhookClient | null> {
    try {
      // Check existing webhooks first
      let webhooks = this.webhookPool.get(channelId) || [];
      webhooks = webhooks.filter(w => w.failures < this.MAX_WEBHOOK_FAILURES);

      // Use existing webhook if available
      if (webhooks.length > 0) {
        const webhook = webhooks[0]; // Always use the first webhook
        webhook.lastUsed = Date.now();
        return webhook.webhook;
      }

      // Create new webhook if needed
      const channel = await this.client.channels.fetch(channelId) as TextChannel;
      if (!channel?.isTextBased()) return null;

      try {
        // Create a webhook that will be overridden by message usernames
        const webhook = await channel.createWebhook({
          name: 'Message Relay', // This will be overridden by message usernames
          reason: 'For message bridging'
        });

        const webhookClient = new WebhookClient({ url: webhook.url });
        const webhookPool: WebhookPool = {
          webhook: webhookClient,
          lastUsed: Date.now(),
          failures: 0
        };

        this.webhookPool.set(channelId, [webhookPool]);
        log(`Created new webhook for channel ${channelId}`);
        return webhookClient;
      } catch (error) {
        log(`Error creating webhook: ${error}`, "error");
        return null;
      }
    } catch (error) {
      log(`Error getting webhook: ${error}`, "error");
      return null;
    }
  }

  private async cleanupWebhooks() {
    const now = Date.now();
    for (const [channelId, webhooks] of this.webhookPool.entries()) {
      // Only cleanup webhooks that haven't been used in a while
      const activeWebhooks = webhooks.filter(pool => {
        const isActive = now - pool.lastUsed < this.WEBHOOK_TIMEOUT && 
                        pool.failures < this.MAX_WEBHOOK_FAILURES;
        if (!isActive) {
          try {
            pool.webhook.destroy();
          } catch (error) {
            log(`Error destroying webhook: ${error}`, "error");
          }
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