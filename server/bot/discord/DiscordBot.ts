import { Client, TextChannel, WebhookClient } from 'discord.js';
import { log } from "../../vite";
import { rateLimiter } from './RateLimiter';

interface WorkerCooldown {
  lastUsed: number;
  commands: Map<string, number>;
}

interface WebhookPool {
  webhook: WebhookClient;
  lastUsed: number;
  failures: number;
}

export class DiscordBot {
  private client: Client;
  private webhookPool: Map<string, WebhookPool[]> = new Map();
  private workerCooldowns: Map<string, WorkerCooldown> = new Map();
  private readonly PAID_COOLDOWN = 300000; // 5 minutes
  private readonly MAX_WEBHOOK_FAILURES = 3;
  private readonly WEBHOOK_TIMEOUT = 300000; // 5 minutes
  private readonly MAX_WEBHOOKS_PER_CHANNEL = 5;
  private readonly WEBHOOK_ROTATION_INTERVAL = 60000; // 1 minute

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
        return webhookClient;
      }

      return null;
    } catch (error) {
      log(`Error getting webhook: ${error}`, "error");
      return null;
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

  async checkWorkerCooldown(workerId: string, command: string): Promise<boolean> {
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

}