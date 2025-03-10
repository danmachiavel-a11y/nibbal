import { Client, TextChannel, WebhookClient } from 'discord.js';
import { log } from "../../vite";
import { rateLimiter } from './RateLimiter';
import { imageHandler } from '../handlers/ImageHandler';

interface WebhookPool {
  webhook: WebhookClient;
  lastUsed: number;
  failures: number;
}

export class DiscordBot {
  private client: Client;
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

  async sendMessage(channelId: string, message: any) {
    try {
      log(`Attempting to send message to Discord channel ${channelId}`);

      // Check rate limit
      await rateLimiter.webhookCheck(channelId);
      await rateLimiter.globalCheck();

      const webhookClient = await this.getWebhookForChannel(channelId);
      if (!webhookClient) throw new Error("Failed to get webhook");

      let webhookMessage: any = {
        username: message.username || "Unknown User",
        avatarURL: message.avatarURL
      };

      // Handle content
      if (message.content !== undefined && message.content !== null) {
        webhookMessage.content = String(message.content).trim() || " ";
      }

      // Handle files
      if (message.files && Array.isArray(message.files)) {
        webhookMessage.files = message.files;
      }

      // Ensure at least content or files exist
      if (!webhookMessage.content && !webhookMessage.files) {
        webhookMessage.content = " "; // Discord requires either content or files
      }

      const sentMessage = await webhookClient.send(webhookMessage);
      log(`Successfully sent message to Discord channel ${channelId}`);
      return sentMessage;
    } catch (error) {
      log(`Error sending message to Discord: ${error}`, "error");
      throw error;
    }
  }

  async sendPhoto(channelId: string, photo: Buffer, caption?: string): Promise<string | undefined> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!(channel instanceof TextChannel)) {
        throw new Error('Invalid channel type');
      }

      const message = await channel.send({
        content: caption || undefined,
        files: [{
          attachment: photo,
          name: 'image.jpg'
        }]
      });

      if (message.attachments.size > 0) {
        const attachment = message.attachments.first();
        return attachment?.url;
      }
      return undefined;
    } catch (error) {
      log(`Error sending photo: ${error}`, "error");
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

        const webhook = await channel.createWebhook({
          name: 'Bridge Bot Webhook',
          reason: 'Created for message bridging'
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
      }

      return null;
    } catch (error) {
      log(`Error getting webhook: ${error}`, "error");
      return null;
    }
  }
  async sendWebhookMessage(channelId: string, message: string | any): Promise<void> {
    try {
      // Check webhook rate limit
      await rateLimiter.webhookCheck(channelId);

      // Global rate limit check
      await rateLimiter.globalCheck();

      const webhookClient = await this.getWebhookForChannel(channelId);
      if (!webhookClient) throw new Error("Failed to get webhook");

      try {
        let messageContent: any;

        // Handle embed messages
        if (typeof message === 'object') {
          messageContent = {
            embeds: [{
              title: message.title,
              description: message.description,
              color: message.color,
              fields: message.fields.map((field: any) => ({
                name: field.name,
                value: `\`\`\`${field.value}\`\`\``,
                inline: field.inline || false
              }))
            }]
          };
        } else {
          // Regular text messages
          messageContent = message;
        }

        // Send message
        const sentMessage = await webhookClient.send(messageContent);

        // Pin the message if it's an embed (questionnaire)
        if (typeof message === 'object' && message.title?.includes('New Ticket Questions')) {
          const channel = await this.client.channels.fetch(channelId) as TextChannel;
          if (channel) {
            const messages = await channel.messages.fetchPinned();
            // Unpin old messages if there are too many
            while (messages.size >= 50) {
              const oldestPin = messages.last();
              if (oldestPin) await oldestPin.unpin();
              messages.delete(oldestPin!.id);
            }
            // Pin the new message
            await sentMessage.pin();
          }
        }

        // Reset failure count on success
        const webhooks = this.webhookPool.get(channelId) || [];
        const webhook = webhooks.find(w => w.webhook === webhookClient);
        if (webhook) {
          webhook.failures = 0;
          webhook.lastUsed = Date.now();
        }
      } catch (error) {
        // Increment failure count
        const webhooks = this.webhookPool.get(channelId) || [];
        const webhook = webhooks.find(w => w.webhook === webhookClient);
        if (webhook) {
          webhook.failures++;
          if (webhook.failures >= this.MAX_WEBHOOK_FAILURES) {
            webhook.webhook.destroy();
          }
        }
        throw error;
      }
    } catch (error) {
      log(`Error sending webhook message: ${error}`, "error");
      throw error;
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
}