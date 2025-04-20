interface WebhookMessage {
  content?: string;
  username: string;
  avatarURL?: string;
  embeds?: any[];
  components?: any[]; // Add support for buttons and other components
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
  WebhookClient,
  PermissionFlagsBits,
  Guild,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  ChatInputCommandInteraction,
  AutocompleteInteraction
} from "discord.js";
import { storage } from "../storage";
import { BridgeManager } from "./bridge";
import { log } from "../vite";

export class DiscordBot {
  public client: Client;
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
  private isConnecting: boolean = false;
  private isConnected: boolean = false;
  private connectionError: string | null = null;

  // Rate limit configurations
  private readonly LIMITS = {
    global: { capacity: 90, refillTime: 1000 }, // 90 per second (was 45)
    webhook: { capacity: 8, refillTime: 5000 }, // 8 per 5 seconds (was 4)
    channelCreate: { capacity: 15, refillTime: 10000 }, // 15 per 10 seconds (was 9)
    channelEdit: { capacity: 8, refillTime: 10000 }, // 8 per 10 seconds (was 4)
    messagesFetch: { capacity: 90, refillTime: 1000 }, // 90 per second (was 45)
    application: { capacity: 10, refillTime: 20000 }, // 10 per 20 seconds (was 5) - for application commands
  };

  // Webhook management constants
  private readonly MAX_WEBHOOK_FAILURES = 3;
  private readonly WEBHOOK_TIMEOUT = 300000; // 5 minutes
  private readonly MAX_WEBHOOKS_PER_CHANNEL = 5;

