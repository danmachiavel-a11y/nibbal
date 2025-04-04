interface WebhookMessage {
  content?: string;
  username: string;
  avatarURL?: string;
  embeds?: any[];
  files?: Array<{
    attachment: Buffer | string;
    name: string;
    description?: string;
  }>;
  allowedMentions?: {
    roles?: string[];
  };
}

interface WebhookPool {
  webhook: WebhookClient;
  lastUsed: number;
  failures: number;
}

interface RateLimitBucket {
  tokens: number;
  lastRefill: number;
  capacity: number;
  refillRate: number;
  queue: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }>;
}

interface WSCleanupConfig {
  connectionTimeout: number;
  maxReconnectAttempts: number;
  cleanupInterval: number;
}

import {
  Client,
  GatewayIntentBits,
  TextChannel,
  Webhook,
  CategoryChannel,
  ChannelType,
  EmbedBuilder,
  ApplicationCommandType,
  ApplicationCommandOptionType,
  WebhookClient
} from "discord.js";
import { storage } from "../storage";
import { BridgeManager } from "./bridge";
import { log } from "../vite";

export class DiscordBot {
  private client: Client;
  private bridge: BridgeManager;
  private webhooks: Map<string, WebhookPool[]> = new Map();
  private webhookCreationLock: Set<string> = new Set();
  private rateLimitBuckets: Map<string, RateLimitBucket> = new Map();
  private wsCleanupConfig: WSCleanupConfig = {
    connectionTimeout: 30000,    // 30 seconds
    maxReconnectAttempts: 5,
    cleanupInterval: 300000     // 5 minutes
  };
  private cleanupInterval: NodeJS.Timeout | null = null;
  private connectionTimeout: NodeJS.Timeout | null = null;
  private lastError: Error | null = null;

  // Rate limit configurations
  private readonly LIMITS = {
    global: { capacity: 45, refillTime: 1000 }, // 45 per second
    webhook: { capacity: 4, refillTime: 5000 }, // 4 per 5 seconds
    channelCreate: { capacity: 9, refillTime: 10000 }, // 9 per 10 seconds
    channelEdit: { capacity: 4, refillTime: 10000 }, // 4 per 10 seconds
    messagesFetch: { capacity: 45, refillTime: 1000 }, // 45 per second
  };

  // Webhook management constants
  private readonly MAX_WEBHOOK_FAILURES = 3;
  private readonly WEBHOOK_TIMEOUT = 300000; // 5 minutes
  private readonly MAX_WEBHOOKS_PER_CHANNEL = 5;

