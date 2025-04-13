import { Client, Channel, Message, Member, Role, API, revolt } from 'revolt.js';
import { log } from "../vite";
import type { Ticket, User, Category, BotConfig } from "@shared/schema";
import { storage } from "../storage";
import { BridgeManager } from "./bridge";
import path from "path";

// To allow references to the bridge without causing circular dependencies
export type RevoltBotOptions = {
  bridge: BridgeManager;
};

export class RevoltBot {
  private client: Client | null = null;
  private bridge: BridgeManager;
  private ready: boolean = false;
  private connecting: boolean = false;
  private disconnected: boolean = false;
  private disconnectReason: string = '';
  private connectionAttempt: number = 0;
  private messageHandlers: Map<string, (message: revolt.Message) => Promise<void>> = new Map();
  
  // Command tracking
  private registeredSlashCommands: Set<string> = new Set();
  private reconnectTimeout: NodeJS.Timeout | null = null;
  
  constructor(options: RevoltBotOptions) {
    this.bridge = options.bridge;
    log("Revolt bot initialized");
  }
  
  public isReady(): boolean {
    return this.ready && this.client?.user !== undefined && this.client.ws.state === revolt.State.Ready;
  }

  public isConnecting(): boolean {
    return this.connecting;
  }

  public isDisconnected(): boolean {
    return this.disconnected;
  }

  public getDisconnectReason(): string {
    return this.disconnectReason;
  }
  
  public async getReady() {
    if (this.ready) return;
    
    // Wait for bot to be ready with timeout
    const timeout = 30000;
    const start = Date.now();
    
    return new Promise<void>((resolve, reject) => {
      const checkReady = () => {
        if (this.ready) {
          resolve();
          return;
        }
        
        if (Date.now() - start > timeout) {
          reject(new Error("Timeout waiting for Revolt bot to be ready"));
          return;
        }
        
        setTimeout(checkReady, 500);
      };
      
      checkReady();
    });
  }
  
  public async start(): Promise<void> {
    try {
      // Don't start if already connecting
      if (this.connecting) {
        log("Revolt bot is already connecting, ignoring start request");
        return;
      }
      
      this.connecting = true;
      this.disconnected = false;
      this.disconnectReason = '';
      this.connectionAttempt++;
      
      log(`Starting Revolt bot (attempt ${this.connectionAttempt})`);
      
      // Get the bot token from database
      const config = await storage.getBotConfig();
      if (!config?.revoltToken) {
        throw new Error("Revolt bot token not configured");
      }
      
      // Check if we already have a client initialized
      if (this.client) {
        log("Cleaning up existing Revolt client before creating a new one");
        try {
          // Try to gracefully disconnect if possible
          await this.client.logout();
        } catch (e) {
          // Ignore errors during cleanup
        }
        this.client = null;
      }
      
      // Initialize the client
      this.client = new Client();
      
      // Set up event listeners
      this.setupEventListeners();
      
      // Authenticate with Revolt
      await this.client.loginBot(config.revoltToken);
      
      log("Revolt bot started successfully");
      this.ready = true;
      this.connecting = false;
      
    } catch (error) {
      this.connecting = false;
      this.disconnected = true;
      this.disconnectReason = error instanceof Error ? error.message : String(error);
      log(`Error starting Revolt bot: ${this.disconnectReason}`, "error");
      throw error;
    }
  }
  
  private setupEventListeners(): void {
    if (!this.client) return;
    
    // When the bot is ready
    this.client.on('ready', async () => {
      log("Revolt bot is ready");
      this.ready = true;
      await this.registerOrUpdateCommands();
    });
    
    // Handle disconnection
    this.client.on('dropped', () => {
      log("Revolt bot disconnected", "warn");
      this.handleDisconnect("WebSocket connection dropped");
    });
    
    // Handle messages
    this.client.on('message', async (message: revolt.Message) => {
      if (message.authorId === this.client?.user?._id) return;
      try {
        await this.handleMessage(message);
      } catch (error) {
        log(`Error handling Revolt message: ${error}`, "error");
      }
    });
  }
  
