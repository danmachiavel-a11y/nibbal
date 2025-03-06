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
  ChannelSelectMenuBuilder,
  ActionRowBuilder,
  Collection
} from "discord.js";
import { storage } from "../storage";
import { BridgeManager } from "./bridge";
import { log } from "../vite";

// Improved cooldown helper with caching
class Cooldown {
  private static cooldowns = new Map<string, number>();
  private static cache = new Map<string, { data: any; timestamp: number }>();
  private static readonly DEFAULT_COOLDOWN = 30000; // 30 seconds
  private static readonly CACHE_DURATION = 60000; // 1 minute

  static async execute<T>(
    key: string,
    fn: () => Promise<T>,
    cooldownMs: number = this.DEFAULT_COOLDOWN
  ): Promise<T> {
    // Check cache first
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < this.CACHE_DURATION) {
      return cached.data;
    }

    const lastExecution = this.cooldowns.get(key);
    const now = Date.now();

    if (lastExecution && now - lastExecution < cooldownMs) {
      const waitTime = cooldownMs - (now - lastExecution);
      log(`Rate limit hit for ${key}, waiting ${waitTime}ms`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    try {
      const result = await fn();
      this.cooldowns.set(key, Date.now());
      this.cache.set(key, { data: result, timestamp: Date.now() });
      return result;
    } catch (error) {
      log(`Error executing ${key}: ${error}`, "error");
      if (cached) {
        return cached.data;
      }
      throw error;
    }
  }

  static clearCache() {
    this.cache.clear();
    this.cooldowns.clear();
  }
}

if (!process.env.DISCORD_BOT_TOKEN) {
  throw new Error("DISCORD_BOT_TOKEN is required");
}

export class DiscordBot {
  private client: Client;
  private bridge: BridgeManager;
  private webhooks: Map<string, Webhook>;
  private _isReady: boolean = false;
  private readyPromise: Promise<void>;
  private readyResolve!: () => void;
  private connectionTimeout: NodeJS.Timeout | null = null;

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
    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });
    this.setupHandlers();
  }

  async start() {
    try {
      // Check if already running
      if (this._isReady) {
        log("Discord bot is already running");
        return;
      }

      log("Starting Discord bot...");

      // Reset ready promise
      this.readyPromise = new Promise((resolve) => {
        this.readyResolve = resolve;
      });

      // Set a connection timeout
      this.connectionTimeout = setTimeout(() => {
        if (!this._isReady) {
          log("Discord bot connection timeout - attempting restart", "error");
          this.stop().catch(e => log(`Error stopping bot during timeout: ${e}`, "error"));
        }
      }, 30000); // 30 second timeout

      // Login and wait for ready event
      await this.client.login(process.env.DISCORD_BOT_TOKEN);
      log("Discord login successful, waiting for ready event...");

      // Wait for ready event
      await Promise.race([
        this.readyPromise,
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Discord login timeout")), 30000)
        )
      ]);

      if (this.connectionTimeout) {
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;
      }

      log("Discord bot is fully initialized and ready");
    } catch (error) {
      this._isReady = false;
      if (this.connectionTimeout) {
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;
      }
      log(`Error starting Discord bot: ${error}`, "error");
      throw error;
    }
  }

  async stop() {
    try {
      if (!this._isReady && !this.client.isReady()) {
        log("Discord bot is not running");
        return;
      }

      log("Stopping Discord bot...");

      // Clear any pending timeouts
      if (this.connectionTimeout) {
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;
      }

      // Clear cooldowns and cache
      Cooldown.clearCache();

      // Destroy all webhooks
      for (const [_, webhook] of this.webhooks) {
        try {
          await webhook.delete();
        } catch (error) {
          log(`Error deleting webhook: ${error}`, "error");
        }
      }
      this.webhooks.clear();

      // Destroy the client
      this.client.destroy();
      this._isReady = false;

      // Reset ready promise
      this.readyPromise = new Promise((resolve) => {
        this.readyResolve = resolve;
      });

      log("Discord bot stopped successfully");
    } catch (error) {
      log(`Error stopping Discord bot: ${error}`, "error");
      throw error;
    }
  }

  isReady() {
    return this._isReady && this.client.isReady();
  }

  private setupHandlers() {
    this.client.once("ready", () => {
      log("Discord bot connected and ready");
      this._isReady = true;
      this.readyResolve();
      this.registerSlashCommands().catch(error => 
        log(`Error registering slash commands: ${error}`, "error")
      );
    });

    // Log disconnects
    this.client.on("disconnect", () => {
      log("Discord bot disconnected", "error");
      this._isReady = false;
    });

    // Log reconnects
    this.client.on("reconnecting", () => {
      log("Discord bot reconnecting...");
    });

    // Handle errors
    this.client.on("error", (error) => {
      log(`Discord bot error: ${error}`, "error");
    });

    this.client.on('interactionCreate', async (interaction) => {
      if (!interaction.isChatInputCommand()) return;

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
    });

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
            content: message.content,
            authorId: discordUser.id,
            platform: "discord",
            timestamp: new Date()
          });
          log(`Stored Discord message in database for ticket ${ticket.id}`);
        }

        // Forward to Telegram with detailed error tracking
        try {
          // Handle text message
          if (message.content) {
            await this.bridge.forwardToTelegram(
              message.content,
              ticket.id,
              message.member?.displayName || message.author.username || "Unknown Discord User"
            );
            log(`Successfully forwarded text to Telegram for ticket ${ticket.id}`);
          }

          // Handle attachments (images)
          if (message.attachments.size > 0) {
            for (const [_, attachment] of message.attachments) {
              if (attachment.contentType?.startsWith('image/')) {
                await this.bridge.forwardImageToTelegram(
                  attachment.url,
                  ticket.id,
                  message.member?.displayName || message.author.username || "Unknown Discord User"
                );
                log(`Successfully forwarded image to Telegram for ticket ${ticket.id}`);
              }
            }
          }
        } catch (error) {
          log(`Failed to forward message to Telegram for ticket ${ticket.id}: ${error}`, "error");
          // Don't throw here - we already stored the message in DB
        }

      } catch (error) {
        log(`Error handling Discord message: ${error}`, "error");
      }
    });

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

  async getCategories() {
    return Cooldown.execute('getCategories', async () => {
      try {
        if (!this._isReady) {
          log("Discord bot is not ready, waiting for ready state...");
          await this.readyPromise;
        }

        log("Fetching Discord categories...");
        const guilds = await this.client.guilds.fetch();
        const firstGuild = guilds.first();
        if (!firstGuild) {
          throw new Error("Bot is not in any servers");
        }

        const guild = await firstGuild.fetch();
        const categories = await guild.channels.fetch();

        // Filter and map in one pass to reduce operations
        const categoryChannels = Array.from(categories.values())
          .filter(channel => channel?.type === ChannelType.GuildCategory)
          .map(category => ({
            id: category!.id,
            name: category!.name
          }));

        log(`Found ${categoryChannels.length} categories`);
        return categoryChannels;
      } catch (error) {
        log(`Error getting Discord categories: ${error}`, "error");
        throw error;
      }
    });
  }

  async getRoles() {
    return Cooldown.execute('getRoles', async () => {
      try {
        if (!this._isReady) {
          log("Discord bot is not ready, waiting for ready state...");
          await this.readyPromise;
        }

        log("Fetching Discord roles...");
        const guilds = await this.client.guilds.fetch();
        const firstGuild = guilds.first();
        if (!firstGuild) {
          throw new Error("Bot is not in any servers");
        }

        const guild = await firstGuild.fetch();
        const roles = await guild.roles.fetch();

        // Convert to array and sort in one pass
        const roleList = Array.from(roles.values())
          .map(role => ({
            id: role.id,
            name: role.name,
            color: role.hexColor,
            position: role.position
          }))
          .sort((a, b) => b.position - a.position);

        log(`Found ${roleList.length} roles`);
        return roleList;
      } catch (error) {
        log(`Error getting Discord roles: ${error}`, "error");
        throw error;
      }
    });
  }

  private async registerSlashCommands() {
    try {
      await this.client.application?.commands.create({
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
      });

      await this.client.application?.commands.create({
        name: 'close',
        description: 'Close the ticket and move it to transcripts',
        type: ApplicationCommandType.ChatInput
      });

      await this.client.application?.commands.create({
        name: 'delete',
        description: 'Delete this ticket channel',
        type: ApplicationCommandType.ChatInput
      });

      await this.client.application?.commands.create({
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
      });

      await this.client.application?.commands.create({
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
      });

      log("Registered slash commands");
    } catch (error) {
      log(`Error registering slash commands: ${error}`, "error");
    }
  }

  async createTicketChannel(categoryId: string, name: string): Promise<string> {
    try {
      log(`Creating ticket channel ${name} in category ${categoryId}`);

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

  async sendMessage(channelId: string, content: string, username: string, avatarUrl?: string, embed?: boolean): Promise<void> {
    try {
      log(`Attempting to send message to Discord channel ${channelId}`);

      const channel = await this.client.channels.fetch(channelId);
      if (!(channel instanceof TextChannel)) {
        throw new Error(`Invalid channel type for channel ${channelId}`);
      }

      // Create or get webhook
      let webhook = this.webhooks.get(channelId);
      if (!webhook) {
        log(`Creating new webhook for channel ${channelId}`);
        webhook = await channel.createWebhook({
          name: "Telegram Bridge",
          avatar: avatarUrl
        });
        this.webhooks.set(channelId, webhook);
        log(`Created webhook: ${webhook.id} for channel ${channelId}`);
      }

      if (embed) {
        // Send as embed
        const embedMessage = await channel.send({
          embeds: [
            new EmbedBuilder()
              .setDescription(content)
              .setColor(0x0099FF)
          ]
        });

        // Pin the embed message
        await embedMessage.pin();
        log(`Pinned embed message in channel ${channelId}`);
      } else {
        // Send regular message via webhook
        await webhook.send({
          content,
          username,
          avatarURL: avatarUrl
        });
      }

      log(`Successfully sent message to Discord channel ${channelId}`);
    } catch (error) {
      log(`Error sending message to Discord: ${error}`, "error");
      throw error;
    }
  }

  async moveChannelToCategory(channelId: string, categoryId: string): Promise<void> {
    try {
      log(`Moving channel ${channelId} to category ${categoryId}`);

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
}