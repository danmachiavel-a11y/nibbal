import { 
  Client, 
  GatewayIntentBits, 
  TextChannel, 
  Webhook,
  CategoryChannel,
  ChannelType,
  EmbedBuilder
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

  private setupHandlers() {
    this.client.on("ready", () => {
      log("Discord bot ready");
    });

    this.client.on("messageCreate", async (message) => {
      // Ignore bot messages to prevent loops
      if (message.author.bot) return;

      // Check for /paid command
      if (message.content.startsWith('/paid')) {
        const amount = parseInt(message.content.split(' ')[1]);

        if (isNaN(amount)) {
          await message.reply("Please specify a valid amount, e.g., `/paid 50`");
          return;
        }

        const ticket = await storage.getTicketByDiscordChannel(message.channelId);
        if (!ticket) {
          await message.reply("This command can only be used in ticket channels!");
          return;
        }

        try {
          await storage.updateTicketPayment(ticket.id, amount, message.author.id);

          // Create an embed for the payment confirmation
          const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('💰 Payment Recorded')
            .setDescription(`Ticket marked as paid by ${message.author.username}`)
            .addFields(
              { name: 'Amount', value: `$${amount}`, inline: true },
              { name: 'Status', value: 'Completed & Paid', inline: true }
            )
            .setTimestamp();

          await message.channel.send({ embeds: [embed] });

          // Forward the payment info to Telegram
          await this.bridge.forwardToTelegram(
            `💰 Ticket marked as paid ($${amount}) by ${message.author.username}`,
            ticket.id,
            "System"
          );

          return;
        } catch (error) {
          log(`Error processing payment: ${error}`, "error");
          await message.reply("Failed to process payment. Please try again.");
          return;
        }
      }

      // Regular message handling continues here...
      if (message.content.startsWith('.')) return;

      const ticket = await storage.getTicketByDiscordChannel(message.channelId);
      if (!ticket) {
        log(`No ticket found for channel ${message.channelId}`);
        return;
      }

      log(`Processing Discord message for ticket ${ticket.id} in channel ${message.channelId}`);

      try {
        // Store message in database
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

        // Forward to Telegram with the user's display name
        await this.bridge.forwardToTelegram(
          message.content,
          ticket.id,
          message.member?.displayName || message.author.username || "Unknown Discord User"
        );

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

  async start() {
    await this.client.login(process.env.DISCORD_BOT_TOKEN);
  }
}