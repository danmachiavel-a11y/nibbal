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

  private async setupHandlers() {
    this.client.on("ready", () => {
      console.log("Discord bot ready");
    });

    this.client.on("messageCreate", async (message) => {
      if (message.author.bot) return;

      const ticket = await storage.getTicketByDiscordChannel(message.channelId);
      if (!ticket) return;

      // Forward message to Telegram
      await this.bridge.forwardToTelegram(message.content, ticket.id, message.author.username);
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
        await storage.updateTicketStatus(ticketId, "open", null);
        await interaction.reply("Ticket unclaimed!");
        break;

      case "close":
        await storage.updateTicketStatus(ticketId, "closed", null);
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
    const category = await this.client.channels.fetch(categoryId);
    if (!category || category.type !== ChannelType.GuildCategory) {
      throw new Error("Invalid category");
    }

    const channel = await (category as CategoryChannel).guild.channels.create({
      name,
      parent: category,
      type: ChannelType.GuildText
    });

    return channel.id;
  }

  async sendMessage(channelId: string, content: string, username: string, avatarUrl?: string) {
    let webhook = this.webhooks.get(channelId);

    if (!webhook) {
      const channel = await this.client.channels.fetch(channelId);
      if (!(channel instanceof TextChannel)) {
        throw new Error("Invalid channel type");
      }

      webhook = await channel.createWebhook({
        name: username,
        avatar: avatarUrl
      });
      this.webhooks.set(channelId, webhook);
    }

    await webhook.send({
      content,
      username,
      avatarURL: avatarUrl
    });
  }

  async start() {
    if (!process.env.DISCORD_BOT_TOKEN) {
      throw new Error("DISCORD_BOT_TOKEN is required");
    }
    await this.client.login(process.env.DISCORD_BOT_TOKEN);
  }
}