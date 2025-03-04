import { 
  Client, 
  GatewayIntentBits, 
  TextChannel, 
  Webhook,
  CategoryChannel,
  ChannelType,
  CommandInteraction
} from "discord.js";
import { storage } from "../storage";
import { BridgeManager } from "./bridge";

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
      console.log("Discord bot ready");
    });

    this.client.on("messageCreate", async (message) => {
      // Ignore bot messages to prevent loops
      if (message.author.bot) return;

      const ticket = await storage.getTicketByDiscordChannel(message.channelId);
      if (!ticket) return;

      console.log(`Forwarding message from Discord to Telegram for ticket ${ticket.id}`);

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
      }

      // Forward to Telegram
      await this.bridge.forwardToTelegram(
        message.content,
        ticket.id,
        message.author.username || "Unknown Discord User"
      );
    });

    // Command handlers
    this.client.on("interactionCreate", async (interaction) => {
      if (!interaction.isCommand()) return;

      const ticket = await storage.getTicketByDiscordChannel(interaction.channelId);
      if (!ticket) return;

      await this.handleCommand(interaction, ticket.id);
    });
  }

  private async handleCommand(interaction: CommandInteraction, ticketId: number) {
    switch (interaction.commandName) {
      case "claim":
        await storage.updateTicketStatus(ticketId, "claimed", interaction.user.id);
        await interaction.reply("Ticket claimed!");
        break;

      case "unclaim":
        await storage.updateTicketStatus(ticketId, "open", undefined);
        await interaction.reply("Ticket unclaimed!");
        break;

      case "close":
        await storage.updateTicketStatus(ticketId, "closed", undefined);
        await interaction.reply("Ticket closed!");
        break;

      case "paid": {
        const amount = interaction.options.get("amount")?.value;
        if (typeof amount !== "number") {
          await interaction.reply("Please provide a valid amount!");
          return;
        }
        await storage.updateTicketAmount(ticketId, amount);
        await interaction.reply(`Ticket marked as paid: $${amount}`);
        break;
      }
    }
  }

  async createTicketChannel(categoryId: string, name: string): Promise<string> {
    try {
      console.log(`Creating ticket channel ${name} in category ${categoryId}`);

      const category = await this.client.channels.fetch(categoryId);
      if (!category || category.type !== ChannelType.GuildCategory) {
        throw new Error(`Invalid category ${categoryId}`);
      }

      const channel = await (category as CategoryChannel).guild.channels.create({
        name,
        parent: category,
        type: ChannelType.GuildText
      });

      console.log(`Successfully created channel ${channel.id}`);
      return channel.id;
    } catch (error) {
      console.error(`Error creating ticket channel: ${error}`);
      throw error;
    }
  }

  async sendMessage(channelId: string, content: string, username: string, avatarUrl?: string) {
    try {
      console.log(`Attempting to send message to Discord channel ${channelId}`);

      const channel = await this.client.channels.fetch(channelId);
      if (!(channel instanceof TextChannel)) {
        throw new Error(`Invalid channel type for channel ${channelId}`);
      }

      // Create webhook if it doesn't exist
      let webhook = this.webhooks.get(channelId);
      if (!webhook) {
        console.log(`Creating new webhook for channel ${channelId}`);
        webhook = await channel.createWebhook({
          name: username,
          avatar: avatarUrl
        });
        this.webhooks.set(channelId, webhook);
      }

      // Send message via webhook
      await webhook.send({
        content,
        username,
        avatarURL: avatarUrl
      });

      console.log(`Successfully sent message to Discord channel ${channelId}`);
    } catch (error) {
      console.error(`Error sending message to Discord: ${error}`);
      throw error;
    }
  }

  async start() {
    await this.client.login(process.env.DISCORD_BOT_TOKEN);
  }
}