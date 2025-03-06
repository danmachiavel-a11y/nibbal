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
} from "discord.js";
import { storage } from "../storage";
import { BridgeManager } from "./bridge";
import { log } from "../vite";

if (!process.env.DISCORD_BOT_TOKEN) {
  throw new Error("DISCORD_BOT_TOKEN is required");
}

export class DiscordBot {
  private client: Client;
  private bridge: BridgeManager;
  private webhooks: Map<string, Webhook>;
  private webhookCreationLock: Set<string> = new Set(); // Add lock to prevent concurrent creation

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
    this.setupHandlers();
  }

  private async registerSlashCommands() {
    try {
      // Check if commands are already registered
      const existingCommands = await this.client.application?.commands.fetch();
      if (existingCommands && existingCommands.size > 0) {
        log("Slash commands already registered, skipping registration");
        return;
      }

      // Add delay to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Commands to register
      const commands = [
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
          name: 'close',
          description: 'Close the ticket and move it to transcripts',
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
            content: message.content,
            authorId: discordUser.id,
            platform: "discord",
            timestamp: new Date()
          });
          log(`Stored Discord message in database for ticket ${ticket.id}`);
        }

        // Forward text content to Telegram if present
        if (message.content) {
          try {
            await this.bridge.forwardToTelegram(
              message.content,
              ticket.id,
              message.member?.displayName || message.author.username || "Unknown Discord User"
            );
            log(`Successfully forwarded text message to Telegram for ticket ${ticket.id}`);
          } catch (error) {
            log(`Failed to forward text message to Telegram for ticket ${ticket.id}: ${error}`, "error");
          }
        }

        // Handle image attachments
        if (message.attachments.size > 0) {
          const imageAttachments = message.attachments.filter(attachment => 
            attachment.contentType?.startsWith('image/') || 
            /\.(jpg|jpeg|png|gif|webp)$/i.test(attachment.name || '')
          );

          if (imageAttachments.size > 0) {
            log(`Found ${imageAttachments.size} image attachments in message`);

            for (const [_, attachment] of imageAttachments) {
              try {
                await this.bridge.forwardImageToTelegram(
                  attachment.url,
                  ticket.id,
                  message.member?.displayName || message.author.username || "Unknown Discord User"
                );
                log(`Successfully forwarded image ${attachment.url} to Telegram`);
              } catch (error) {
                log(`Failed to forward image to Telegram: ${error}`, "error");
              }
            }
          }
        }

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

  // Add helper function for webhook management
  private async getOrCreateWebhook(channel: TextChannel, avatarUrl?: string): Promise<Webhook> {
    try {
      // Check cache first
      let webhook = this.webhooks.get(channel.id);
      if (webhook) {
        try {
          // Verify webhook is still valid
          await webhook.fetch();
          return webhook;
        } catch (error) {
          log(`Cached webhook invalid, will create new one: ${error}`, "error");
          this.webhooks.delete(channel.id);
        }
      }

      // Prevent concurrent webhook creation for same channel
      if (this.webhookCreationLock.has(channel.id)) {
        log(`Waiting for webhook creation lock on channel ${channel.id}`);
        // Wait for lock to be released
        while (this.webhookCreationLock.has(channel.id)) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        // Check cache again after waiting
        webhook = this.webhooks.get(channel.id);
        if (webhook) return webhook;
      }

      // Set lock
      this.webhookCreationLock.add(channel.id);

      try {
        // Check for existing webhook first
        const existingWebhooks = await channel.fetchWebhooks();
        webhook = existingWebhooks.find(w => w.name === "Telegram Bridge");

        if (!webhook) {
          // Add delay to avoid rate limits
          await new Promise(resolve => setTimeout(resolve, 1000));
          log(`Creating new webhook for channel ${channel.id}`);
          webhook = await channel.createWebhook({
            name: "Telegram Bridge",
            avatar: avatarUrl
          });
        }

        // Cache the webhook
        this.webhooks.set(channel.id, webhook);
        log(`Using webhook: ${webhook.id} for channel ${channel.id}`);
        return webhook;
      } finally {
        // Always release lock
        this.webhookCreationLock.delete(channel.id);
      }
    } catch (error) {
      log(`Error getting/creating webhook: ${error}`, "error");
      throw error;
    }
  }

  // Update sendMessage to use the new helper
  async sendMessage(channelId: string, content: string, username: string, avatarUrl?: string, embed?: boolean): Promise<void> {
    try {
      log(`Attempting to send message to Discord channel ${channelId}`);

      const channel = await this.client.channels.fetch(channelId);
      if (!(channel instanceof TextChannel)) {
        throw new Error(`Invalid channel type for channel ${channelId}`);
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

        // Add delay before pinning to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 1000));
        await embedMessage.pin();
        log(`Pinned embed message in channel ${channelId}`);
      } else {
        // Get or create webhook with proper caching
        const webhook = await this.getOrCreateWebhook(channel, avatarUrl);

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

  async getCategories() {
    try {
      // Get the first guild (server) the bot is in
      const guilds = await this.client.guilds.fetch();
      const firstGuild = guilds.first();
      if (!firstGuild) {
        throw new Error("Bot is not in any servers");
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
      log(`Error getting Discord categories: ${error}`, "error");
      throw error;
    }
  }

  async getRoles() {
    try {
      // Get the first guild (server) the bot is in
      const guilds = await this.client.guilds.fetch();
      const firstGuild = guilds.first();
      if (!firstGuild) {
        throw new Error("Bot is not in any servers");
      }

      // Fetch the complete guild object
      const guild = await firstGuild.fetch();

      // Get all roles in the guild
      const roles = await guild.roles.fetch();
      const roleList = roles.map(role => ({
        id: role.id,
        name: role.name,
        color: role.hexColor
      }));

      // Sort roles by position (higher roles first)
      return roleList.sort((a, b) => {
        const roleA = roles.get(a.id);
        const roleB = roles.get(b.id);
        return (roleB?.position || 0) - (roleA?.position || 0);
      });
    } catch (error) {
      log(`Error getting Discord roles: ${error}`, "error");
      throw error;
    }
  }

  async start() {
    await this.client.login(process.env.DISCORD_BOT_TOKEN);
  }

  async stop() {
    try {
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
      log("Discord bot stopped");
    } catch (error) {
      log(`Error stopping Discord bot: ${error}`, "error");
      throw error;
    }
  }

  isReady() {
    return this.client.isReady();
  }
}