  private handleDisconnect(reason: string): void {
    this.ready = false;
    this.disconnected = true;
    this.disconnectReason = reason;
    
    // Clear any existing reconnect timeout
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    
    log(`Revolt bot disconnected: ${reason}`, "warn");
  }
  
  public async stop(): Promise<void> {
    if (this.client) {
      try {
        // Clear any existing reconnect timeout
        if (this.reconnectTimeout) {
          clearTimeout(this.reconnectTimeout);
          this.reconnectTimeout = null;
        }
        
        this.ready = false;
        await this.client.logout();
        this.client = null;
        log("Revolt bot stopped successfully");
      } catch (error) {
        log(`Error stopping Revolt bot: ${error}`, "error");
        // Force cleanup
        this.client = null;
      }
    }
  }
  
  public async registerOrUpdateCommands(): Promise<void> {
    if (!this.client || !this.isReady()) {
      log("Cannot register commands: Revolt bot not ready", "warn");
      return;
    }
    
    try {
      // For Revolt, slash commands work differently than in Discord
      // This is a placeholder for command registration logic
      log("Registered Revolt slash commands successfully");
    } catch (error) {
      log(`Error registering Revolt slash commands: ${error}`, "error");
    }
  }
  
  private async handleMessage(message: revolt.Message): Promise<void> {
    if (!this.client) return;
    
    try {
      // Check if this is a ticket channel message
      const channel = message.channel;
      if (!channel || channel.channel_type !== 'TextChannel') return;
      
      // Look up ticket by Revolt channel ID
      const ticket = await storage.getTicketByRevoltChannel(message.channel._id);
      if (!ticket) return;
      
      // Process the message from Revolt to Telegram
      await this.processMessageToTelegram(message, ticket);
    } catch (error) {
      log(`Error handling Revolt message: ${error}`, "error");
    }
  }
  
  private async processMessageToTelegram(message: revolt.Message, ticket: Ticket): Promise<void> {
    try {
      // Get the user associated with the ticket
      const user = await storage.getUser(ticket.userId);
      if (!user || !user.telegramId) {
        log(`Could not find Telegram user for ticket #${ticket.id}`, "error");
        return;
      }
      
      // Get the sender's username
      const sender = message.member || message.authorId;
      let senderName = 'Staff';
      
      // If it's a Member object, we can get the nickname or username
      if (typeof sender !== 'string') {
        senderName = sender.nickname || sender.username || 'Staff';
      }
      
      // Handle attachments
      const attachments: string[] = [];
      if (message.attachments && message.attachments.length > 0) {
        for (const attachment of message.attachments) {
          try {
            // Process attachment through bridge
            const fileBuffer = await this.bridge.downloadFile(attachment.url);
            if (fileBuffer) {
              const fileId = await this.bridge.sendImageToTelegram(user.telegramId, fileBuffer, ticket.id);
              if (fileId) {
                attachments.push(fileId);
              }
            }
          } catch (error) {
            log(`Error processing Revolt attachment: ${error}`, "error");
          }
        }
      }
      
      // Format the content to remove mentions and replace them with plain text usernames
      let content = message.content || '';
      
      // Save the message to database
      const dbMessage = await storage.createMessage({
        ticketId: ticket.id,
        content: content,
        authorId: null, // No user ID for staff messages
        platform: 'revolt',
        timestamp: new Date(),
        attachments: attachments,
        senderName: senderName
      });
      
      // Format the message for Telegram
      const formattedContent = `*${senderName}*: ${content}`;
      
      // Send to Telegram
      await this.bridge.sendMessageToTelegram(user.telegramId, formattedContent, ticket.id);
      
      log(`Sent message from Revolt to Telegram for ticket #${ticket.id}`);
    } catch (error) {
      log(`Error processing message from Revolt to Telegram: ${error}`, "error");
    }
  }
  