  constructor(bridge: BridgeManager) {
    log(`Initializing Discord bot client, token available: ${process.env.DISCORD_BOT_TOKEN ? 'Yes' : 'No'}`);
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
    
    // Log initial client state
    log(`Discord client initialized, has token: ${this.client.token ? 'Yes' : 'No'}`);
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
  
  /**
   * Check if a Discord user has admin privileges
   * First checks if they're the server owner, then server admin, then configured admin
   * @param userId Discord user ID to check
   * @param guild Discord guild (server) object
   * @returns {Promise<boolean>} True if the user is an admin
   */
  private async isUserAdmin(userId: string, guild: Guild): Promise<boolean> {
    // Always allow server owner
    if (userId === guild.ownerId) {
      return true;
    }
    
    try {
      // Check if user is in the configured admin list
      const isConfiguredAdmin = await storage.isDiscordAdmin(userId);
      if (isConfiguredAdmin) {
        return true;
      }
      
      // Check Discord admin permission
      const member = await guild.members.fetch(userId);
      if (member && member.permissions.has(PermissionFlagsBits.Administrator)) {
        return true;
      }
    } catch (error) {
      log(`Error checking admin status: ${error}`, "error");
    }
    
    return false;
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
        // Prioritize the claim and unclaim commands
        {
          name: 'claim',
          description: 'Claim exclusive handling of this ticket',
          type: ApplicationCommandType.ChatInput
        },
        {
          name: 'unclaim',
          description: 'Release a claimed ticket back to the staff pool',
          type: ApplicationCommandType.ChatInput
        },
        // Ban and unban commands
        {
          name: 'ban',
          description: 'Ban a user from creating tickets',
          type: ApplicationCommandType.ChatInput,
          options: [
            {
              name: 'telegramid',
              description: 'The Telegram ID of the user to ban',
              type: ApplicationCommandOptionType.String,
              required: false
            },
            {
              name: 'ticketid',
              description: 'The Ticket ID to find and ban the user who created it',
              type: ApplicationCommandOptionType.Integer,
              required: false
            },
            {
              name: 'reason',
              description: 'Reason for banning the user',
              type: ApplicationCommandOptionType.String,
              required: false
            }
          ]
        },
        {
          name: 'unban',
          description: 'Unban a user so they can create tickets again',
          type: ApplicationCommandType.ChatInput,
          options: [
            {
              name: 'telegramid',
              description: 'The Telegram ID of the user to unban',
              type: ApplicationCommandOptionType.String,
              required: false
            },
            {
              name: 'ticketid',
              description: 'The Ticket ID to find and unban the user who created it',
              type: ApplicationCommandOptionType.Integer,
              required: false
            }
          ]
        },
        // Then add the rest of the commands
        {
          name: 'close',
          description: 'Close the ticket and move it to transcripts',
          type: ApplicationCommandType.ChatInput
        },
        {
          name: 'reopen',
          description: 'Reopen a closed ticket and move it back to its original category',
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
          name: 'listservices',
          description: 'List all service categories with their IDs',
          type: ApplicationCommandType.ChatInput
        },
        {
          name: 'closeservice',
          description: 'Close a service category so new tickets cannot be created',
          type: ApplicationCommandType.ChatInput,
          options: [
            {
              name: 'category',
              description: 'Select the service category to close',
              type: ApplicationCommandOptionType.String,
              required: true,
              autocomplete: true
            }
          ]
        },
        {
          name: 'openservice',
          description: 'Open a service category so new tickets can be created',
          type: ApplicationCommandType.ChatInput,
          options: [
            {
              name: 'category',
              description: 'Select the service category to open',
              type: ApplicationCommandOptionType.String,
              required: true,
              autocomplete: true
            }
          ]
        },
        {
          name: 'info',
          description: 'Get Telegram user information (Owner only)',
          type: ApplicationCommandType.ChatInput
        },
        {
          name: 'delete',
          description: 'Delete this ticket channel (Admin only)',
          type: ApplicationCommandType.ChatInput
        },
        {
          name: 'deleteall',
          description: 'Delete all tickets in a category (Admin only)',
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
          description: 'Get Telegram username of ticket creator (Admin only)',
          type: ApplicationCommandType.ChatInput
        },
        {
          name: 'closeallunsafe',
          description: 'Close ALL tickets across ALL categories (Admin only, use with caution!)',
          type: ApplicationCommandType.ChatInput
        }
      ];

      // Register commands with rate limit handling
      for (const command of commands) {
        await this.checkRateLimit('application');
        try {
          if (!this.client.application) {
            log("Discord application not available for command registration", "warn");
            continue;
          }
          
          // Type assertion for ApplicationCommandData to ensure compatibility
          const commandData = {
            ...command,
            type: command.type === ApplicationCommandType.ChatInput ? 
                  ApplicationCommandType.ChatInput : command.type
          };
          
          await this.client.application.commands.create(commandData as any);
          
          // Add delay between each command registration
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          // Enhanced logging for command registration
          if (command.name === 'ban' || command.name === 'unban' || command.name === 'closeall' || command.name === 'deleteall') {
            log(`Registered special command: ${command.name} with options: ${JSON.stringify(command.options)}`, "info");
          } else {
            log(`Registered command: ${command.name}`);
          }
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
      const guilds = this.client.guilds.cache.size;
      log(`Discord bot ready with ${guilds} guilds. Client token present: ${!!this.client.token}`, "info");
      
      // Log connected guild information for diagnostic purposes
      if (guilds > 0) {
        const guildList = Array.from(this.client.guilds.cache.values())
          .map(g => `${g.name} (ID: ${g.id}, Members: ${g.memberCount})`);
        log(`Connected to guilds: ${guildList.join(", ")}`, "info");
      } else {
        log("Warning: Discord bot is not connected to any guilds", "warn");
      }
      
      await this.registerSlashCommands();
    });

    // Handle autocomplete interactions
    // Setup error handler for process-level uncaught exceptions
    process.on('uncaughtException', (error) => {
      log(`CRITICAL: Uncaught exception in Discord bot: ${error.stack || error.message || error}`, "error");
      // Continue running despite the error
      // This prevents the bot from crashing completely
    });

    process.on('unhandledRejection', (reason, promise) => {
      log(`CRITICAL: Unhandled promise rejection in Discord bot: ${reason}`, "error");
      // Continue running despite the error
    });

    this.client.on('interactionCreate', async (interaction) => {
      try {
        if (interaction.isAutocomplete()) {
          const { commandName, options } = interaction;

          if (commandName === 'closeservice' || commandName === 'openservice') {
            try {
              // Get all categories
              const categories = await storage.getCategories();
              const focusedOption = options.getFocused(true);
              const focusedValue = focusedOption.value.toString().toLowerCase();
              
              // Filter categories based on command
              let filteredCategories;
              if (commandName === 'closeservice') {
                // For closeservice, only show open categories
                filteredCategories = categories.filter(c => !c.isClosed);
              } else {
                // For openservice, only show closed categories
                filteredCategories = categories.filter(c => c.isClosed);
              }
              
              // Further filter by search term if provided
              if (focusedValue) {
                filteredCategories = filteredCategories.filter(c => 
                  c.name.toLowerCase().includes(focusedValue) || 
                  c.id.toString().includes(focusedValue)
                );
              }
              
              // Format results
              const choices = filteredCategories.map(c => {
                const prefix = c.isClosed ? "🔴 " : "";
                return {
                  name: `${prefix}${c.name} (ID: ${c.id})`,
                  value: c.id.toString()
                };
              });
              
              // Return at most 25 choices (Discord's limit)
              await interaction.respond(choices.slice(0, 25));
            } catch (error) {
              log(`Error handling autocomplete for ${commandName}: ${error}`, "error");
              // Return empty array on error
              await interaction.respond([]);
            }
          }
          return;
        }
        
        // Handle button interactions
        if (interaction.isButton()) {
          try {
          // Extract data from the button custom ID
          // Format: force_ticket:telegramId:ticketId:username
          if (interaction.customId.startsWith('force_ticket:')) {
            const params = interaction.customId.split(':');
            if (params.length >= 3) {
              const telegramId = params[1];
              const ticketId = parseInt(params[2]);
              const username = params.length > 3 ? params[3] : 'User';
              
              if (!telegramId || !ticketId) {
                await interaction.reply('❌ Invalid button data. Missing required information.');
                return;
              }
              
              await interaction.deferReply();
              
              log(`Force switch requested for telegramId ${telegramId} to ticket ${ticketId}`);
              
              try {
                // Call bridge to handle the force switch
                const result = await this.bridge.forceUserTicketSwitch(telegramId, ticketId);
                
                // Check if user was already in this ticket
                if (result.alreadyInTicket) {
                  // User was already in this ticket, just let the staff member know
                  await interaction.editReply(`ℹ️ The user is already in this ticket.`);
                  return;
                }
                
                // Only send a reply to the user who clicked the button
                await interaction.editReply(`✅ Action completed successfully`);
                
                // Send a single comprehensive message to the channel
                if (interaction.channel) {
                  try {
                    const channel = interaction.channel as TextChannel;
                    await channel.send({
                      content: `**System Message:** ${interaction.user.username} has forced the user back to this ticket.`,
                      // Make it stand out
                      embeds: [{
                        color: 0x00ff00, // Green color
                        description: "The user has been notified of this change."
                      }]
                    });
                  } catch (error) {
                    log(`Error sending channel message: ${error}`, "error");
                  }
                }
              } catch (error) {
                log(`Error forcing ticket switch: ${error}`, "error");
                await interaction.editReply(`❌ Failed to force ticket switch: ${error}`);
              }
            } else {
              await interaction.reply('❌ Invalid button format.');
            }
            return;
          }
        } catch (error) {
          log(`Error handling button interaction: ${error}`, "error");
          try {
            // Try to respond to the interaction if we haven't already
            if (!interaction.replied && !interaction.deferred) {
              await interaction.reply('An error occurred while processing this button.');
            } else if (!interaction.replied) {
              await interaction.editReply('An error occurred while processing this button.');
            }
          } catch (replyError) {
            log(`Error responding to button interaction: ${replyError}`, "error");
          }
        }
        return;
      }

      // Handle slash commands
      if (interaction.isChatInputCommand()) {
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

        // Check if user is an admin
        const guild = interaction.guild;
        if (!guild) {
          await interaction.reply({
            content: "This command can only be used in a server!",
            ephemeral: true
          });
          return;
        }
        
        const isAdmin = await this.isUserAdmin(interaction.user.id, guild);
        if (!isAdmin) {
          await interaction.reply({
            content: "This command can only be used by administrators!",
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
              { name: 'Full Name', value: user.telegramName || 'Not Available', inline: true },
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
        // Reply immediately to avoid timeout errors
        await interaction.reply({
          content: "🔄 Sending ping to the user...",
          ephemeral: true
        });
        
        try {
          const ticket = await storage.getTicketByDiscordChannel(interaction.channelId);

          if (!ticket) {
            await interaction.editReply({
              content: "❌ This command can only be used in ticket channels!"
            });
            return;
          }

          // Get ticket creator's info
          const user = await storage.getUser(ticket.userId!);
          if (!user || !user.telegramId) {
            await interaction.editReply({
              content: "❌ Could not find Telegram information for this ticket's creator."
            });
            return;
          }

          // Send notification to Telegram user with improved format
          // Using forwardPingToTelegram for consistent format
          await this.bridge.forwardPingToTelegram(ticket.id, interaction.user.username);
          
          // Update the response
          await interaction.editReply({
            content: "✅ The user has been notified and will respond when available."
          });
          
          // Also send a system message to the channel so other staff can see
          await this.bridge.sendSystemMessageToDiscord(
            interaction.channelId,
            `**System:** ${interaction.user.username} has pinged the user for a response.`
          );
          
          log(`Successfully sent ping to Telegram user ${user.telegramId}`);
        } catch (error) {
          log(`Error sending ping: ${error}`, "error");
          
          // Make sure we update the reply
          try {
            await interaction.editReply({
              content: `❌ Failed to send ping: ${error}`
            });
          } catch (replyError) {
            log(`Failed to update ping error response: ${replyError}`, "error");
          }
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
            .setDescription(`Ticket marked as paid by ${interaction.user.username} on Discord`)
            .addFields(
              { name: 'Amount', value: `$${amount}`, inline: true },
              { name: 'Status', value: 'Completed & Paid', inline: true }
            )
            .setTimestamp();

          await interaction.reply({ embeds: [embed] });
          
          // Notification to Telegram users about paid tickets has been removed as requested
          // This keeps statistics and Discord notifications working while eliminating user-facing notifications
        } catch (error) {
          log(`Error processing payment: ${error}`, "error");
          await interaction.reply({
            content: "Failed to process payment. Please try again.",
            ephemeral: true
          });
        }
      }

      if (interaction.commandName === 'reopen') {
        // First, immediately defer the reply to prevent "Unknown Interaction" errors
        // This gives us 15 minutes to complete the operation instead of just 3 seconds
        await interaction.deferReply({ ephemeral: false });
        
        const ticket = await storage.getTicketByDiscordChannel(interaction.channelId);

        if (!ticket) {
          await interaction.editReply({
            content: "This command can only be used in ticket channels!"
          });
          return;
        }

        try {
          // Get category for original category ID with null safety
          if (!ticket.categoryId) {
            await interaction.editReply({
              content: "This ticket doesn't have a valid category. Please contact an administrator."
            });
            return;
          }
          
          const category = await storage.getCategory(ticket.categoryId);
          if (!category?.discordCategoryId) {
            await interaction.editReply({
              content: "No Discord category set for this service. Please set it in the dashboard."
            });
            return;
          }

          // Get ticket creator's info for notification
          const user = await storage.getUser(ticket.userId!);
          if (user?.telegramId) {
            // Get staff member's display name with type safety
            let staffName = "Discord Staff";
            if (interaction.member && 'displayName' in interaction.member) {
              staffName = interaction.member.displayName;
            } else if (interaction.user && 'username' in interaction.user) {
              staffName = interaction.user.username;
            }

            // Send notification
            // Send notification with improved formatting and context awareness
            try {
              // Get user state from Telegram bot to check currently active ticket
              const telegramBot = this.bridge.getTelegramBot();
              const userState = telegramBot.getUserState(parseInt(user.telegramId));
              
              // Get the category for better context
              const ticketCategory = await storage.getCategory(ticket.categoryId || 0);
              const categoryName = ticketCategory ? ticketCategory.name : "Unknown category";
              
              // If user is viewing a different ticket, include that context in the message
              if (userState && userState.activeTicketId && userState.activeTicketId !== ticket.id) {
                // Get the category of the active ticket for better user context
                const activeTicket = await storage.getTicket(userState.activeTicketId);
                let activeTicketInfo = `#${userState.activeTicketId}`;
                
                if (activeTicket && activeTicket.categoryId) {
                  const activeCategory = await storage.getCategory(activeTicket.categoryId);
                  if (activeCategory) {
                    activeTicketInfo = `${activeCategory.name} (#${userState.activeTicketId})`;
                  }
                }
                
                // Context-aware reopening notification
                await telegramBot.sendMessage(
                  parseInt(user.telegramId),
                  `━━━━━━━━━━━━━━━━━━━━━━\n📝 *Ticket Reopened*\n\nYour *${categoryName}* ticket (#${ticket.id}) has been reopened by ${staffName}.\n\nYou are currently viewing ${activeTicketInfo}. Use /switch to return to your reopened ticket.\n━━━━━━━━━━━━━━━━━━━━━━`
                );
              } else {
                // Standard message if they're viewing the reopened ticket or no active ticket
                await telegramBot.sendMessage(
                  parseInt(user.telegramId),
                  `━━━━━━━━━━━━━━━━━━━━━━\n📝 *Ticket Reopened*\n\nYour *${categoryName}* ticket (#${ticket.id}) has been reopened by ${staffName}.\n\nYou can continue your conversation in this ticket.\n━━━━━━━━━━━━━━━━━━━━━━`
                );
              }
            } catch (stateError) {
              // If error getting state, fall back to standard message
              log(`Error checking user state for context-aware notification: ${stateError}`, "warn");
              await this.bridge.getTelegramBot().sendMessage(
                parseInt(user.telegramId),
                `📝 Ticket Update\n\nYour ticket #${ticket.id} has been reopened by ${staffName}.`
              );
            }
          }

          // Move ticket back from transcripts to active category
          try {
            await this.bridge.moveFromTranscripts(ticket.id);
          } catch (error) {
            log(`Error moving ticket from transcripts: ${error}`, "error");
            throw error;
          }

          // Send confirmation embed
          const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🔄 Ticket Reopened')
            .setDescription(`Ticket reopened by ${interaction.user.username}`)
            .addFields(
              { name: 'Status', value: 'Open', inline: true },
              { name: 'Moved to', value: category.name, inline: true }
            )
            .setTimestamp();

          await interaction.editReply({ embeds: [embed] });
        } catch (error) {
          log(`Error reopening ticket: ${error}`, "error");
          await interaction.editReply({
            content: "Failed to reopen ticket. Please try again."
          });
        }
      }
        
      if (interaction.commandName === 'listservices') {
        // This command can be used by anyone to see available categories
        try {
          const categories = await storage.getCategories();
          
          if (categories.length === 0) {
            await interaction.reply({
              content: "No service categories found.",
              ephemeral: true
            });
            return;
          }

          // Create fields for each category - split into main categories and submenus
          const mainCategories = categories.filter(cat => !cat.isSubmenu);
          const subCategories = categories.filter(cat => cat.isSubmenu);
          
          // Create fields array for the embed
          const fields = [];
          
          // Add main categories
          for (const category of mainCategories) {
            // Only show red dot for closed services
            const prefix = category.isClosed ? "🔴 " : "";
            fields.push({
              name: `${prefix}${category.name} (ID: ${category.id})`,
              value: `Status: ${category.isClosed ? "Closed" : "Open"}`,
              inline: true
            });
          }
          
          // Add submenu categories if any
          if (subCategories.length > 0) {
            // Add separator
            fields.push({
              name: "──────── Submenus ────────",
              value: "\u200B", // Zero-width space
              inline: false
            });
            
            for (const category of subCategories) {
              // Only show red dot for closed services
              const prefix = category.isClosed ? "🔴 " : "";
              // Try to get parent name
              let parentName = "Unknown";
              if (category.parentId) {
                const parent = mainCategories.find(c => c.id === category.parentId);
                if (parent) {
                  parentName = parent.name;
                }
              }
              
              fields.push({
                name: `${prefix}${category.name} (ID: ${category.id})`,
                value: `Parent: ${parentName}\nStatus: ${category.isClosed ? "Closed" : "Open"}`,
                inline: true
              });
            }
          }
          
          // Create and send the embed
          const embed = new EmbedBuilder()
            .setColor(0x5865F2) // Discord Blurple color
            .setTitle('📋 Service Categories')
            .setDescription('Use `/closeservice` or `/openservice` to change service status')
            .addFields(fields)
            .setFooter({ text: 'Only staff with Manage Server permissions can change service status' })
            .setTimestamp();
          
          await interaction.reply({ embeds: [embed], ephemeral: true });
        } catch (error) {
          log(`Error listing service categories: ${error}`, "error");
          await interaction.reply({
            content: "Failed to list service categories. Please try again.",
            ephemeral: true
          });
        }
      }
      
      if (interaction.commandName === 'closeservice') {
        const categoryIdString = interaction.options.getString('category', true);
        const categoryId = parseInt(categoryIdString, 10);
        
        // Check if user is an admin or has manage server permissions
        const guild = interaction.guild;
        if (!guild) {
          await interaction.reply({
            content: "This command can only be used in a server!",
            ephemeral: true
          });
          return;
        }
        
        // Check user permissions
        const isAdmin = await this.isUserAdmin(interaction.user.id, guild);
        const member = await guild.members.fetch(interaction.user.id);
        const canManageServer = member.permissions.has(PermissionFlagsBits.ManageGuild);
        
        if (!isAdmin && !canManageServer) {
          await interaction.reply({
            content: "You don't have permission to use this command. You need to be an admin or have 'Manage Server' permission.",
            ephemeral: true
          });
          return;
        }
        
        try {
          // Get the category
          const category = await storage.getCategory(categoryId);
          if (!category) {
            await interaction.reply({
              content: `Category with ID ${categoryId} not found. Use a valid category ID from the dashboard.`,
              ephemeral: true
            });
            return;
          }
          
          // Check if already closed
          if (category.isClosed) {
            await interaction.reply({
              content: `Category '${category.name}' is already closed.`,
              ephemeral: true
            });
            return;
          }
          
          // Update the category
          const updatedCategory = await storage.updateCategory(categoryId, { isClosed: true });
          
          if (!updatedCategory) {
            throw new Error("Failed to update category state");
          }
          
          // Create confirmation embed
          const embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('🔴 Service Category Closed')
            .setDescription(`Service '${category.name}' has been closed`)
            .addFields(
              { name: 'Status', value: 'Closed', inline: true },
              { name: 'Closed by', value: interaction.user.username, inline: true },
              { name: 'Category ID', value: categoryId.toString(), inline: true }
            )
            .setFooter({ text: 'Users will not be able to create new tickets in this category' })
            .setTimestamp();
          
          await interaction.reply({ embeds: [embed] });
        } catch (error) {
          log(`Error closing service category: ${error}`, "error");
          await interaction.reply({
            content: "Failed to close service category. Please try again.",
            ephemeral: true
          });
        }
      }
      
      if (interaction.commandName === 'openservice') {
        const categoryIdString = interaction.options.getString('category', true);
        const categoryId = parseInt(categoryIdString, 10);
        
        // Check if user is an admin or has manage server permissions
        const guild = interaction.guild;
        if (!guild) {
          await interaction.reply({
            content: "This command can only be used in a server!",
            ephemeral: true
          });
          return;
        }
        
        // Check user permissions
        const isAdmin = await this.isUserAdmin(interaction.user.id, guild);
        const member = await guild.members.fetch(interaction.user.id);
        const canManageServer = member.permissions.has(PermissionFlagsBits.ManageGuild);
        
        if (!isAdmin && !canManageServer) {
          await interaction.reply({
            content: "You don't have permission to use this command. You need to be an admin or have 'Manage Server' permission.",
            ephemeral: true
          });
          return;
        }
        
        try {
          // Get the category
          const category = await storage.getCategory(categoryId);
          if (!category) {
            await interaction.reply({
              content: `Category with ID ${categoryId} not found. Use a valid category ID from the dashboard.`,
              ephemeral: true
            });
            return;
          }
          
          // Check if already open
          if (!category.isClosed) {
            await interaction.reply({
              content: `Category '${category.name}' is already open.`,
              ephemeral: true
            });
            return;
          }
          
          // Update the category
          const updatedCategory = await storage.updateCategory(categoryId, { isClosed: false });
          
          if (!updatedCategory) {
            throw new Error("Failed to update category state");
          }
          
          // Create confirmation embed
          const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('✅ Service Category Opened')
            .setDescription(`Service '${category.name}' has been opened`)
            .addFields(
              { name: 'Status', value: 'Open', inline: true },
              { name: 'Opened by', value: interaction.user.username, inline: true },
              { name: 'Category ID', value: categoryId.toString(), inline: true }
            )
            .setFooter({ text: 'Users can now create new tickets in this category' })
            .setTimestamp();
          
          await interaction.reply({ embeds: [embed] });
        } catch (error) {
          log(`Error opening service category: ${error}`, "error");
          await interaction.reply({
            content: "Failed to open service category. Please try again.",
            ephemeral: true
          });
        }
      }
      
      if (interaction.commandName === 'close') {
        // First, immediately defer the reply to prevent "Unknown Interaction" errors
        // This gives us 15 minutes to complete the operation instead of just 3 seconds
        await interaction.deferReply({ ephemeral: false });
        
        try {
          // Validate channel has a ticket
          const ticket = await storage.getTicketByDiscordChannel(interaction.channelId);
          if (!ticket) {
            await interaction.editReply({
              content: "This command can only be used in ticket channels!"
            });
            return;
          }

          // Get category for transcript category ID with null safety
          if (!ticket.categoryId) {
            await interaction.editReply({
              content: "This ticket doesn't have a valid category. Please contact an administrator."
            });
            return;
          }
          
          const category = await storage.getCategory(ticket.categoryId);
          if (!category?.transcriptCategoryId) {
            await interaction.editReply({
              content: "No transcript category set for this service. Please set it in the dashboard."
            });
            return;
          }

          // Create and send the confirmation embed first so user sees response quickly
          const processingEmbed = new EmbedBuilder()
            .setColor(0xFFAA00) // Amber color for processing
            .setTitle('🔄 Processing Ticket Close')
            .setDescription(`Ticket close requested by ${interaction.user.username}`)
            .addFields(
              { name: 'Status', value: 'Processing', inline: true }
            )
            .setTimestamp();

          await interaction.editReply({ embeds: [processingEmbed] });

          // Now perform the slower operations
          
          // Check if ticket is already closed to avoid duplicate notifications
          if (ticket.status === 'closed' || ticket.status === 'transcript' || ticket.status === 'deleted') {
            // Ticket is already closed, just inform the staff and continue with transcript move
            const alreadyClosedEmbed = new EmbedBuilder()
              .setColor(0xFFA500) // Orange color for warning
              .setTitle('ℹ️ Ticket Already Closed')
              .setDescription(`This ticket is already marked as ${ticket.status}. Moving to transcripts.`)
              .setTimestamp();
            
            await interaction.editReply({ embeds: [alreadyClosedEmbed] });
          } else {
            // Get staff member's display name for logs, but don't notify Telegram user
          let staffName = "Discord Staff";
          if (interaction.member && 'displayName' in interaction.member) {
            staffName = interaction.member.displayName;
          } else if (interaction.user && 'username' in interaction.user) {
            staffName = interaction.user.username;
          }
          
          // Log the ticket closure but don't send Telegram notification
          const ticketCategory = await storage.getCategory(ticket.categoryId || 0);
          const categoryName = ticketCategory ? ticketCategory.name : "Unknown service";
          log(`Ticket #${ticket.id} (${categoryName}) closed by ${staffName}. Telegram notification suppressed.`, "info");
          }

          // Move channel to transcripts category using the Bridge's moveToTranscripts method
          // This ensures consistent permission handling - it will update the ticket status too
          try {
            await this.bridge.moveToTranscripts(ticket.id);
          } catch (error) {
            log(`Error in bridge.moveToTranscripts: ${error}`, "error");
            // Continue and show error in embed rather than throwing
            const errorEmbed = new EmbedBuilder()
              .setColor(0xFF0000) // Red for error
              .setTitle('⚠️ Ticket Close Warning')
              .setDescription(`Ticket marked as closed but couldn't move channel to transcripts`)
              .addFields(
                { name: 'Status', value: 'Closed (Database)', inline: true },
                { name: 'Error', value: String(error).substring(0, 100), inline: true }
              )
              .setTimestamp();

            await interaction.editReply({ embeds: [errorEmbed] });
            return;
          }

          // Update confirmation embed to show success
          const successEmbed = new EmbedBuilder()
            .setColor(0x00FF00) // Green for success
            .setTitle('✅ Ticket Closed')
            .setDescription(`Ticket closed by ${interaction.user.username}`)
            .addFields(
              { name: 'Status', value: 'Closed', inline: true },
              { name: 'Moved to', value: 'Transcripts', inline: true }
            )
            .setTimestamp();

          await interaction.editReply({ embeds: [successEmbed] });
        } catch (error) {
          log(`Error closing ticket: ${error}`, "error");
          // Use editReply instead of reply since we already deferred
          await interaction.editReply({
            content: `Failed to close ticket: ${String(error).substring(0, 100)}. Please try again.`
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
        
        // Check if user is an admin
        const guild = interaction.guild;
        if (!guild) {
          await interaction.reply({
            content: "This command can only be used in a server!",
            ephemeral: true
          });
          return;
        }
        
        const isAdmin = await this.isUserAdmin(interaction.user.id, guild);
        if (!isAdmin) {
          await interaction.reply({
            content: "⛔ This command can only be used by administrators!",
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
        
        // Check if user is an admin
        const guild = interaction.guild;
        if (!guild) {
          await interaction.reply({
            content: "This command can only be used in a server!",
            ephemeral: true
          });
          return;
        }
        
        const isAdmin = await this.isUserAdmin(interaction.user.id, guild);
        if (!isAdmin) {
          await interaction.reply({
            content: "⛔ This command can only be used by administrators!",
            ephemeral: true
          });
          return;
        }

        try {
          // First, reply to let the user know we're processing
          await interaction.reply({
            content: `Processing channels in ${categoryChannel.name}...`,
            ephemeral: true
          });

          // Get all text channels in the category
          const channels = categoryChannel.children.cache.filter(
            channel => channel.type === ChannelType.GuildText
          );

          if (channels.size === 0) {
            await interaction.editReply({
              content: "No ticket channels found in this category."
            });
            return;
          }

          // Confirm with user
          await interaction.editReply({
            content: `Are you sure you want to delete all ${channels.size} tickets in ${categoryChannel.name}? This action cannot be undone.`
          });
          
          let processedCount = 0;
          let errorCount = 0;

          // Delete all channels and update tickets
          for (const [_, channel] of channels) {
            try {
              if (channel instanceof TextChannel) {
                const ticket = await storage.getTicketByDiscordChannel(channel.id);
                if (ticket) {
                  await storage.updateTicketStatus(ticket.id, "deleted");
                }
                await channel.delete();
                processedCount++;
                
                // Update progress every 5 channels
                if (processedCount % 5 === 0) {
                  await interaction.editReply({
                    content: `Progress: ${processedCount}/${channels.size} channels processed...`
                  });
                }
              }
            } catch (channelError) {
              errorCount++;
              log(`Error deleting channel ${channel.name}: ${channelError}`, "error");
            }
          }

          // Send final confirmation
          await interaction.editReply({
            content: `✅ Processed ${channels.size} tickets from ${categoryChannel.name}:\n` +
                     `• ${processedCount} tickets successfully deleted\n` +
                     `• ${errorCount} errors encountered`
          });
        } catch (error) {
          log(`Error in deleteall command: ${error}`, "error");
          
          // Make sure we have a reply
          try {
            await interaction.followUp({
              content: "An error occurred while deleting tickets. Some tickets may not have been deleted.",
              ephemeral: true
            });
          } catch (replyError) {
            // If followUp fails (e.g., if the original reply wasn't sent), try editReply
            try {
              await interaction.editReply({
                content: "An error occurred while deleting tickets. Some tickets may not have been deleted."
              });
            } catch (editError) {
              // If both fail, last resort is to try a new reply
              try {
                await interaction.reply({
                  content: "An error occurred while deleting tickets. Some tickets may not have been deleted.",
                  ephemeral: true
                });
              } catch (finalError) {
                log(`Failed to send error message to user: ${finalError}`, "error");
              }
            }
          }
        }
      }

      if (interaction.commandName === 'closeall') {
        log(`Handling /closeall command from user ${interaction.user.id}`, "info");
        
        // First, immediately defer the reply to prevent "Unknown Interaction" errors
        // This gives us 15 minutes to complete the operation instead of just 3 seconds
        await interaction.deferReply({ ephemeral: false });
        
        const categoryChannel = interaction.options.getChannel('category', true);
        log(`Selected category: ${categoryChannel.id}`, "debug");

        if (!(categoryChannel instanceof CategoryChannel)) {
          log(`Invalid category type: ${categoryChannel.type}`, "warn");
          await interaction.editReply({
            content: "Please select a valid category!"
          });
          return;
        }
        
        // Check if user is an admin
        const guild = interaction.guild;
        if (!guild) {
          await interaction.editReply({
            content: "This command can only be used in a server!"
          });
          return;
        }
        
        const isAdmin = await this.isUserAdmin(interaction.user.id, guild);
        if (!isAdmin) {
          await interaction.editReply({
            content: "⛔ This command can only be used by administrators!"
          });
          return;
        }

        try {
          // Get all text channels in the category
          const channels = categoryChannel.children.cache.filter(
            channel => channel.type === ChannelType.GuildText
          );
          log(`Found ${channels.size} text channels in category ${categoryChannel.name}`, "info");

          if (channels.size === 0) {
            await interaction.editReply({
              content: "No ticket channels found in this category."
            });
            return;
          }

          // First message after defer to let the user know we're processing
          await interaction.editReply({
            content: `Moving ${channels.size} tickets to their respective transcript categories...`
          });

          let moveCount = 0;
          let errorCount = 0;
          let processedCount = 0;

          // Get staff member's display name with type safety
          let staffName = "Discord Staff";
          if (interaction.member && 'displayName' in interaction.member) {
            staffName = interaction.member.displayName;
          } else if (interaction.user && 'username' in interaction.user) {
            staffName = interaction.user.username;
          }

          // Process all channels
          let errorMessages = [];
          
          for (const [channelId, channel] of channels) {
            if (channel instanceof TextChannel) {
              log(`Processing channel: ${channel.name} (${channelId})`, "debug");
              try {
                // Get ticket associated with this channel
                const ticket = await storage.getTicketByDiscordChannel(channelId);
                log(`Found ticket for channel: ${JSON.stringify(ticket)}`, "debug");
                
                if (!ticket) {
                  log(`No ticket found for channel ${channelId}`, "warn");
                  errorCount++;
                  errorMessages.push(`No ticket found for channel ${channel.name}`);
                  continue;
                }
                
                if (!ticket.categoryId) {
                  log(`Ticket ${ticket.id} has no category ID`, "warn");
                  errorCount++;
                  errorMessages.push(`Ticket #${ticket.id} (${channel.name}) has no category ID`);
                  continue;
                }
                
                // Get category information
                const category = await storage.getCategory(ticket.categoryId);
                log(`Category for ticket: ${JSON.stringify(category)}`, "debug");
                
                if (!category) {
                  log(`No category found for ticket ${ticket.id}`, "warn");
                  errorCount++;
                  errorMessages.push(`No category found for ticket #${ticket.id} (${channel.name})`);
                  continue;
                }
                
                if (!category.transcriptCategoryId) {
                  log(`No transcript category ID for category ${category.id}`, "warn");
                  errorCount++;
                  errorMessages.push(`No transcript category set for ${category.name}`);
                  continue;
                }
                
                // Update progress every channel
                processedCount++;
                if (processedCount % 3 === 0) {
                  await interaction.editReply({
                    content: `Progress: ${processedCount}/${channels.size} channels processed...`
                  });
                }
                
                try {
                  const transcriptCategory = await this.client.channels.fetch(category.transcriptCategoryId);
                  log(`Transcript category: ${transcriptCategory?.id || 'Not found'}`, "debug");
                  
                  if (!(transcriptCategory instanceof CategoryChannel)) {
                    log(`Invalid transcript category type for ${category.transcriptCategoryId}`, "warn");
                    errorCount++;
                    errorMessages.push(`Invalid transcript category for ${category.name}`);
                    continue;
                  }
                  
                  // Only notify Telegram user if ticket isn't already closed
                  if (ticket.status !== 'closed' && ticket.status !== 'transcript' && ticket.status !== 'deleted') {
                    const user = await storage.getUser(ticket.userId!);
                    if (user?.telegramId) {
                      try {
                        // Check if the user is currently viewing a different ticket
                        const telegramBot = this.bridge.getTelegramBot();
                        const userState = telegramBot.getUserState(parseInt(user.telegramId));
                        
                        // If user is viewing a different ticket, include that context in the message
                        if (userState && userState.activeTicketId && userState.activeTicketId !== ticket.id) {
                          // Get the category of the active ticket for better user context
                          const activeTicket = await storage.getTicket(userState.activeTicketId);
                          let activeTicketInfo = `#${userState.activeTicketId}`;
                          
                          if (activeTicket && activeTicket.categoryId) {
                            const activeCategory = await storage.getCategory(activeTicket.categoryId);
                            if (activeCategory) {
                              activeTicketInfo = `${activeCategory.name} (#${userState.activeTicketId})`;
                            }
                          }
                          
                          // Let the user know which ticket was closed vs which one they're viewing
                          await this.bridge.getTelegramBot().sendMessage(
                            parseInt(user.telegramId),
                            `📝 Ticket Update\n\nYour *other* ticket #${ticket.id} has been closed by ${staffName}.\n\nYou are currently in ${activeTicketInfo}, which is still active.`
                          );
                        } else {
                          // Standard message if they're viewing the ticket that was closed or no active ticket
                          await this.bridge.getTelegramBot().sendMessage(
                            parseInt(user.telegramId),
                            `📝 Ticket Update\n\nYour ticket #${ticket.id} has been closed by ${staffName}.`
                          );
                        }
                      } catch (notifyError) {
                        log(`Error notifying Telegram user for ticket ${ticket.id}: ${notifyError}`, "warn");
                        // Fall back to standard message on error
                        try {
                          await this.bridge.getTelegramBot().sendMessage(
                            parseInt(user.telegramId),
                            `📝 Ticket Update\n\nYour ticket #${ticket.id} has been closed by ${staffName}.`
                          );
                        } catch (fallbackError) {
                          log(`Failed to send fallback notification: ${fallbackError}`, "error");
                        }
                      }
                    }
                  } else {
                    log(`Ticket ${ticket.id} already has status ${ticket.status}, skipping notification`, "info");
                  }

                  // Use the bridge.moveToTranscripts method to ensure consistent permission handling
                  log(`Moving ticket ${ticket.id} to transcripts`, "info");
                  await this.bridge.moveToTranscripts(ticket.id);
                  moveCount++;
                  log(`Successfully moved ticket ${ticket.id} to transcripts`, "info");
                } catch (moveError) {
                  log(`Error in transcript processing: ${moveError}`, "error");
                  errorCount++;
                  errorMessages.push(`Error moving ${channel.name}: ${moveError instanceof Error ? moveError.message : 'Unknown error'}`);
                }
              } catch (error) {
                log(`Error processing channel ${channel.name}: ${error}`, "error");
                errorCount++;
                errorMessages.push(`Error with channel ${channel.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
              }
            }
          }

          // Send final status
          const errorDetails = errorMessages.length > 0 
            ? `\n\nErrors encountered:\n${errorMessages.slice(0, 5).map(msg => `• ${msg}`).join('\n')}${errorMessages.length > 5 ? `\n... and ${errorMessages.length - 5} more errors` : ''}`
            : '';
            
          await interaction.editReply({
            content: `✅ Processed ${channels.size} tickets:\n` +
              `• ${moveCount} tickets moved to transcripts\n` +
              `• ${errorCount} errors encountered${errorDetails}`
          });
        } catch (error) {
          log(`Major error in closeall command: ${error}`, "error");
          
          // Make sure we have a reply
          try {
            if (interaction.replied) {
              await interaction.followUp({
                content: `An error occurred while closing tickets: ${error instanceof Error ? error.message : 'Unknown error'}. Some tickets may not have been processed.`,
                ephemeral: false
              });
            } else {
              await interaction.reply({
                content: `An error occurred while closing tickets: ${error instanceof Error ? error.message : 'Unknown error'}. Some tickets may not have been processed.`,
                ephemeral: false
              });
            }
          } catch (replyError) {
            log(`Failed to send error message to user: ${replyError}`, "error");
          }
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

        // Check if user is an admin
        const guild = interaction.guild;
        if (!guild) {
          await interaction.reply({
            content: "This command can only be used in a server!",
            ephemeral: true
          });
          return;
        }
        
        const isAdmin = await this.isUserAdmin(interaction.user.id, guild);
        if (!isAdmin) {
          await interaction.reply({
            content: "This command can only be used by administrators!",
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
      
      // Ban command handler
      if (interaction.commandName === 'ban') {
        const guild = interaction.guild;
        if (!guild) {
          await interaction.reply({
            content: "This command can only be used in a server!",
            ephemeral: true
          });
          return;
        }
        
        // No admin check needed - all staff can use this command
        
        try {
          // Get params from the command options
          const telegramId = interaction.options.getString('telegramid');
          let ticketId = interaction.options.getInteger('ticketid');
          const reason = interaction.options.getString('reason') || "No reason provided";
          
          // Try to find the current ticket if no parameters are provided
          if (!telegramId && !ticketId) {
            // Get the current channel ID
            const channelId = interaction.channelId;
            
            // Look up if this is a ticket channel
            const currentTicket = await storage.getTicketByDiscordChannel(channelId);
            
            // If this is a ticket channel, use that ticket's ID
            if (currentTicket) {
              ticketId = currentTicket.id;
            } else {
              // If not in a ticket channel and no parameters provided, show error
              await interaction.reply({
                content: "You must provide either a Telegram ID or a Ticket ID, or use this command in a ticket channel",
                ephemeral: true
              });
              return;
            }
          }
          
          let user;
          let userTelegramId;
          
          // Find the user based on provided information
          if (ticketId) {
            // Find the ticket
            const ticket = await storage.getTicket(ticketId);
            if (!ticket) {
              await interaction.reply({
                content: `No ticket found with ID ${ticketId}`,
                ephemeral: true
              });
              return;
            }
            
            // Find the user associated with the ticket
            user = await storage.getUser(ticket.userId!);
            if (!user || !user.telegramId) {
              await interaction.reply({
                content: `Unable to find Telegram user for ticket ID ${ticketId}`,
                ephemeral: true
              });
              return;
            }
            userTelegramId = user.telegramId;
          } else {
            // Find user by Telegram ID
            user = await storage.getUserByTelegramId(telegramId!);
            if (!user) {
              await interaction.reply({
                content: `No user found with Telegram ID ${telegramId}`,
                ephemeral: true
              });
              return;
            }
            userTelegramId = telegramId!;
          }
          
          // Ban the user with the provided reason
          await storage.banUser(user.id, reason, interaction.user.username);
          
          // Create a nice embed for the ban confirmation - without showing the username
          const embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('🚫 User Banned')
            .addFields(
              { name: 'Telegram ID', value: userTelegramId, inline: true },
              { name: 'Banned by', value: interaction.user.username, inline: true },
              { name: 'Reason', value: reason, inline: false }
            )
            .setDescription('This user has been banned from creating new tickets.')
            .setTimestamp();
          
          // Add ticket ID information if banned through ticket
          if (ticketId) {
            embed.addFields({ name: 'Banned from Ticket', value: `#${ticketId}`, inline: true });
          }
          
          // Send confirmation
          await interaction.reply({ 
            embeds: [embed]
          });
          
          // Try to notify the user on Telegram
          try {
            await this.bridge.getTelegramBot().sendMessage(
              parseInt(userTelegramId),
              `⚠️ *Account Restricted*\n\nYour account has been banned from creating new tickets in our system.\n\n*Reason:* ${reason}\n\nIf you believe this is an error, please contact the administrators.`
            );
          } catch (notifyError) {
            log(`Error notifying banned user: ${notifyError}`, "warn");
          }
          
        } catch (error) {
          log(`Error banning user: ${error}`, "error");
          await interaction.reply({
            content: "Failed to ban user. Please try again.",
            ephemeral: true
          });
        }
      }
      
      // Unban command handler
      if (interaction.commandName === 'unban') {
        const guild = interaction.guild;
        if (!guild) {
          await interaction.reply({
            content: "This command can only be used in a server!",
            ephemeral: true
          });
          return;
        }
        
        // No admin check needed - all staff can use this command
        
        try {
          // Get params from the command options
          const telegramId = interaction.options.getString('telegramid');
          let ticketId = interaction.options.getInteger('ticketid');
          
          // Try to find the current ticket if no parameters are provided
          if (!telegramId && !ticketId) {
            // Get the current channel ID
            const channelId = interaction.channelId;
            
            // Look up if this is a ticket channel
            const currentTicket = await storage.getTicketByDiscordChannel(channelId);
            
            // If this is a ticket channel, use that ticket's ID
            if (currentTicket) {
              ticketId = currentTicket.id;
            } else {
              // If not in a ticket channel and no parameters provided, show error
              await interaction.reply({
                content: "You must provide either a Telegram ID or a Ticket ID, or use this command in a ticket channel",
                ephemeral: true
              });
              return;
            }
          }
          
          let user;
          let userTelegramId;
          
          // Find the user based on provided information
          if (ticketId) {
            // Find the ticket
            const ticket = await storage.getTicket(ticketId);
            if (!ticket) {
              await interaction.reply({
                content: `No ticket found with ID ${ticketId}`,
                ephemeral: true
              });
              return;
            }
            
            // Find the user associated with the ticket
            user = await storage.getUser(ticket.userId!);
            if (!user || !user.telegramId) {
              await interaction.reply({
                content: `Unable to find Telegram user for ticket ID ${ticketId}`,
                ephemeral: true
              });
              return;
            }
            userTelegramId = user.telegramId;
          } else {
            // Find user by Telegram ID
            user = await storage.getUserByTelegramId(telegramId!);
            if (!user) {
              await interaction.reply({
                content: `No user found with Telegram ID ${telegramId}`,
                ephemeral: true
              });
              return;
            }
            userTelegramId = telegramId!;
          }
          
          // Unban the user
          await storage.unbanUser(user.id);
          
          // Create a nice embed for the unban confirmation - without showing the username
          const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('✅ User Unbanned')
            .addFields(
              { name: 'Telegram ID', value: userTelegramId, inline: true },
              { name: 'Unbanned by', value: interaction.user.username, inline: true }
            )
            .setDescription('This user can now create tickets again.')
            .setTimestamp();
          
          // Add ticket ID information if unbanned through ticket
          if (ticketId) {
            embed.addFields({ name: 'Referenced Ticket', value: `#${ticketId}`, inline: true });
          }
          
          // Send confirmation
          await interaction.reply({ 
            embeds: [embed]
          });
          
          // Try to notify the user on Telegram
          try {
            await this.bridge.getTelegramBot().sendMessage(
              parseInt(userTelegramId),
              `✅ *Account Restored*\n\nYour account has been unbanned. You can now create new tickets in our system again.`
            );
          } catch (notifyError) {
            log(`Error notifying unbanned user: ${notifyError}`, "warn");
          }
          
        } catch (error) {
          log(`Error unbanning user: ${error}`, "error");
          await interaction.reply({
            content: "Failed to unban user. Please try again.",
            ephemeral: true
          });
        }
      }

      // Handle claim command
      if (interaction.commandName === 'claim') {
        // First, immediately defer the reply to prevent "Unknown Interaction" errors
        await interaction.deferReply({ ephemeral: false });
        
        try {
          // Validate channel has a ticket
          const ticket = await storage.getTicketByDiscordChannel(interaction.channelId);
          if (!ticket) {
            await interaction.editReply({
              content: "This command can only be used in ticket channels!"
            });
            return;
          }

          // Check if ticket is already claimed
          if (ticket.claimedBy) {
            // If it's already claimed by the current user
            if (ticket.claimedBy === interaction.user.id) {
              await interaction.editReply({
                content: "You have already claimed this ticket. Use `/unclaim` to release it."
              });
              return;
            }
            
            // If it's claimed by someone else
            await interaction.editReply({
              content: `This ticket is already claimed by <@${ticket.claimedBy}>. They need to use \`/unclaim\` first.`
            });
            return;
          }

          // Get the channel to modify permissions
          const channel = interaction.channel as TextChannel;
          if (!channel) {
            await interaction.editReply({
              content: "Failed to get channel information."
            });
            return;
          }

          // Get the guild (server)
          const guild = interaction.guild;
          if (!guild) {
            await interaction.editReply({
              content: "This command can only be used in a server!"
            });
            return;
          }
          
          // Update ticket in database as claimed
          await storage.updateTicketStatus(ticket.id, ticket.status, interaction.user.id);
          
          // Get the category for this ticket to find roles with access
          const category = await this.client.channels.fetch(channel.parentId as string) as CategoryChannel;
          if (!category) {
            await interaction.editReply({
              content: "Failed to get category information."
            });
            return;
          }
          
          // Find all roles that have ViewChannel permission in the category
          const staffRoles: string[] = [];
          category.permissionOverwrites.cache.forEach((permission, id) => {
            // Skip @everyone role
            if (id === guild.roles.everyone.id) return;
            
            // Check if this role has view permissions
            if (permission.allow.has(PermissionFlagsBits.ViewChannel)) {
              staffRoles.push(id);
            }
          });
          
          // Now update channel permissions
          // First, make sure the bot still has access
          const botMember = guild.members.me;
          if (botMember) {
            await channel.permissionOverwrites.edit(botMember, {
              ViewChannel: true,
              SendMessages: true,
              ReadMessageHistory: true
            });
          }
          
          // Set permissions for the claiming user
          await channel.permissionOverwrites.edit(interaction.user.id, {
            ViewChannel: true,
            SendMessages: true, 
            ReadMessageHistory: true
          });
          
          // Remove permissions for all staff roles (but ensure admins still have access)
          for (const roleId of staffRoles) {
            // Get the role to check if it's an admin role
            const role = await guild.roles.fetch(roleId);
            if (!role) continue;
            
            // Skip admin roles 
            if (role.permissions.has(PermissionFlagsBits.Administrator)) {
              continue;
            }
            
            // Deny access for non-admin staff roles
            await channel.permissionOverwrites.edit(roleId, {
              ViewChannel: false
            });
          }
          
          // Notify the channel
          await interaction.editReply({
            content: `✅ This ticket has been claimed by ${interaction.user}. Only they can view and respond to this ticket now.`
          });
          
          // Also send a message to Telegram user
          const user = await storage.getUser(ticket.userId!);
          if (user && user.telegramId) {
            await this.bridge.sendMessageToTelegram(
              parseInt(user.telegramId),
              `📢 *Staff Update:* Your ticket is now being handled exclusively by a dedicated staff member.`
            );
          }
        } catch (error) {
          log(`Error handling claim command: ${error}`, "error");
          await interaction.editReply({
            content: `Error: Failed to claim the ticket. ${error}`
          });
        }
      }

      // Handle unclaim command
      if (interaction.commandName === 'unclaim') {
        // First, immediately defer the reply to prevent "Unknown Interaction" errors
        await interaction.deferReply({ ephemeral: false });
        
        try {
          // Validate channel has a ticket
          const ticket = await storage.getTicketByDiscordChannel(interaction.channelId);
          if (!ticket) {
            await interaction.editReply({
              content: "This command can only be used in ticket channels!"
            });
            return;
          }

          // Check if ticket is claimed
          if (!ticket.claimedBy) {
            await interaction.editReply({
              content: "This ticket is not currently claimed by anyone."
            });
            return;
          }
          
          // Check if the user is the one who claimed it or an admin
          const guild = interaction.guild;
          if (!guild) {
            await interaction.editReply({
              content: "This command can only be used in a server!"
            });
            return;
          }
          
          const isAdmin = await this.isUserAdmin(interaction.user.id, guild);
          if (ticket.claimedBy !== interaction.user.id && !isAdmin) {
            await interaction.editReply({
              content: `Only <@${ticket.claimedBy}> or an administrator can unclaim this ticket.`
            });
            return;
          }
          
          // Get the channel to reset permissions
          const channel = interaction.channel as TextChannel;
          if (!channel) {
            await interaction.editReply({
              content: "Failed to get channel information."
            });
            return;
          }
          
          // Update ticket in database as unclaimed
          await storage.updateTicketStatus(ticket.id, ticket.status, undefined);
          
          // Get the category for this ticket
          const category = await this.client.channels.fetch(channel.parentId as string) as CategoryChannel;
          if (!category) {
            await interaction.editReply({
              content: "Failed to get category information."
            });
            return;
          }
          
          // Restore permissions for staff roles
          category.permissionOverwrites.cache.forEach(async (permission, id) => {
            // Skip @everyone role
            if (id === guild.roles.everyone.id) return;
            
            // Check if this is a role that should have access
            if (permission.allow.has(PermissionFlagsBits.ViewChannel)) {
              // Restore access for this role
              await channel.permissionOverwrites.edit(id, {
                ViewChannel: true,
                SendMessages: permission.allow.has(PermissionFlagsBits.SendMessages),
                ReadMessageHistory: permission.allow.has(PermissionFlagsBits.ReadMessageHistory)
              });
            }
          });
          
          // Remove the claiming user's specific permissions if they're not an admin
          if (!isAdmin) {
            await channel.permissionOverwrites.delete(interaction.user.id)
              .catch(() => log(`Failed to remove permission overwrite for ${interaction.user.id}`, "warn"));
          }
          
          // Get the staff role to ping
          let staffRoleId: string | null = null;
          const category_config = await storage.getCategory(ticket.categoryId!);
          if (category_config && category_config.discordRoleId) {
            staffRoleId = category_config.discordRoleId;
          }
          
          // Notify the channel with a ping to the staff role
          let notificationMessage = `✅ This ticket has been released by ${interaction.user} and is now available for any staff member to handle.`;
          if (staffRoleId) {
            notificationMessage = `<@&${staffRoleId}> ${notificationMessage}`;
          }
          
          await interaction.editReply({
            content: notificationMessage
          });
          
          // Also send a message to Telegram user
          const user = await storage.getUser(ticket.userId!);
          if (user && user.telegramId) {
            await this.bridge.sendMessageToTelegram(
              parseInt(user.telegramId),
              `📢 *Staff Update:* Your ticket is now open to all staff members again.`
            );
          }
        } catch (error) {
          log(`Error handling unclaim command: ${error}`, "error");
          await interaction.editReply({
            content: `Error: Failed to unclaim the ticket. ${error}`
          });
        }
      }
      } // End of if (interaction.isChatInputCommand())
      
    } catch (error) {
        // Global error handler for all interactions
        const errorMessage = `CRITICAL ERROR handling interaction: ${error}`;
        log(errorMessage, "error");
        
        // Try to give feedback to the user without crashing
        try {
          // We need to handle each interaction type differently
          if (interaction.isChatInputCommand()) {
            const cmdInteraction = interaction as ChatInputCommandInteraction;
            if (!cmdInteraction.replied && !cmdInteraction.deferred) {
              await cmdInteraction.reply({
                content: "An error occurred while processing your command. The error has been logged.",
                ephemeral: true
              });
            } else if (cmdInteraction.deferred && !cmdInteraction.replied) {
              await cmdInteraction.editReply({
                content: "An error occurred while processing your command. The error has been logged."
              });
            }
          } else if (interaction.isButton()) {
            const buttonInteraction = interaction as ButtonInteraction;
            if (!buttonInteraction.replied && !buttonInteraction.deferred) {
              await buttonInteraction.reply({
                content: "An error occurred while processing your button press. The error has been logged.",
                ephemeral: true
              });
            } else if (buttonInteraction.deferred && !buttonInteraction.replied) {
              await buttonInteraction.editReply({
                content: "An error occurred while processing your request. The error has been logged."
              });
            }
          } else if (interaction.isAutocomplete()) {
            // For autocomplete, just respond with empty results
            const autoCompleteInteraction = interaction as AutocompleteInteraction;
            try {
              await autoCompleteInteraction.respond([]);
            } catch (autocompleteError) {
              log(`Failed to respond to autocomplete after error: ${autocompleteError}`, "error");
            }
          }
          // Other interaction types may not need response
        } catch (replyError) {
          // If we can't reply, just log and continue
          log(`Failed to notify user of error: ${replyError}`, "error");
        }
      }
    });

    // Handle all text messages
    // Track recently processed messages to prevent duplicates
    const recentMessages = new Map<string, number>();
    const MESSAGE_EXPIRY = 30000; // 30 seconds (was 10)

    this.client.on("messageCreate", async (message) => {
      // Ignore bot messages to prevent loops
      if (message.author.bot) return;
      if (message.content.startsWith('.')) return;
      
      // The !forceswitch command has been removed - we now use the button on system messages instead

      // Deduplicate messages by checking against recently processed messages
      const messageKey = `${message.id}-${message.channelId}`;
      if (recentMessages.has(messageKey)) {
        log(`Skipping duplicate message ${message.id} in channel ${message.channelId}`);
        return;
      }
      
      // Mark this message as recently processed
      recentMessages.set(messageKey, Date.now());
      
      // Clean up old entries from the recentMessages map
      const now = Date.now();
      for (const [key, timestamp] of recentMessages.entries()) {
        if (now - timestamp > MESSAGE_EXPIRY) {
          recentMessages.delete(key);
        }
      }

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
          // Get Discord user's display name
          const senderName = message.member?.displayName || message.author.username || 'Discord User';
          
          await storage.createMessage({
            ticketId: ticket.id,
            content: message.content || "Sent an attachment",
            authorId: discordUser.id,
            platform: "discord",
            timestamp: new Date(),
            senderName: senderName
          });
          log(`Stored Discord message in database for ticket ${ticket.id}`);
        }

        // Get image attachments
        const imageAttachments = message.attachments.filter(attachment =>
          attachment.contentType?.startsWith('image/') ||
          /\.(jpg|jpeg|png|gif|webp)$/i.test(attachment.name || '')
        );

        // Forward content to Telegram with safer member handling
        let displayName = "Unknown Discord User";
        if (message.member && 'displayName' in message.member) {
          displayName = message.member.displayName;
        } else if (message.author && message.author.username) {
          displayName = message.author.username;
        }
        
        await this.bridge.forwardToTelegram(
          message.content,
          ticket.id,
          displayName,
          imageAttachments.size > 0 ? Array.from(imageAttachments.values()) : undefined
        );

        log(`Successfully forwarded message to Telegram for ticket ${ticket.id}`);
      } catch (error) {
        log(`Error handling Discord message: ${error}`, "error");
      }
    });

    // Handle message edits
    // Track recently edited messages to prevent duplicates
    const recentEditedMessages = new Map<string, number>();
    const EDIT_MESSAGE_EXPIRY = 30000; // 30 seconds (was 10)

    this.client.on("messageUpdate", async (oldMessage, newMessage) => {
      if (newMessage.author?.bot) return;
      if (!newMessage.content || newMessage.content.startsWith('.')) return;

      // Deduplicate edited messages
      const messageKey = `${newMessage.id}-${newMessage.channelId}-edit`;
      if (recentEditedMessages.has(messageKey)) {
        log(`Skipping duplicate edited message ${newMessage.id} in channel ${newMessage.channelId}`);
        return;
      }
      
      // Mark this edited message as recently processed
      recentEditedMessages.set(messageKey, Date.now());
      
      // Clean up old entries
      const now = Date.now();
      for (const [key, timestamp] of recentEditedMessages.entries()) {
        if (now - timestamp > EDIT_MESSAGE_EXPIRY) {
          recentEditedMessages.delete(key);
        }
      }

      const ticket = await storage.getTicketByDiscordChannel(newMessage.channelId);
      if (!ticket) return;

      log(`Processing edited Discord message for ticket ${ticket.id}`);

      // Get display name with proper type handling
      let displayName = "Unknown Discord User";
      if (newMessage.member && 'displayName' in newMessage.member) {
        displayName = newMessage.member.displayName;
      } else if (newMessage.author && newMessage.author.username) {
        displayName = newMessage.author.username;
      }
      
      await this.bridge.forwardToTelegram(
        `[EDITED] ${newMessage.content}`,
        ticket.id,
        displayName
      );
    });
  }

  public async sendTicketMessage(channelId: string, embed: any): Promise<void> {
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

      // Add diagnostic logging
      const tokenExists = process.env.DISCORD_BOT_TOKEN ? "exists" : "missing";
      const tokenLength = process.env.DISCORD_BOT_TOKEN ? process.env.DISCORD_BOT_TOKEN.length : 0;
      const clientHasToken = this.client.token ? "yes" : "no";
      log(`Discord token diagnostic - Env token: ${tokenExists} (${tokenLength} chars), Client token: ${clientHasToken}`, "debug");

      // Verify client is authenticated
      if (!this.client.token) {
        log("Discord client token not set, attempting to reconnect...", "error");
        // Check if token is available in environment
        const token = process.env.DISCORD_BOT_TOKEN;
        if (!token) {
          throw new Error("Discord bot token is missing. Please set DISCORD_BOT_TOKEN environment variable.");
        }
        
        log(`Attempting to login with token of length: ${token.length}`);
        
        // Attempt to log in again
        await this.client.login(token);
        
        // Verify login was successful
        if (!this.client.token) {
          throw new Error("Failed to authenticate Discord client with provided token");
        }
        log("Discord client successfully reconnected", "info");
      }

      await this.checkRateLimit('channelCreate');
      const category = await this.client.channels.fetch(categoryId);
      if (!category || category.type !== ChannelType.GuildCategory) {
        throw new Error(`Invalid category ${categoryId}`);
      }
      
      // Get guild and roleId from category permissions
      const guild = (category as CategoryChannel).guild;
      if (!guild) {
        throw new Error("Failed to get guild from category");
      }
      
      // Find the role with ViewChannel permission in the category
      const categoryPermissions = category.permissionOverwrites.cache;
      let roleWithAccess: string | null = null;
      
      for (const [id, permOverwrite] of categoryPermissions.entries()) {
        // Skip everyone role and bot permissions
        if (id === guild.roles.everyone.id || id === guild.members.me?.id) {
          continue;
        }
        
        // Check if this role has ViewChannel permission
        if (permOverwrite.allow.has(PermissionFlagsBits.ViewChannel)) {
          roleWithAccess = id;
          break;
        }
      }
      
      const channel = await guild.channels.create({
        name,
        parent: category,
        type: ChannelType.GuildText,
        permissionOverwrites: [
          // Default deny everyone
          {
            id: guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel]
          },
          // Bot permissions
          {
            id: guild.members.me?.id || "",
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.ManageChannels,
              PermissionFlagsBits.ManageMessages
            ]
          }
        ]
      });
      
      // Add the role permission if found
      if (roleWithAccess) {
        await channel.permissionOverwrites.edit(roleWithAccess, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
          AttachFiles: true
        });
        log(`Set channel permissions for role ${roleWithAccess}`);
      } else {
        log(`Warning: No role with access found in category ${categoryId}`, "warn");
      }

      log(`Successfully created channel ${channel.id}`);
      return channel.id;
    } catch (error) {
      log(`Error creating ticket channel: ${error}`, "error");
      throw error;
    }
  }

  async sendMessage(channelId: string, message: WebhookMessage, username: string): Promise<void> {
    try {
      log(`Attempting to send message to Discord channel ${channelId}`);

      // Verify client is authenticated
      if (!this.client.token) {
        log("Discord client token not set before sending message, attempting to reconnect...", "error");
        // Check if token is available in environment
        const token = process.env.DISCORD_BOT_TOKEN;
        if (!token) {
          throw new Error("Discord bot token is missing. Please set DISCORD_BOT_TOKEN environment variable.");
        }
        
        // Attempt to log in again
        await this.client.login(token);
        
        // Verify login was successful
        if (!this.client.token) {
          throw new Error("Failed to authenticate Discord client with provided token");
        }
        log("Discord client successfully reconnected", "info");
      }

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
        avatarURL: message.avatarURL, // This is case sensitive for Discord webhooks
        components: message.components // Add support for buttons and other components
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
        embeds: messageOptions.embeds ? `${messageOptions.embeds.length} embeds` : 'no embeds',
        components: messageOptions.components ? "has components" : "no components"
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

  async moveChannelToCategory(channelId: string, categoryId: string, isTranscriptCategory: boolean = false): Promise<void> {
    try {
      log(`Moving channel ${channelId} to category ${categoryId} (transcript category: ${isTranscriptCategory})`);

      // Verify client is authenticated
      if (!this.client.token) {
        log("Discord client token not set before moving channel, attempting to reconnect...", "error");
        // Check if token is available in environment
        const token = process.env.DISCORD_BOT_TOKEN;
        if (!token) {
          throw new Error("Discord bot token is missing. Please set DISCORD_BOT_TOKEN environment variable.");
        }
        
        // Attempt to log in again
        await this.client.login(token);
        
        // Verify login was successful
        if (!this.client.token) {
          throw new Error("Failed to authenticate Discord client with provided token");
        }
        log("Discord client successfully reconnected", "info");
      }

      await this.checkRateLimit('channelEdit'); //Added rate limit check

      const channel = await this.client.channels.fetch(channelId);
      if (!(channel instanceof TextChannel)) {
        throw new Error(`Invalid channel type for channel ${channelId}`);
      }

      // Save the original category permissions BEFORE moving
      let originalCategoryRoles: string[] = [];
      if (channel.parent && isTranscriptCategory) {
        // If we're moving to a transcript category, get roles from the original category
        const originalCategory = channel.parent;
        log(`Getting permissions from original category ${originalCategory.id} before moving`);
        
        for (const [id, permOverwrite] of originalCategory.permissionOverwrites.cache.entries()) {
          // Skip everyone role and bot
          if (id === originalCategory.guild.roles.everyone.id || id === originalCategory.guild.members.me?.id) {
            continue;
          }
          
          // Check if this role has ViewChannel permission
          if (permOverwrite.allow.has(PermissionFlagsBits.ViewChannel)) {
            originalCategoryRoles.push(id);
            log(`Found role ${id} with access in original category`);
          }
        }
      }

      const category = await this.client.channels.fetch(categoryId);
      if (!(category instanceof CategoryChannel)) {
        throw new Error(`Invalid category ${categoryId}`);
      }
      
      // Get guild from category
      const guild = category.guild;
      if (!guild) {
        throw new Error("Failed to get guild from category");
      }
      
      // Find the roles with ViewChannel permission in the target category
      const categoryPermissions = category.permissionOverwrites.cache;
      const rolesWithAccess: string[] = [];
      
      for (const [id, permOverwrite] of categoryPermissions.entries()) {
        // Skip everyone role and bot permissions
        if (id === guild.roles.everyone.id || id === guild.members.me?.id) {
          continue;
        }
        
        // Check if this role has ViewChannel permission
        if (permOverwrite.allow.has(PermissionFlagsBits.ViewChannel)) {
          rolesWithAccess.push(id);
        }
      }
      
      // Combine roles from both categories if moving to transcript
      if (isTranscriptCategory && originalCategoryRoles.length > 0) {
        for (const roleId of originalCategoryRoles) {
          if (!rolesWithAccess.includes(roleId)) {
            rolesWithAccess.push(roleId);
            log(`Added role ${roleId} from original category to roles with access`);
          }
        }
      }
      
      // Move the channel to the new category
      await channel.setParent(category.id);
      
      // Update permissions for the moved channel
      // First, explicitly deny access for @everyone to ensure the channel is private
      await channel.permissionOverwrites.edit(guild.roles.everyone.id, {
        ViewChannel: false,
        SendMessages: false,
        ReadMessageHistory: false
      });
      
      // Log the permission update for clarity
      log(`Updated permissions for @everyone role - denied access`, "info");
      
      // Set permissions for the roles found
      if (rolesWithAccess.length > 0) {
        for (const roleId of rolesWithAccess) {
          if (isTranscriptCategory) {
            // For transcript categories, staff should be able to view AND send messages
            // This fixes the issue where users with roles can't see or type in closed tickets
            await channel.permissionOverwrites.edit(roleId, {
              ViewChannel: true,
              SendMessages: true,  // Enable sending messages in transcript categories
              ReadMessageHistory: true,
              AttachFiles: true    // Enable file attachments in transcript categories
            });
            log(`Updated transcript permissions for role ${roleId} - full access mode (view, send, attach)`);
          } else {
            // For regular categories, staff can view and send messages
            await channel.permissionOverwrites.edit(roleId, {
              ViewChannel: true,
              SendMessages: true,
              ReadMessageHistory: true,
              AttachFiles: true
            });
            log(`Updated active category permissions for role ${roleId} - full access mode`);
          }
        }
      } else {
        log(`Warning: No roles with access found in category ${categoryId}`, "warn");
      }
      
      // Ensure bot has needed permissions
      if (guild.members.me) {
        await channel.permissionOverwrites.edit(guild.members.me.id, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
          AttachFiles: true,
          ManageChannels: true,
          ManageMessages: true
        });
      }
      
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
  
  /**
   * Get a Discord channel by its ID
   * @param channelId The Discord channel ID to fetch
   * @returns The TextChannel object or null if not found
   */
  async getChannelById(channelId: string): Promise<TextChannel | null> {
    try {
      if (!this.isReady()) {
        throw new Error("Discord bot is not ready");
      }
      
      await this.globalCheck();
      
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !(channel instanceof TextChannel)) {
        log(`Channel ${channelId} is not a text channel or not found`, "warn");
        return null;
      }
      
      return channel;
    } catch (error) {
      this.lastError = error instanceof Error ? error : new Error(String(error));
      log(`Error getting Discord channel ${channelId}: ${error}`, "error");
      return null;
    }
  }
  
  /**
   * Get all text channels from the Discord guild
   * @returns Array of channel objects with id and name
   */
  async getTextChannels(): Promise<Array<{id: string, name: string, type: string}>> {
    try {
      if (!this.isReady()) {
        log("Discord client not ready when fetching text channels", "warn");
        return [];
      }
      
      await this.globalCheck();
      
      const guild = this.client.guilds.cache.first();
      if (!guild) {
        log("No Discord guild available", "warn");
        return [];
      }
      
      // Fetch all channels in the guild
      await guild.channels.fetch();
      
      // Filter to only get text channels
      const textChannels = guild.channels.cache
        .filter(channel => 
          channel.type === ChannelType.GuildText || 
          channel.type === ChannelType.GuildAnnouncement
        )
        .map(channel => ({
          id: channel.id,
          name: channel.name,
          type: channel.type === ChannelType.GuildText ? 'text' : 'announcement'
        }));
      
      return textChannels;
    } catch (error) {
      this.lastError = error instanceof Error ? error : new Error(String(error));
      log(`Error getting Discord text channels: ${error}`, "error");
      return [];
    }
  }
  
  /**
   * Set up permissions for a category with a specific role
   * @param categoryId Discord category ID
   * @param roleId Discord role ID
   * @param isTranscriptCategory Whether this is a transcript category (read-only)
   * @returns {Promise<boolean>} Success status
   */
  async setupCategoryPermissions(categoryId: string, roleId: string, isTranscriptCategory: boolean = false): Promise<boolean> {
    try {
      if (!this.isReady()) {
        throw new Error("Discord bot is not ready");
      }
      
      await this.globalCheck();
      
      // Get guild
      const guilds = await this.client.guilds.fetch();
      const guild = await guilds.first()?.fetch();
      if (!guild) {
        throw new Error("No guild found");
      }
      
      // Get category and role
      const category = await guild.channels.fetch(categoryId);
      if (!category || category.type !== ChannelType.GuildCategory) {
        throw new Error(`Category with ID ${categoryId} not found or is not a category`);
      }
      
      const role = await guild.roles.fetch(roleId);
      if (!role) {
        throw new Error(`Role with ID ${roleId} not found`);
      }
      
      log(`Setting up permissions for category ${category.name} with role ${role.name} (transcript: ${isTranscriptCategory})`, "info");
      
      // Set permissions on the category
      // Explicitly deny @everyone from viewing channels
      await category.permissionOverwrites.edit(guild.roles.everyone, {
        ViewChannel: false,
        SendMessages: false,
        ReadMessageHistory: false
      });
      
      // Allow staff with appropriate roles to view and interact with all channels in the category,
      // regardless of whether it's a regular category or transcript category
      if (isTranscriptCategory) {
        // For transcript categories, staff should be able to view AND send messages
        // This fixes the issue where users with roles can't type in closed tickets
        await category.permissionOverwrites.edit(role, {
          ViewChannel: true,
          SendMessages: true,  // Changed from false to true
          ReadMessageHistory: true,
          AttachFiles: true,   // Changed from false to true
        });
        log(`Set up transcript category permissions for role ${role.name} - full access (changed from read-only)`, "info");
      } else {
        // For regular categories, staff can view and send messages
        await category.permissionOverwrites.edit(role, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
          AttachFiles: true,
        });
        log(`Set up regular category permissions for role ${role.name} - full access`, "info");
      }
      
      // Also set permissions for the bot
      const botMember = guild.members.me;
      if (botMember) {
        await category.permissionOverwrites.edit(botMember, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
          AttachFiles: true,
          ManageChannels: true,
          ManageMessages: true,
        });
      }
      
      log(`Successfully set up permissions for category ${category.name}`, "info");
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error : new Error(String(error));
      log(`Error setting up category permissions: ${error}`, "error");
      return false;
    }
  }

  // Create a new Discord client with necessary intents
  private setupClient(): Client {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
      ],
      rest: {
        // Add custom retry options for REST API calls
        retries: 5, // Maximum number of retries
        timeout: 15000 // 15 seconds timeout for requests
      }
    });
    
    // Add reconnection handling
    client.on('disconnect', (event) => {
      log(`Discord client disconnected with code ${event.code}. Reason: ${event.reason}`, "warn");
      log("Will attempt to reconnect automatically...", "info");
    });
    
    client.on('error', (error) => {
      log(`Discord client error: ${error.message}`, "error");
      
      // Check for token-related errors
      if (error.message.includes("token") || error.message.includes("authentication") || error.message.includes("login")) {
        log("Discord token may be invalid - will attempt to refresh token on next operation", "warn");
      }
    });
    
    client.on('reconnecting', () => {
      log("Discord client reconnecting...", "info");
    });
    
    // Check token is healthy every 5 minutes
    setInterval(() => {
      try {
        if (client.isReady() && !client.token) {
          log("Discord client has no token despite being ready - attempting to reconnect...", "warn");
          this.reconnect().catch(e => {
            log(`Failed to reconnect Discord bot: ${e}`, "error");
          });
        }
      } catch (error) {
        log(`Error in token health check: ${error}`, "error");
      }
    }, 5 * 60 * 1000);
    
    return client;
  }

  async start() {
    try {
      // Clear any existing timeouts and reset last error
      if (this.connectionTimeout) {
        clearTimeout(this.connectionTimeout);
      }
      this.lastError = null;
      this.isConnecting = true;
      this.isConnected = false;

      log("Starting Discord bot client...");

      // Import the token loader
      const { loadDiscordToken } = await import('./token-loader');
      
      // First try to load directly from the .env file (most reliable)
      let token = loadDiscordToken();
      
      // If file reading fails, fall back to environment variables
      if (!token) {
        log(`Could not load token from .env file, trying environment variables`, "warn");
        
        // Try environment variables as a fallback
        const envToken = process.env.DISCORD_BOT_TOKEN;
        
        // Log token status but not the actual token
        if (envToken) {
          // Remove any quotes or extra whitespace that might have been accidentally added
          token = envToken.trim().replace(/(^["']|["']$)/g, '');
          log(`Discord bot token from env: exists (length ${token.length})`);
        } else {
          // Try to read from alternative environment variables that might be used in deployment
          const altEnvVars = ['DISCORD_TOKEN', 'BOT_TOKEN', 'DISCORDTOKEN'];
          for (const varName of altEnvVars) {
            if (process.env[varName]) {
              token = process.env[varName].trim().replace(/(^["']|["']$)/g, '');
              log(`Found Discord token in alternative env var ${varName} (length ${token.length})`);
              break;
            }
          }
          
          if (!token) {
            log(`Discord bot token missing from all sources`, "error");
          }
        }
      }
      
      if (!token) {
        const errorMessage = "Discord bot token is missing. Please set DISCORD_BOT_TOKEN in your .env file.";
        log(errorMessage, "error");
        this.lastError = new Error(errorMessage);
        this.isConnecting = false;
        throw this.lastError;
      }

      if (token === "your_discord_bot_token_here" || token.includes("your_") || token.length < 50) {
        const errorMessage = "Discord bot token appears to be invalid or a placeholder. Please set a valid token.";
        log(errorMessage, "error");
        this.lastError = new Error(errorMessage);
        this.isConnecting = false;
        throw this.lastError;
      }

      // Verify token format basic validation (not foolproof but catches common issues)
      if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
        const errorMessage = "Discord bot token has invalid format. Tokens should be in the format 'XXXX.YYYY.ZZZZ'.";
        log(errorMessage, "error");
        this.lastError = new Error(errorMessage);
        this.isConnecting = false;
        throw this.lastError;
      }

      // Set connection timeout
      this.connectionTimeout = setTimeout(() => {
        log("Connection timeout reached, destroying client...", "warn");
        this.lastError = new Error("Connection timeout reached");
        this.isConnecting = false;
        this.isConnected = false;
        this.connectionError = "Connection timeout reached";
        this.client.destroy()
          .catch(error => log(`Error destroying client: ${error}`, "error"));
      }, this.wsCleanupConfig.connectionTimeout);

      log("Attempting to connect to Discord with token...");
      await this.client.login(token);

      // Clear timeout on successful connection
      if (this.connectionTimeout) {
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;
      }

      // Update connection status
      this.isConnecting = false;
      this.isConnected = true;
      this.connectionError = null;
      log("Discord bot started successfully");
    } catch (error) {
      let errorMessage = error instanceof Error ? error.message : String(error);
      
      // Provide more helpful error messages for common issues
      if (errorMessage.includes("Incorrect login details were provided")) {
        errorMessage = "Failed to authenticate with Discord: Invalid bot token provided. Check that your token is correct.";
      } else if (errorMessage.includes("getaddrinfo ENOTFOUND")) {
        errorMessage = "Failed to connect to Discord API: Network connection issue. Check your internet connection.";
      } else if (errorMessage.includes("connect ETIMEDOUT")) {
        errorMessage = "Connection to Discord API timed out. This may be due to network issues or API being down.";
      } else if (errorMessage.includes("disallowed intents specified")) {
        errorMessage = "Discord bot setup error: Your bot is missing required intents. Go to Discord Developer Portal, select your bot, and enable the necessary intents under the 'Bot' section.";
      }
      
      this.lastError = new Error(errorMessage);
      this.isConnecting = false;
      this.isConnected = false;
      this.connectionError = errorMessage;
      log(`Error starting Discord bot: ${errorMessage}`, "error");
      throw this.lastError;
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

      // Cleanup all webhooks by just clearing the map
      // WebhookClient doesn't have deleteIfExists method, and we can't directly delete
      // the webhooks from Discord since we only have WebhookClient instances
      this.webhooks.clear();
      log("Cleared webhook cache");

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
    return this.client && this.client.isReady();
  }
  
  // Check if bot is in the process of starting/connecting
  isStartingProcess() {
    return this.isConnecting;
  }
  
  // Get the last error that occurred
  getLastError(): string | undefined {
    return this.lastError?.message;
  }
  
  // Reconnect the bot with retry logic
  async reconnect() {
    try {
      console.log("Starting Discord bot reconnection...");
      this.isConnecting = true;
      
      try {
        // Try to destroy current client if it exists
        if (this.client) {
          await this.client.destroy();
          console.log("Successfully destroyed previous Discord client");
        }
      } catch (destroyError) {
        // Just log but continue with reconnection
        console.error("Error while destroying previous Discord client:", destroyError);
      }

      // Setup new client with retry logic
      const maxLoginAttempts = 3;
      let loginAttempt = 0;
      let lastLoginError = null;
      
      while (loginAttempt < maxLoginAttempts) {
        try {
          console.log(`Discord login attempt ${loginAttempt + 1}/${maxLoginAttempts}`);
          this.client = this.setupClient();
          
          // Import the token loader for reconnection
          const { loadDiscordToken } = await import('./token-loader');
      
          // First try to load directly from the .env file (most reliable)
          let token = loadDiscordToken();
          
          // If file reading fails, fall back to environment variables
          if (!token) {
            console.log(`Could not load token from .env file during reconnect, trying environment variables`, "warn");
            
            // Try environment variables as a fallback
            const envToken = process.env.DISCORD_BOT_TOKEN;
            
            // Log token status but not the actual token
            if (envToken) {
              // Remove any quotes or extra whitespace that might have been accidentally added
              token = envToken.trim().replace(/(^["']|["']$)/g, '');
              console.log(`Discord bot token from env: exists (length ${token.length})`);
            } else {
              // Try to read from alternative environment variables that might be used in deployment
              const altEnvVars = ['DISCORD_TOKEN', 'BOT_TOKEN', 'DISCORDTOKEN'];
              for (const varName of altEnvVars) {
                if (process.env[varName]) {
                  token = process.env[varName].trim().replace(/(^["']|["']$)/g, '');
                  console.log(`Found Discord token in alternative env var ${varName} (length ${token.length})`);
                  break;
                }
              }
              
              if (!token) {
                console.log(`Discord bot token missing from all sources during reconnect`, "error");
              }
            }
          }
          
          // Basic validation of token
          if (!token || token.length < 20) {
            throw new Error("Discord token appears to be invalid or missing");
          }
          
          // Try to login
          await this.client.login(token);
          
          // If we get here, login succeeded
          this.isConnecting = false;
          this.isConnected = true;
          this.connectionError = null;
          this.lastError = null;
          
          console.log("Discord bot reconnected successfully");
          return;
        } catch (loginError) {
          // Save the error and try again
          lastLoginError = loginError;
          loginAttempt++;
          
          if (loginAttempt < maxLoginAttempts) {
            // Wait with increasing delay before retrying
            const delayMs = 2000 * loginAttempt;
            console.log(`Login failed, retrying in ${delayMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
          }
        }
      }
      
      // If we get here, all login attempts failed
      this.lastError = lastLoginError instanceof Error ? 
        lastLoginError : 
        new Error("Failed to reconnect Discord bot after multiple attempts");
      throw this.lastError;
    } catch (error) {
      this.isConnecting = false;
      this.isConnected = false;
      this.connectionError = error instanceof Error ? error.message : String(error);
      console.error("Discord bot reconnection failed:", error);
      throw error;
    }
  }
}