  constructor(bridge: BridgeManager) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
      ]
    });
    this.bridge = bridge;
    this.webhooks = new Map();

    // Start cleanup intervals
    this.startCleanupIntervals();
    this.setupHandlers();
    this.setupRateLimitBuckets();
  }

  private setupRateLimitBuckets() {
    Object.entries(this.LIMITS).forEach(([key, limit]) => {
      this.rateLimitBuckets.set(key, {
        tokens: limit.capacity,
        lastRefill: Date.now(),
        capacity: limit.capacity,
        refillRate: limit.capacity / limit.refillTime,
        queue: []
      });
    });
  }

  private async checkRateLimit(type: string, id: string = 'global'): Promise<void> {
    return new Promise((resolve, reject) => {
      const bucket = this.getBucket(type);
      this.refillBucket(bucket);

      if (bucket.tokens < 1) {
        bucket.queue.push({ resolve, reject });

        setTimeout(() => {
          const index = bucket.queue.indexOf({ resolve, reject });
          if (index > -1) {
            bucket.queue.splice(index, 1);
            reject(new Error("Rate limit wait timeout"));
          }
        }, 30000);
        return;
      }

      bucket.tokens -= 1;
      resolve();

      while (bucket.queue.length > 0 && bucket.tokens >= 1) {
        const next = bucket.queue.shift();
        if (next) {
          bucket.tokens -= 1;
          next.resolve();
        }
      }
    });
  }

  private getBucket(key: string): RateLimitBucket {
    if (!this.rateLimitBuckets.has(key)) {
      const limit = this.LIMITS[key as keyof typeof this.LIMITS];
      this.rateLimitBuckets.set(key, {
        tokens: limit.capacity,
        lastRefill: Date.now(),
        capacity: limit.capacity,
        refillRate: limit.capacity / limit.refillTime,
        queue: []
      });
    }
    return this.rateLimitBuckets.get(key)!;
  }

  private refillBucket(bucket: RateLimitBucket) {
    const now = Date.now();
    const timePassed = now - bucket.lastRefill;
    const tokensToAdd = timePassed * bucket.refillRate;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;
  }

  // Convenience methods for rate limiting
  private async globalCheck(): Promise<void> {
    return this.checkRateLimit('global');
  }

  private async webhookCheck(webhookId: string): Promise<void> {
    return this.checkRateLimit('webhook', webhookId);
  }

  private startCleanupIntervals() {
    // Clear any existing intervals
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
    }

    // Start WebSocket cleanup interval
    this.cleanupInterval = setInterval(() => {
      this.cleanupWebSockets();
    }, this.wsCleanupConfig.cleanupInterval);

    log("Started WebSocket cleanup intervals");
  }

  private async cleanupWebSockets() {
    try {
      if (!this.client.ws) return;

      // Check for dead connections
      const wsConnection = (this.client.ws as any).connection;
      if (wsConnection && !wsConnection.connected) {
        log("Found dead WebSocket connection, attempting cleanup...");

        try {
          await this.client.destroy();
          log("Successfully destroyed client connection");

          // Attempt to reconnect
          await this.start();
        } catch (error) {
          log(`Error during WebSocket cleanup: ${error}`, "error");
        }
      }
    } catch (error) {
      log(`Error checking WebSocket status: ${error}`, "error");
    }
  }


  private async registerSlashCommands() {
    try {
      log("Registering slash commands...");

      // Add delay to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Commands to register
      const commands = [
        {
          name: 'close',
          description: 'Close the ticket and move it to transcripts',
          type: ApplicationCommandType.ChatInput
        },
        {
          name: 'paid',
          description: 'Mark a ticket as paid with the specified amount',
          type: ApplicationCommandType.ChatInput,
          options: [
            {
              name: 'amount',
              description: 'The payment amount',
              type: ApplicationCommandOptionType.Integer,
              required: true,
              min_value: 1
            }
          ]
        },
        {
          name: 'ping',
          description: 'Ping the Telegram user of this ticket',
          type: ApplicationCommandType.ChatInput
        },
        {
          name: 'info',
          description: 'Get Telegram user information (Owner only)',
          type: ApplicationCommandType.ChatInput
        },
        {
          name: 'delete',
          description: 'Delete this ticket channel',
          type: ApplicationCommandType.ChatInput
        },
        {
          name: 'deleteall',
          description: 'Delete all tickets in a category',
          type: ApplicationCommandType.ChatInput,
          options: [
            {
              name: 'category',
              description: 'The category to delete tickets from',
              type: ApplicationCommandOptionType.Channel,
              channelTypes: [ChannelType.GuildCategory],
              required: true
            }
          ]
        },
        {
          name: 'closeall',
          description: 'Close all tickets in a category',
          type: ApplicationCommandType.ChatInput,
          options: [
            {
              name: 'category',
              description: 'The category to close tickets from',
              type: ApplicationCommandOptionType.Channel,
              channelTypes: [ChannelType.GuildCategory],
              required: true
            }
          ]
        },
        {
          name: 'nickname',
          description: 'Get Telegram username of ticket creator (Owner only)',
          type: ApplicationCommandType.ChatInput
        }
      ];

      // Register commands with rate limit handling
      for (const command of commands) {
        try {
          await this.client.application?.commands.create(command);
          // Add delay between each command registration
          await new Promise(resolve => setTimeout(resolve, 1000));
          log(`Registered command: ${command.name}`);
        } catch (error) {
          log(`Error registering command ${command.name}: ${error}`, "error");
        }
      }

      log("Completed slash command registration");
    } catch (error) {
      log(`Error in slash command registration: ${error}`, "error");
      throw error;
    }
  }

  private setupHandlers() {
    this.client.on("ready", async () => {
      log("Discord bot ready");
      await this.registerSlashCommands();
    });

    // Handle slash commands
    this.client.on('interactionCreate', async (interaction) => {
      if (!interaction.isChatInputCommand()) return;

      // Add info command handler
      if (interaction.commandName === 'info') {
        const ticket = await storage.getTicketByDiscordChannel(interaction.channelId);

        if (!ticket) {
          await interaction.reply({
            content: "This command can only be used in ticket channels!",
            ephemeral: true
          });
          return;
        }

        // Check if user is guild owner
        const guild = interaction.guild;
        if (!guild || interaction.user.id !== guild.ownerId) {
          await interaction.reply({
            content: "This command can only be used by the server owner!",
            ephemeral: true
          });
          return;
        }

        try {
          // Get ticket creator's info
          const user = await storage.getUser(ticket.userId!);
          if (!user || !user.telegramId) {
            await interaction.reply({
              content: "Could not find Telegram information for this ticket's creator.",
              ephemeral: true
            });
            return;
          }

          // Get paid tickets count
          const allTickets = await storage.getTicketsByUserId(user.id);
          const paidTickets = allTickets.filter(t => t.amount && t.amount > 0);

          // Create a nice embed with the information
          const embed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle('Ticket Creator Information')
            .addFields(
              { name: 'Telegram Username', value: `@${user.username}`, inline: true },
              { name: 'Telegram ID', value: user.telegramId, inline: true },
              { name: 'Full Name', value: user.fullName || 'Not Available', inline: true },
              { name: 'Total Paid Tickets', value: paidTickets.length.toString(), inline: false }
            )
            .setTimestamp();

          await interaction.reply({ embeds: [embed], ephemeral: true });
        } catch (error) {
          log(`Error getting ticket creator info: ${error}`, "error");
          await interaction.reply({
            content: "An error occurred while fetching user information.",
            ephemeral: true
          });
        }
      }

      if (interaction.commandName === 'ping') {
        const ticket = await storage.getTicketByDiscordChannel(interaction.channelId);

        if (!ticket) {
          await interaction.reply({
            content: "This command can only be used in ticket channels!",
            ephemeral: true
          });
          return;
        }

        try {
          // Get ticket creator's info
          const user = await storage.getUser(ticket.userId!);
          if (!user || !user.telegramId) {
            await interaction.reply({
              content: "Could not find Telegram information for this ticket's creator.",
              ephemeral: true
            });
            return;
          }

          // Use member's display name if available, fallback to username
          const displayName = interaction.member?.displayName ||
            interaction.user.displayName ||
            interaction.user.username ||
            "Discord User";

          // Forward ping through bridge
          await this.bridge.forwardPingToTelegram(ticket.id, displayName);

          // Send confirmation
          await interaction.reply({
            content: "✅ The ticket creator has been successfully notified.",
            ephemeral: true
          });
        } catch (error) {
          log(`Error sending ping: ${error}`, "error");
          await interaction.reply({
            content: "Failed to send ping. Please try again.",
            ephemeral: true
          });
        }
      }

      if (interaction.commandName === 'paid') {
        const amount = interaction.options.getInteger('amount', true);
        const ticket = await storage.getTicketByDiscordChannel(interaction.channelId);

        if (!ticket) {
          await interaction.reply({
            content: "This command can only be used in ticket channels!",
            ephemeral: true
          });
          return;
        }

        try {
          await storage.updateTicketPayment(ticket.id, amount, interaction.user.id);

          const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('💰 Payment Recorded')
            .setDescription(`Ticket marked as paid by ${interaction.member?.displayName || interaction.user.username} on Discord`)
            .addFields(
              { name: 'Amount', value: `$${amount}`, inline: true },
              { name: 'Status', value: 'Completed & Paid', inline: true }
            )
            .setTimestamp();

          await interaction.reply({ embeds: [embed] });
        } catch (error) {
          log(`Error processing payment: ${error}`, "error");
          await interaction.reply({
            content: "Failed to process payment. Please try again.",
            ephemeral: true
          });
        }
      }

      if (interaction.commandName === 'close') {
        const ticket = await storage.getTicketByDiscordChannel(interaction.channelId);

        if (!ticket) {
          await interaction.reply({
            content: "This command can only be used in ticket channels!",
            ephemeral: true
          });
          return;
        }

        try {
          // Get category for transcript category ID
          const category = await storage.getCategory(ticket.categoryId);
          if (!category?.transcriptCategoryId) {
            await interaction.reply({
              content: "No transcript category set for this service. Please set it in the dashboard.",
              ephemeral: true
            });
            return;
          }

          // Get ticket creator's info for notification
          const user = await storage.getUser(ticket.userId!);
          if (user?.telegramId) {
            // Get staff member's display name
            const staffName = interaction.member?.displayName ||
              interaction.user.displayName ||
              interaction.user.username;

            // Send notification
            await this.bridge.getTelegramBot().sendMessage(
              parseInt(user.telegramId),
              `📝 Ticket Update\n\nYour ticket #${ticket.id} has been closed by ${staffName}.`
            );
          }

          // Mark ticket as closed
          await storage.updateTicketStatus(ticket.id, "closed");

          // Move channel to transcripts category
          const channel = await this.client.channels.fetch(interaction.channelId);
          if (!(channel instanceof TextChannel)) {
            throw new Error("Invalid channel type");
          }

          const transcriptCategory = await this.client.channels.fetch(category.transcriptCategoryId);
          if (!(transcriptCategory instanceof CategoryChannel)) {
            throw new Error("Invalid transcript category");
          }

          await channel.setParent(transcriptCategory.id);

          // Send confirmation embed
          const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('✅ Ticket Closed')
            .setDescription(`Ticket closed by ${interaction.user.username}`)
            .addFields(
              { name: 'Status', value: 'Closed', inline: true },
              { name: 'Moved to', value: transcriptCategory.name, inline: true }
            )
            .setTimestamp();

          await interaction.reply({ embeds: [embed] });
        } catch (error) {
          log(`Error closing ticket: ${error}`, "error");
          await interaction.reply({
            content: "Failed to close ticket. Please try again.",
            ephemeral: true
          });
        }
      }

      if (interaction.commandName === 'delete') {
        const ticket = await storage.getTicketByDiscordChannel(interaction.channelId);

        if (!ticket) {
          await interaction.reply({
            content: "This command can only be used in ticket channels!",
            ephemeral: true
          });
          return;
        }

        try {
          // Mark ticket as deleted in database
          await storage.updateTicketStatus(ticket.id, "deleted");

          // Send confirmation before deleting
          await interaction.reply({
            content: "🗑️ Deleting this ticket channel...",
            ephemeral: true
          });

          // Delete the channel
          const channel = await this.client.channels.fetch(interaction.channelId);
          if (channel instanceof TextChannel) {
            await channel.delete();
          }
        } catch (error) {
          log(`Error deleting ticket: ${error}`, "error");
          await interaction.reply({
            content: "Failed to delete ticket. Please try again.",
            ephemeral: true
          });
        }
      }

      if (interaction.commandName === 'deleteall') {
        const categoryChannel = interaction.options.getChannel('category', true);

        if (!(categoryChannel instanceof CategoryChannel)) {
          await interaction.reply({
            content: "Please select a valid category!",
            ephemeral: true
          });
          return;
        }

        try {
          // Get all text channels in the category
          const channels = categoryChannel.children.cache.filter(
            channel => channel.type === ChannelType.GuildText
          );

          if (channels.size === 0) {
            await interaction.reply({
              content: "No ticket channels found in this category.",
              ephemeral: true
            });
            return;
          }

          // Confirm with user
          await interaction.reply({
            content: `Are you sure you want to delete all ${channels.size} tickets in ${categoryChannel.name}? This action cannot be undone.`,
            ephemeral: true
          });

          // Delete all channels and update tickets
          for (const [_, channel] of channels) {
            if (channel instanceof TextChannel) {
              const ticket = await storage.getTicketByDiscordChannel(channel.id);
              if (ticket) {
                await storage.updateTicketStatus(ticket.id, "deleted");
              }
              await channel.delete();
            }
          }

          // Send final confirmation
          await interaction.followUp({
            content: `✅ Deleted ${channels.size} tickets from ${categoryChannel.name}`,
            ephemeral: true
          });
        } catch (error) {
          log(`Error in deleteall command: ${error}`, "error");
          await interaction.followUp({
            content: "An error occurred while deleting tickets. Some tickets may not have been deleted.",
            ephemeral: true
          });
        }
      }

      if (interaction.commandName === 'closeall') {
        const categoryChannel = interaction.options.getChannel('category', true);

        if (!(categoryChannel instanceof CategoryChannel)) {
          await interaction.reply({
            content: "Please select a valid category!",
            ephemeral: true
          });
          return;
        }

        try {
          // Get all text channels in the category
          const channels = categoryChannel.children.cache.filter(
            channel => channel.type === ChannelType.GuildText
          );

          if (channels.size === 0) {
            await interaction.reply({
              content: "No ticket channels found in this category.",
              ephemeral: true
            });
            return;
          }

          let moveCount = 0;
          let errorCount = 0;

          // Start the process
          await interaction.reply({
            content: `Moving ${channels.size} tickets to their respective transcript categories...`,
            ephemeral: true
          });

          // Get staff member's display name
          const staffName = interaction.member?.displayName ||
            interaction.user.displayName ||
            interaction.user.username;

          // Process all channels
          for (const [_, channel] of channels) {
            if (channel instanceof TextChannel) {
              try {
                const ticket = await storage.getTicketByDiscordChannel(channel.id);
                if (ticket) {
                  const category = await storage.getCategory(ticket.categoryId);
                  if (category?.transcriptCategoryId) {
                    const transcriptCategory = await this.client.channels.fetch(category.transcriptCategoryId);
                    if (transcriptCategory instanceof CategoryChannel) {
                      // Notify Telegram user before moving the channel
                      const user = await storage.getUser(ticket.userId!);
                      if (user?.telegramId) {
                        await this.bridge.getTelegramBot().sendMessage(
                          parseInt(user.telegramId),
                          `📝 Ticket Update\n\nYour ticket #${ticket.id} has been closed by ${staffName}.`
                        );
                      }

                      await channel.setParent(transcriptCategory.id);
                      await storage.updateTicketStatus(ticket.id, "closed");
                      moveCount++;
                    }
                  }
                }
              } catch (error) {
                log(`Error moving channel ${channel.name}: ${error}`, "error");
                errorCount++;
              }
            }
          }

          // Send final status
          await interaction.followUp({
            content: `✅ Processed ${channels.size} tickets:\n` +
              `• ${moveCount} tickets moved to transcripts\n` +
              `• ${errorCount} errors encountered`,
            ephemeral: true
          });
        } catch (error) {
          log(`Error in closeall command: ${error}`, "error");
          await interaction.followUp({
            content: "An error occurred while closing tickets. Some tickets may not have been processed.",
            ephemeral: true
          });
        }
      }

      if (interaction.commandName === 'nickname') {
        // Check if it's a ticket channel
        const ticket = await storage.getTicketByDiscordChannel(interaction.channelId);

        if (!ticket) {
          await interaction.reply({
            content: "This command can only be used in ticket channels!",
            ephemeral: true
          });
          return;
        }

        // Check if user is guild owner
        const guild = interaction.guild;
        if (!guild || interaction.user.id !== guild.ownerId) {
          await interaction.reply({
            content: "This command can only be used by the server owner!",
            ephemeral: true
          });
          return;
        }

        try {
          // Get ticket creator's info
          const user = await storage.getUser(ticket.userId!);
          if (!user || !user.telegramId) {
            await interaction.reply({
              content: "Could not find Telegram information for this ticket's creator.",
              ephemeral: true
            });
            return;
          }

          // Send the username as an embed for better formatting
          const embed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle('Ticket Creator Info')
            .addFields(
              { name: 'Telegram Username', value: user.username || 'Not set', inline: true },
              { name: 'Telegram ID', value: user.telegramId, inline: true }
            )
            .setTimestamp();

          await interaction.reply({ embeds: [embed], ephemeral: true });
        } catch (error) {
          log(`Error getting ticket creator info: ${error}`, "error");
          await interaction.reply({
            content: "An error occurred while fetching user information.",
            ephemeral: true
          });
        }
      }
    });

    // Handle all text messages
    this.client.on("messageCreate", async (message) => {
      // Ignore bot messages to prevent loops
      if (message.author.bot) return;
      if (message.content.startsWith('.')) return;

      const ticket = await storage.getTicketByDiscordChannel(message.channelId);
      if (!ticket) {
        log(`No ticket found for channel ${message.channelId}`);
        return;
      }

      log(`Processing Discord message for ticket ${ticket.id} in channel ${message.channelId}`);

      try {
        // Store message in database first to ensure it's recorded
        const discordUser = await storage.getUserByDiscordId(message.author.id);
        if (discordUser) {
          await storage.createMessage({
            ticketId: ticket.id,
            content: message.content || "Sent an attachment",
            authorId: discordUser.id,
            platform: "discord",
            timestamp: new Date()
          });
          log(`Stored Discord message in database for ticket ${ticket.id}`);
        }

        // Get image attachments
        const imageAttachments = message.attachments.filter(attachment =>
          attachment.contentType?.startsWith('image/') ||
          /\.(jpg|jpeg|png|gif|webp)$/i.test(attachment.name || '')
        );

        // Forward content to Telegram
        await this.bridge.forwardToTelegram(
          message.content,
          ticket.id,
          message.member?.displayName || message.author.username || "Unknown Discord User",
          imageAttachments.size > 0 ? Array.from(imageAttachments.values()) : undefined
        );

        log(`Successfully forwarded message to Telegram for ticket ${ticket.id}`);
      } catch (error) {
        log(`Error handling Discord message: ${error}`, "error");
      }
    });

    // Handle message edits
    this.client.on("messageUpdate", async (oldMessage, newMessage) => {
      if (newMessage.author?.bot) return;
      if (!newMessage.content || newMessage.content.startsWith('.')) return;

      const ticket = await storage.getTicketByDiscordChannel(newMessage.channelId);
      if (!ticket) return;

      log(`Processing edited Discord message for ticket ${ticket.id}`);

      await this.bridge.forwardToTelegram(
        `[EDITED] ${newMessage.content}`,
        ticket.id,
        newMessage.member?.displayName || newMessage.author?.username || "Unknown Discord User"
      );
    });
  }

  private async sendTicketMessage(channelId: string, embed: any): Promise<void> {
    try {
      log(`Attempting to send and pin ticket message in channel ${channelId}`);

      // Send only through the bot's native message functionality
      const channel = await this.client.channels.fetch(channelId);
      if (!(channel instanceof TextChannel)) {
        throw new Error(`Invalid channel type for channel ${channelId}`);
      }

      // Send the message first
      const message = await channel.send({ embeds: embed.embeds });

      try {
        // Pin the message using the pinnable interface
        await message.pin();
        log(`Successfully pinned message in channel ${channelId}`);
      } catch (pinError) {
        log(`Error pinning message: ${pinError}`, "error");
        // Don't throw here - the message was sent successfully even if pinning failed
      }

      log(`Successfully sent ticket message in channel ${channelId}`);
    } catch (error) {
      log(`Error sending ticket message: ${error}`, "error");
      throw error;
    }
  }



  async createTicketChannel(categoryId: string, name: string): Promise<string> {
    try {
      log(`Creating ticket channel ${name} in category ${categoryId}`);

      await this.checkRateLimit('channelCreate');
      const category = await this.client.channels.fetch(categoryId);
      if (!category || category.type !== ChannelType.GuildCategory) {
        throw new Error(`Invalid category ${categoryId}`);
      }

      const channel = await (category as CategoryChannel).guild.channels.create({
        name,
        parent: category,
        type: ChannelType.GuildText
      });

      log(`Successfully created channel ${channel.id}`);
      return channel.id;
    } catch (error) {
      log(`Error creating ticket channel: ${error}`, "error");
      throw error;
    }
  }

  private async sendMessage(channelId: string, message: WebhookMessage, username: string): Promise<void> {
    try {
      log(`Attempting to send message to Discord channel ${channelId}`);

      // Check rate limits
      await this.globalCheck();
      await this.webhookCheck(channelId);

      const channel = await this.client.channels.fetch(channelId);
      if (!(channel instanceof TextChannel)) {
        throw new Error(`Invalid channel type for channel ${channelId}`);
      }

      // Get webhook
      const webhook = await this.getWebhookForChannel(channel);
      if (!webhook) throw new Error("Failed to get webhook");

      // Prepare webhook message
      const messageOptions: any = {
        username: username,
        avatarURL: message.avatarURL // This is case sensitive for Discord webhooks
      };

      // Handle different types of content
      if (message.embeds) {
        // Embed message (for images)
        messageOptions.embeds = message.embeds;
        messageOptions.content = message.content || "\u200B";
      } else if (message.files && message.files.length > 0) {
        // Message with file attachments
        messageOptions.files = message.files.map((file: any) => ({
          attachment: file.attachment,
          name: file.name || 'file.jpg',
          description: file.description || 'File attachment'
        }));
        messageOptions.content = message.content || "\u200B";
      } else {
        // Regular text message
        messageOptions.content = typeof message === 'string' ?
          message : (message.content || "\u200B");
      }

      // Add debug logging
      log(`Sending message with options: ${JSON.stringify({
        username: messageOptions.username,
        avatarURL: messageOptions.avatarURL,
        content: messageOptions.content.substring(0, 100) + (messageOptions.content.length > 100 ? '...' : ''),
        files: messageOptions.files ? `${messageOptions.files.length} files` : 'no files',
        embeds: messageOptions.embeds ? `${messageOptions.embeds.length} embeds` : 'no embeds'
      })}`);

      // Send message with retries
      let retries = 0;
      const maxRetries = 3;

      while (retries < maxRetries) {
        try {
          await webhook.send(messageOptions);
          log(`Successfully sent message to Discord channel ${channelId}`);
          return;
        } catch (error) {
          retries++;
          log(`Attempt ${retries}/${maxRetries} failed: ${error}`, "error");

          if (retries === maxRetries) throw error;
          await new Promise(resolve => setTimeout(resolve, 1000 * retries));
        }
      }
    } catch (error) {
      log(`Error sending message to Discord: ${error}`, "error");
      throw error;
    }
  }

  private async getWebhookForChannel(channel: TextChannel): Promise<WebhookClient | null> {
    try {
      // Prevent concurrent webhook creation for same channel
      if (this.webhookCreationLock.has(channel.id)) {
        log(`Waiting for webhook creation lock on channel ${channel.id}`);
        while (this.webhookCreationLock.has(channel.id)) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      // Check existing webhooks first
      let webhooks = this.webhooks.get(channel.id) || [];
      webhooks = webhooks.filter(w => w.failures < this.MAX_WEBHOOK_FAILURES);

      // Sort webhooks by failure count and last used time
      webhooks.sort((a, b) => {
        if (a.failures !== b.failures) return a.failures - b.failures;
        return a.lastUsed - b.lastUsed;
      });

      // Use existing webhook if available and not overloaded
      if (webhooks.length > 0) {
        const webhook = webhooks[0];
        webhook.lastUsed = Date.now();
        return webhook.webhook;
      }

      // Set creation lock
      this.webhookCreationLock.add(channel.id);

      try {
        // Check for existing webhooks first
        const existingWebhooks = await channel.fetchWebhooks();
        const messageRelayWebhooks = existingWebhooks.filter(w => w.name === "Message Relay");

        // If we have too many webhooks, remove the oldest ones
        if (messageRelayWebhooks.size >= 5) {
          const oldestWebhooks = Array.from(messageRelayWebhooks.values())
            .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
            .slice(0, messageRelayWebhooks.size - 4);

          for (const webhook of oldestWebhooks) {
            await webhook.delete('Cleaning up old webhooks');
            log(`Deleted old webhook ${webhook.id} from channel ${channel.id}`);
          }
        }

        // Create new webhook if needed
        let webhook = messageRelayWebhooks.first();
        if (!webhook) {
          webhook = await channel.createWebhook({
            name: "Message Relay",
            reason: 'For message bridging'
          });
          log(`Created new webhook ${webhook.id} for channel ${channel.id}`);
        }

        const webhookClient = new WebhookClient({ url: webhook.url });
        const webhookPool: WebhookPool = {
          webhook: webhookClient,
          lastUsed: Date.now(),
          failures: 0
        };

        // Update webhook pool
        webhooks.push(webhookPool);
        this.webhooks.set(channel.id, webhooks.slice(0, 5)); // Keep max 5 webhooks
        return webhookClient;
      } finally {
        // Always release lock
        this.webhookCreationLock.delete(channel.id);
      }
    } catch (error) {
      log(`Error getting/creating webhook: ${error}`, "error");
      return null;
    }
  }

  // Add periodic cleanup for stale webhooks
  private cleanupStaleWebhooks() {
    const now = Date.now();
    for (const [channelId, webhooks] of this.webhooks) {
      // Remove webhooks that haven't been used in 30 minutes or have too many failures
      const activeWebhooks = webhooks.filter(webhook =>
        now - webhook.lastUsed < 1800000 && webhook.failures < this.MAX_WEBHOOK_FAILURES
      );

      if (activeWebhooks.length !== webhooks.length) {
        if (activeWebhooks.length === 0) {
          this.webhooks.delete(channelId);
          log(`Removed all stale webhooks for channel ${channelId}`);
        } else {
          this.webhooks.set(channelId, activeWebhooks);
          log(`Cleaned up ${webhooks.length - activeWebhooks.length} stale webhooks for channel ${channelId}`);
        }
      }
    }
  }

  async moveChannelToCategory(channelId: string, categoryId: string): Promise<void> {
    try {
      log(`Moving channel ${channelId} to category ${categoryId}`);

      await this.checkRateLimit('channelEdit'); //Added rate limit check

      const channel = await this.client.channels.fetch(channelId);
      if (!(channel instanceof TextChannel)) {
        throw new Error(`Invalid channel type for channel ${channelId}`);
      }

      const category = await this.client.channels.fetch(categoryId);
      if (!(category instanceof CategoryChannel)) {
        throw new Error(`Invalid category ${categoryId}`);
      }

      await channel.setParent(category.id);
      log(`Successfully moved channel ${channelId} to category ${categoryId}`);
    } catch (error) {
      log(`Error moving channel to category: ${error}`, "error");
      throw error;
    }
  }

  async getCategories() {
    try {
      // Get the first guild (server) the bot is in
      await this.globalCheck(); // Added rate limit check
      const guilds = await this.client.guilds.fetch();
      const firstGuild = guilds.first();
      if (!firstGuild) {
        const error = new Error("Bot is not in any servers");
        this.lastError = error;
        throw error;
      }

      // Fetch the complete guild object
      const guild = await firstGuild.fetch();

      // Get all categories in the guild
      const categories = await guild.channels.fetch();
      const categoryChannels = categories
        .filter(channel => channel?.type === ChannelType.GuildCategory)
        .map(category => ({
          id: category!.id,
          name: category!.name
        }));

      return categoryChannels;
    } catch (error) {
      this.lastError = error instanceof Error ? error : new Error(String(error));
      log(`Error getting Discord categories: ${error}`, "error");
      throw error;
    }
  }

  async getRoles() {
    try {
      const guilds = await this.client.guilds.fetch();
      const guild = await guilds.first()?.fetch();
      if (!guild) {
        const error = new Error("No guild found");
        this.lastError = error;
        throw error;
      }

      return guild.roles.cache.sort((roleA, roleB) => {
        return (roleB?.position || 0) - (roleA?.position || 0);
      }).map(role => ({
        id: role.id,
        name: role.name,
        color: role.hexColor
      }));
    } catch (error) {
      this.lastError = error instanceof Error ? error : new Error(String(error));
      log(`Error getting Discord roles: ${error}`, "error");
      throw error;
    }
  }

  async start() {
    try {
      // Clear any existing timeouts and reset last error
      if (this.connectionTimeout) {
        clearTimeout(this.connectionTimeout);
      }
      this.lastError = null;

      // Set connection timeout
      this.connectionTimeout = setTimeout(() => {
        log("Connection timeout reached, destroying client...", "warn");
        this.lastError = new Error("Connection timeout reached");
        this.client.destroy()
          .catch(error => log(`Error destroying client: ${error}`, "error"));
      }, this.wsCleanupConfig.connectionTimeout);

      await this.client.login(process.env.DISCORD_BOT_TOKEN);

      // Clear timeout on successful connection
      if (this.connectionTimeout) {
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;
      }

      log("Discord bot started successfully");
    } catch (error) {
      this.lastError = error instanceof Error ? error : new Error(String(error));
      log(`Error starting Discord bot: ${error}`, "error");
      throw error;
    }
  }

  async stop() {
    try {
      // Clear all intervals and timeouts
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
        this.cleanupInterval = null;
      }
      if (this.connectionTimeout) {
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;
      }

      // Cleanup all webhooks
      for (const [channelId, webhooks] of this.webhooks) {
        for (const webhook of webhooks) {
          try {
            await webhook.webhook.deleteIfExists();
          } catch (error) {
            log(`Error deleting webhook for channel ${channelId}: ${error}`, "warn");
          }
        }
      }
      this.webhooks.clear();

      // Destroy the client
      if (this.client) {
        await this.client.destroy();
      }

      log("Discord bot stopped successfully");
    } catch (error) {
      log(`Error stopping Discord bot: ${error}`, "error");
      throw error;
    }
  }

  isReady() {
    return this.client.isReady();
  }
  
  // Get the last error that occurred
  getLastError(): string | undefined {
    return this.lastError?.message;
  }
}