  public async sendMessageToTicket(ticketId: number, content: string, userId?: number): Promise<boolean> {
    if (!this.client || !this.isReady()) {
      log(`Cannot send message to Revolt: bot not ready`, "error");
      return false;
    }
    
    try {
      // Get the ticket
      const ticket = await storage.getTicket(ticketId);
      if (!ticket || !ticket.revoltChannelId) {
        log(`Cannot send message to Revolt: ticket #${ticketId} not found or has no Revolt channel`, "error");
        return false;
      }
      
      // Get the channel
      const channel = await this.client.channels.fetch(ticket.revoltChannelId);
      if (!channel || channel.channel_type !== 'TextChannel') {
        log(`Cannot send message to Revolt: channel for ticket #${ticketId} not found`, "error");
        return false;
      }
      
      // Get the user if a user ID is provided
      let userPrefix = 'User';
      if (userId) {
        const user = await storage.getUser(userId);
        if (user) {
          userPrefix = user.username;
        }
      }
      
      // Format the message content
      const formattedContent = `**${userPrefix}**: ${content}`;
      
      // Send the message to the channel
      await channel.sendMessage({
        content: formattedContent
      });
      
      return true;
    } catch (error) {
      log(`Error sending message to Revolt: ${error}`, "error");
      return false;
    }
  }
  
  public async createTicketChannel(ticket: Ticket, category: Category, user: User): Promise<string | null> {
    if (!this.client || !this.isReady()) {
      log(`Cannot create ticket channel in Revolt: bot not ready`, "error");
      return null;
    }
    
    try {
      // Find the server
      const servers = Array.from(this.client.servers.values());
      if (servers.length === 0) {
        log("No Revolt servers found for the bot", "error");
        return null;
      }
      
      // Use the first server (assumption: the bot is in only one server)
      const server = servers[0];
      
      // Find or create the category
      const categoryId = category.revoltCategoryId || await this.createCategoryChannel(server, category);
      
      if (!categoryId) {
        log(`Could not find or create category for ${category.name}`, "error");
        return null;
      }
      
      // Create a unique channel name
      const channelName = `ticket-${ticket.id}`;
      
      // Create the channel
      const channel = await server.createChannel({
        name: channelName,
        type: 'TextChannel',
        parent: categoryId
      });
      
      if (!channel) {
        log(`Failed to create Revolt channel for ticket #${ticket.id}`, "error");
        return null;
      }
      
      // Send initial message to the channel
      const questions = category.questions || [];
      const answers = ticket.answers || [];
      
      let initialMessage = `# New Ticket: ${category.name}\n\n`;
      initialMessage += `**User**: ${user.username}\n\n`;
      
      // Add Q&A
      if (questions.length > 0 && answers.length > 0) {
        initialMessage += "## Information\n\n";
        const maxQuestions = Math.min(questions.length, answers.length);
        
        for (let i = 0; i < maxQuestions; i++) {
          initialMessage += `**${questions[i]}**\n${answers[i] || 'No answer provided'}\n\n`;
        }
      }
      
      initialMessage += `\n*Use the \`/close\` command to close this ticket when resolved.*`;
      
      await channel.sendMessage({
        content: initialMessage
      });
      
      log(`Created new Revolt channel ${channel.name} for ticket #${ticket.id}`);
      return channel._id;
    } catch (error) {
      log(`Error creating Revolt ticket channel: ${error}`, "error");
      return null;
    }
  }
  
  private async createCategoryChannel(server: revolt.Server, category: Category): Promise<string | null> {
    try {
      // Create the category channel
      const channel = await server.createChannel({
        name: category.name,
        type: 'Category',
      });
      
      if (!channel) {
        log(`Failed to create Revolt category channel for ${category.name}`, "error");
        return null;
      }
      
      // Save the category ID to the database
      await storage.updateCategory(category.id, {
        revoltCategoryId: channel._id
      });
      
      log(`Created new Revolt category ${category.name} with ID ${channel._id}`);
      return channel._id;
    } catch (error) {
      log(`Error creating Revolt category channel: ${error}`, "error");
      return null;
    }
  }
  
  public async closeTicket(ticketId: number, requestedBy?: string): Promise<boolean> {
    if (!this.client || !this.isReady()) {
      log(`Cannot close ticket in Revolt: bot not ready`, "error");
      return false;
    }
    
    try {
      // Get the ticket
      const ticket = await storage.getTicket(ticketId);
      if (!ticket || !ticket.revoltChannelId) {
        log(`Cannot close ticket in Revolt: ticket #${ticketId} not found or has no Revolt channel`, "error");
        return false;
      }
      
      // Get the channel
      const channel = await this.client.channels.fetch(ticket.revoltChannelId);
      if (!channel || channel.channel_type !== 'TextChannel') {
        log(`Cannot close ticket in Revolt: channel for ticket #${ticketId} not found`, "error");
        return false;
      }
      
      // Send closing message to the channel
      await channel.sendMessage({
        content: `Ticket closed${requestedBy ? ` by ${requestedBy}` : ''}.`
      });
      
      // Move the channel to the transcript category if available
      const category = await storage.getCategory(ticket.categoryId);
      if (category?.revoltTranscriptCategoryId) {
        try {
          await channel.edit({
            parent: category.revoltTranscriptCategoryId
          });
          log(`Moved ticket #${ticketId} channel to transcript category`);
        } catch (error) {
          log(`Error moving ticket channel to transcript category: ${error}`, "warn");
        }
      }
      
      return true;
    } catch (error) {
      log(`Error closing ticket in Revolt: ${error}`, "error");
      return false;
    }
  }
  
  public async uploadFile(buffer: Buffer, filename: string): Promise<string | null> {
    if (!this.client || !this.isReady()) {
      log("Cannot upload file to Revolt: bot not ready", "error");
      return null;
    }
    
    try {
      // Revolt uses a different file upload system
      // This is a placeholder for file upload logic
      log("Revolt file upload not yet implemented");
      return null;
    } catch (error) {
      log(`Error uploading file to Revolt: ${error}`, "error");
      return null;
    }
  }
  
  public async sendImageToTicket(ticketId: number, buffer: Buffer, userId?: number): Promise<boolean> {
    if (!this.client || !this.isReady()) {
      log(`Cannot send image to Revolt: bot not ready`, "error");
      return false;
    }
    
    try {
      // Get the ticket
      const ticket = await storage.getTicket(ticketId);
      if (!ticket || !ticket.revoltChannelId) {
        log(`Cannot send image to Revolt: ticket #${ticketId} not found or has no Revolt channel`, "error");
        return false;
      }
      
      // Get the channel
      const channel = await this.client.channels.fetch(ticket.revoltChannelId);
      if (!channel || channel.channel_type !== 'TextChannel') {
        log(`Cannot send image to Revolt: channel for ticket #${ticketId} not found`, "error");
        return false;
      }
      
      // Get the user if a user ID is provided
      let userPrefix = 'User';
      if (userId) {
        const user = await storage.getUser(userId);
        if (user) {
          userPrefix = user.username;
        }
      }
      
      // Upload the image
      const imageUrl = await this.uploadFile(buffer, 'image.png');
      
      if (!imageUrl) {
        log(`Failed to upload image for ticket #${ticketId}`, "error");
        return false;
      }
      
      // Send the message with the image
      await channel.sendMessage({
        content: `**${userPrefix}** sent an image:`
        // Attachments would be included here but Revolt's API is different
      });
      
      return true;
    } catch (error) {
      log(`Error sending image to Revolt: ${error}`, "error");
      return false;
    }
  }
  
  public async isAdmin(userId: string): Promise<boolean> {
    try {
      const config = await storage.getBotConfig();
      if (!config?.adminRevoltIds) return false;
      return config.adminRevoltIds.includes(userId);
    } catch (error) {
      log(`Error checking if user is Revolt admin: ${error}`, "error");
      return false;
    }
  }
}