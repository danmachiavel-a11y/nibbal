/**
 * RevoltBot - Manages the connection to the Revolt API
 * 
 * Similar to DiscordBot but for the Revolt platform
 */

import * as console from "console";
import { Client, API } from "revolt.js";
import { storage } from "../storage";
import { BridgeManager } from "./bridge";
import { log } from "../vite";
import { ulid } from 'ulid';
import fetch from "node-fetch";
import { createHash } from "crypto";

// Define ConnectionState enum here instead of importing it
enum ConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  ERROR = 'error'
}

export interface RevoltRole {
  id: string;
  name: string;
}

export interface RevoltChannel {
  id: string;
  name: string;
  type: string;
}

export interface RevoltCategory {
  id: string;
  name: string;
  channels: RevoltChannel[];
}

export interface RevoltServerInfo {
  id: string;
  name: string;
  iconUrl?: string;
  memberCount: number;
  ownerId: string;
  categories: RevoltCategory[];
  roles: RevoltRole[];
}

/**
 * Manages the Revolt bot connection and interactions
 * This is a placeholder implementation that will be completed
 * when the revolt.js package is properly integrated
 */
interface RevoltWebhook {
  id: string;
  channelId: string;
  token: string;
  name: string;
  lastUsed: number;
  failures: number;
}

interface RevoltMessage {
  content?: string;
  embeds?: any[];
  files?: Array<{
    file: Buffer;
    filename: string;
  }>;
}

/**
 * Rate limit bucket for Revolt API
 */
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

export class RevoltBot {
  public client: Client;
  private bridge: BridgeManager | null = null;
  private isConnected: boolean = false;
  private isConnecting: boolean = false;
  private disconnectReason: string | null = null;
  private serverId: string | null = null;
  private adminIds: string[] = [];
  private token: string;
  private webhooks: Map<string, RevoltWebhook[]> = new Map();
  private webhookCreationLock: Set<string> = new Set();
  private rateLimitBuckets: Map<string, RateLimitBucket> = new Map();
  private connectionTimeout: NodeJS.Timeout | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private lastError: Error | null = null;
  private connectionError: string | null = null;
  
  // Rate limit configurations
  private readonly LIMITS = {
    global: { capacity: 90, refillTime: 1000 }, // 90 per second
    message: { capacity: 8, refillTime: 5000 }, // 8 per 5 seconds
    channelCreate: { capacity: 15, refillTime: 10000 }, // 15 per 10 seconds
    channelEdit: { capacity: 8, refillTime: 10000 }, // 8 per 10 seconds
  };

  // Connection timeouts
  private readonly CONNECTION_TIMEOUT = 30000; // 30 seconds
  private readonly CLEANUP_INTERVAL = 300000; // 5 minutes
  
  constructor(token: string, adminIds: string[] = [], bridge: BridgeManager | null = null) {
    this.token = token;
    this.adminIds = adminIds;
    this.bridge = bridge;
    
    log(`RevoltBot created with token length: ${token.length}`, "info");
    
    // Initialize Revolt client
    this.client = new Client({
      baseURL: "https://api.revolt.chat",
      autoReconnect: true,
    });
    
    // Set up rate limit buckets
    this.setupRateLimitBuckets();
    
    // Start cleanup intervals
    this.startCleanupIntervals();
    
    // Set up event handlers
    this.setupEventHandlers();
  }
  
  /**
   * Set up rate limiting buckets
   */
  private setupRateLimitBuckets(): void {
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

  /**
   * Start cleanup intervals for WebSocket connections
   */
  private startCleanupIntervals(): void {
    // Clear any existing intervals
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
    }

    // Start WebSocket cleanup interval
    this.cleanupInterval = setInterval(() => {
      this.cleanupConnections();
    }, this.CLEANUP_INTERVAL);

    log("Started WebSocket cleanup intervals for Revolt");
  }

  /**
   * Clean up stale WebSocket connections
   */
  private async cleanupConnections(): Promise<void> {
    try {
      if (!this.client) return;

      // Check if client is connected
      if (this.client.events && !(this.client.events as any).connected) {
        log("Found dead Revolt WebSocket connection, attempting cleanup...", "debug");

        try {
          // Attempt to destroy and reconnect
          if (this.client) {
            // Disconnect current client
            this.client.removeAllListeners();
            this.client.events.removeAllListeners();
            await this.stop();
            log("Successfully destroyed Revolt client connection", "debug");

            // Attempt to reconnect
            await this.start();
          }
        } catch (error) {
          log(`Error during Revolt WebSocket cleanup: ${error}`, "error");
        }
      }
    } catch (error) {
      log(`Error checking Revolt WebSocket status: ${error}`, "error");
    }
  }

  /**
   * Set up event handlers for Revolt client
   */
  private setupEventHandlers(): void {
    // Ensure client is available
    if (!this.client) {
      log("Cannot set up event handlers: Revolt client not initialized", "error");
      return;
    }

    // Setup ready event
    this.client.on("ready", () => {
      log("Revolt bot is ready", "info");
      this.isConnected = true;
      this.isConnecting = false;
      this.disconnectReason = null;
      this.registerSlashCommands();
    });

    // Setup error event with type cast to avoid TypeScript errors
    (this.client as any).on("error", (err: any) => {
      log(`Revolt error: ${err}`, "error");
      this.lastError = err instanceof Error ? err : new Error(String(err));
    });

    // Handle message events with type cast to avoid TypeScript errors
    (this.client as any).on("message", async (message: any) => {
      // Skip messages from the bot itself
      if (message.author?.bot) return;
      
      try {
        // Process commands
        if (message.content && message.content.startsWith('/')) {
          // Handle commands
          log(`Received command: ${message.content}`, "debug");
        }
        
        // Check if this is in a ticket channel and should be forwarded to Telegram
        if (this.bridge) {
          try {
            // Get current channel info
            const channelId = message.channel?.id;
            if (!channelId) return;
            
            // Check if this message is in a ticket channel by querying the database
            const ticket = await storage.getTicketByRevoltChannel(channelId);
            if (!ticket) return; // Not a ticket channel
            
            // Get the user who created the ticket
            const ticketUser = await storage.getUser(ticket.userId);
            if (!ticketUser) return; // Can't find user
            
            // Skip if no Telegram ID (shouldn't happen)
            if (!ticketUser.telegramId) return;
            
            // Get message content
            const content = message.content || '';
            
            // Get sender username (or nickname if available)
            const sender = message.author?.username || 'Unknown User';
            
            // Format the message for Telegram
            let formattedMessage = `💬 **${sender}**: ${content}`;
            
            // Add metadata about service
            formattedMessage = `[Revolt] ${formattedMessage}`;
            
            // Forward the message to Telegram using the bridge
            await this.bridge.forwardToTelegram(
              formattedMessage,
              ticket.id,
              sender
            );
            
            // Handle attachments if any
            const attachments = (message as any).attachments;
            if (attachments && attachments.length > 0) {
              for (const attachment of attachments) {
                // Get file URL
                const fileUrl = attachment.url;
                if (fileUrl) {
                  // Queue the message with the attachment for processing
                  // The bridge knows how to handle attachments in forwardToTelegram
                  await this.bridge.forwardToTelegram(
                    `[Revolt] 📎 File from **${sender}**`,
                    ticket.id,
                    sender,
                    [{ url: fileUrl, filename: attachment.filename || 'file' }]
                  );
                }
              }
            }
          } catch (error) {
            log(`Error forwarding Revolt message to Telegram: ${error}`, "error");
          }
        }
      } catch (error) {
        log(`Error handling Revolt message: ${error}`, "error");
      }
    });
  }

  /**
   * Register slash commands with Revolt
   */
  private async registerSlashCommands(): Promise<void> {
    try {
      log("Revolt does not yet support global slash commands like Discord", "info");
      log("Command registration for Revolt not implemented", "info");
      // TODO: When Revolt supports slash commands, implement them here
    } catch (error) {
      log(`Error registering Revolt slash commands: ${error}`, "error");
    }
  }

  /**
   * Check if the bot is ready to process commands
   */
  public isReady(): boolean {
    return this.isConnected && this.client && (this.client as any).ready;
  }
  
  /**
   * Get the disconnect reason if the bot is not connected
   */
  public getDisconnectReason(): string | null {
    return this.disconnectReason;
  }
  
  /**
   * Returns information about the connected Revolt server
   */
  public async getServerInfo(): Promise<RevoltServerInfo> {
    if (!this.isReady()) {
      throw new Error("Revolt bot is not ready");
    }
    
    try {
      // Get the default server - in Revolt we might be in multiple servers
      const servers = Object.values(this.client.servers);
      const server = servers.length > 0 ? servers[0] : null;
      if (!server) {
        throw new Error("Revolt bot is not in any servers");
      }
      
      // Get server information
      const serverId = server._id;
      const serverName = server.name;
      const iconUrl = server.icon ? server.icon.url : undefined;
      const memberCount = server.member_count || 0;
      const ownerId = server.owner;
      
      // Get categories
      const categories: RevoltCategory[] = [];
      const channels = server.channels.map((c: string) => this.client.channels.get(c));
      
      // Build role list
      const roles: RevoltRole[] = [];
      for (const [roleId, roleData] of Object.entries(server.roles || {})) {
        const role = roleData as any;
        roles.push({
          id: roleId,
          name: role.name || 'Unknown Role'
        });
      }
      
      return {
        id: serverId,
        name: serverName,
        iconUrl,
        memberCount,
        ownerId,
        categories,
        roles
      };
    } catch (error) {
      log(`Error getting Revolt server info: ${error}`, "error");
      throw error;
    }
  }
  
  /**
   * Send a message to a Revolt channel
   */
  public async sendMessage(channelId: string, content: string, username?: string): Promise<void> {
    if (!this.isReady()) {
      throw new Error("Revolt bot is not ready");
    }
    
    await this.messageCheck();
    
    try {
      // Get the channel from Revolt
      const channel = this.client.channels.get(channelId);
      if (!channel) {
        throw new Error(`Channel with ID ${channelId} not found`);
      }
      
      // Check if the channel is a text channel using type assertion
      const channelAny = channel as any;
      if ((channelAny.channel_type !== 'TextChannel') && (channelAny.type !== 'TextChannel')) {
        throw new Error(`Channel with ID ${channelId} is not a text channel`);
      }
      
      // Send the message
      await channel.sendMessage({
        content
      });
      
      log(`Sent message to Revolt channel ${channelId}`, "debug");
    } catch (error) {
      log(`Error sending message to Revolt channel ${channelId}: ${error}`, "error");
      throw error;
    }
  }
  
  /**
   * Send a message using webhooks (with username override)
   */
  public async sendWebhookMessage(channelId: string, message: RevoltMessage): Promise<void> {
    if (!this.isReady()) {
      throw new Error("Revolt bot is not ready");
    }
    
    await this.messageCheck();
    
    try {
      // For now, just use regular message sending as Revolt's webhook support is limited
      const channel = this.client.channels.get(channelId);
      if (!channel) {
        throw new Error(`Channel with ID ${channelId} not found`);
      }
      
      // Check if the channel is a text channel using type assertion
      const channelAny = channel as any;
      if ((channelAny.channel_type !== 'TextChannel') && (channelAny.type !== 'TextChannel')) {
        throw new Error(`Channel with ID ${channelId} is not a text channel`);
      }
      
      // Send the message
      await channel.sendMessage({
        content: message.content || '',
        // Note: Embeds and files would be handled differently in Revolt
        // This is a simplified implementation
      });
      
      log(`Sent webhook-style message to Revolt channel ${channelId}`, "debug");
    } catch (error) {
      log(`Error sending webhook message to Revolt channel ${channelId}: ${error}`, "error");
      throw error;
    }
  }
  
  /**
   * Creates a new channel in the specified category
   */
  public async createChannel(name: string, categoryId: string): Promise<string> {
    if (!this.isReady()) {
      throw new Error("Revolt bot is not ready");
    }
    
    await this.checkRateLimit('channelCreate');
    
    try {
      // Get the first server - in Revolt we might be in multiple servers
      const servers = Object.values(this.client.servers);
      const server = servers.length > 0 ? servers[0] : null;
      if (!server) {
        throw new Error("Revolt bot is not in any servers");
      }
      
      // Create the channel
      const channel = await server.createChannel({
        type: 'Text',
        name
      });
      
      log(`Created Revolt channel ${name} with ID ${channel._id}`, "info");
      return channel._id;
    } catch (error) {
      log(`Error creating Revolt channel ${name}: ${error}`, "error");
      throw error;
    }
  }
  
  /**
   * Create a ticket channel with proper permissions
   */
  public async createTicketChannel(categoryId: string, name: string): Promise<string> {
    if (!this.isReady()) {
      throw new Error("Revolt bot is not ready");
    }
    
    await this.checkRateLimit('channelCreate');
    
    try {
      // Create base channel
      const channelId = await this.createChannel(name, categoryId);
      log(`Created ticket channel ${name} (${channelId}) in category ${categoryId}`, "info");
      
      // In a more complete implementation, we'd set up permissions here
      // However, Revolt's permission model is different from Discord
      
      return channelId;
    } catch (error) {
      log(`Error creating ticket channel ${name}: ${error}`, "error");
      throw error;
    }
  }
  
  /**
   * Rate limiting utilities
   */
  private async checkRateLimit(type: string, id: string = 'global'): Promise<void> {
    return new Promise((resolve, reject) => {
      const bucket = this.getBucket(type);
      this.refillBucket(bucket);

      if (bucket.tokens < 1) {
        bucket.queue.push({ resolve, reject });

        setTimeout(() => {
          const index = bucket.queue.findIndex(item => 
            item.resolve === resolve && item.reject === reject);
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
      const limit = this.LIMITS[key as keyof typeof this.LIMITS] || this.LIMITS.global;
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

  private async messageCheck(): Promise<void> {
    return this.checkRateLimit('message');
  }

  /**
   * Start the Revolt bot
   */
  public async start(): Promise<void> {
    try {
      // Clear any existing timeouts and reset last error
      if (this.connectionTimeout) {
        clearTimeout(this.connectionTimeout);
      }
      this.lastError = null;
      this.isConnecting = true;
      this.isConnected = false;

      // Validate Revolt token
      if (!this.token) {
        const errorMessage = "Revolt bot token is missing";
        log(errorMessage, "error");
        this.lastError = new Error(errorMessage);
        this.isConnecting = false;
        throw this.lastError;
      }

      if (this.token === "your_revolt_bot_token_here" || this.token.includes("your_") || this.token.length < 10) {
        const errorMessage = "Revolt bot token appears to be invalid or a placeholder";
        log(errorMessage, "error");
        this.lastError = new Error(errorMessage);
        this.isConnecting = false;
        throw this.lastError;
      }

      // Set connection timeout
      this.connectionTimeout = setTimeout(() => {
        log("Connection timeout reached, destroying Revolt client...", "warn");
        this.lastError = new Error("Connection timeout reached");
        this.isConnecting = false;
        this.isConnected = false;
        this.connectionError = "Connection timeout reached";
        this.stop().catch(error => log(`Error stopping Revolt client: ${error}`, "error"));
      }, this.CONNECTION_TIMEOUT);

      log("Attempting to connect to Revolt with provided token...");
      
      // Login to Revolt
      await this.client.loginBot(this.token);
      
      // Clear timeout on successful connection
      if (this.connectionTimeout) {
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;
      }

      // Update connection status
      this.isConnecting = false;
      this.isConnected = true;
      this.connectionError = null;
      
      // Get first server ID
      const servers = Object.values(this.client.servers);
      this.serverId = servers.length > 0 ? servers[0]._id : null;
      
      log("Revolt bot started successfully");
      return;
    } catch (error) {
      let errorMessage = error instanceof Error ? error.message : String(error);
      log(`Error starting Revolt bot: ${errorMessage}`, "error");
      
      // Clean up timeouts
      if (this.connectionTimeout) {
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;
      }
      
      // Update connection status
      this.isConnecting = false;
      this.isConnected = false;
      this.connectionError = errorMessage;
      this.lastError = error instanceof Error ? error : new Error(errorMessage);
      
      throw this.lastError;
    }
  }

  /**
   * Stop the bot and disconnect from Revolt
   */
  public async stop(): Promise<void> {
    try {
      // Mark as disconnected first
      this.isConnected = false;
      this.isConnecting = false;
      
      // Clear intervals and timeouts
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
        this.cleanupInterval = null;
      }
      
      if (this.connectionTimeout) {
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;
      }
      
      // Remove all event listeners to prevent memory leaks
      if (this.client) {
        this.client.removeAllListeners();
        if (this.client.events) {
          this.client.events.removeAllListeners();
        }
      }
      
      log("Revolt bot stopped successfully", "info");
    } catch (error) {
      this.disconnectReason = `Error stopping Revolt bot: ${error}`;
      log(this.disconnectReason, "error");
      throw error;
    }
  }
  
  /**
   * Reconnect to Revolt
   */
  public async reconnect(): Promise<void> {
    try {
      if (this.isConnecting) {
        log("Revolt bot is already in the process of connecting", "info");
        return;
      }
      
      this.isConnecting = true;
      this.disconnectReason = null;
      
      // Stop the current connection
      await this.stop();
      
      // Start a new connection
      await this.start();
      
      log("Revolt bot reconnected successfully", "info");
    } catch (error) {
      this.isConnecting = false;
      this.isConnected = false;
      this.disconnectReason = `Error reconnecting to Revolt: ${error}`;
      log(this.disconnectReason, "error");
      throw error;
    }
  }
  
  /**
   * Get the list of roles from the server
   */
  public async getRoles(): Promise<RevoltRole[]> {
    if (!this.isReady()) {
      throw new Error("Revolt bot is not ready");
    }
    
    try {
      // Get the default server - in Revolt we might be in multiple servers
      const servers = Object.values(this.client.servers);
      const server = servers.length > 0 ? servers[0] : null;
      if (!server) {
        throw new Error("Revolt bot is not in any servers");
      }
      
      // Get the roles
      const roles: RevoltRole[] = [];
      
      // In Revolt, roles are stored in an object where keys are role IDs
      for (const [roleId, roleData] of Object.entries(server.roles || {})) {
        const role = roleData as any;
        roles.push({
          id: roleId,
          name: role.name || 'Unknown Role'
        });
      }
      
      // If no roles are found but we're connected, provide default roles
      if (roles.length === 0) {
        log("No roles found in Revolt server, using default roles", "warn");
        return [
          { id: "default-owner", name: "Owner" },
          { id: "default-admin", name: "Admin" },
          { id: "default-member", name: "Member" }
        ];
      }
      
      return roles;
    } catch (error) {
      log(`Error getting Revolt roles: ${error}`, "error");
      throw error;
    }
  }
  
  /**
   * Find a channel by its ID
   */
  public getChannel(channelId: string): RevoltChannel | null {
    if (!this.isReady()) {
      return null;
    }
    
    try {
      // Get the channel from Revolt
      const channel = this.client.channels.get(channelId);
      if (!channel) {
        return null;
      }
      
      // Convert to RevoltChannel format
      const channelAny = channel as any;
      return {
        id: channelId,
        name: channelAny.name || `Channel ${channelId}`,
        type: channelAny.channel_type || channelAny.type || "TextChannel"
      };
    } catch (error) {
      log(`Error getting Revolt channel ${channelId}: ${error}`, "error");
      return null;
    }
  }
  
  /**
   * Check if a user is an admin
   */
  public isAdmin(userId: string): boolean {
    return this.adminIds.includes(userId);
  }
  
  /**
   * Moves a channel to a different category
   * Note: Revolt handles categories differently from Discord
   * In Revolt, categories are just special channels that group other channels
   */
  public async moveChannel(channelId: string, categoryId: string): Promise<void> {
    if (!this.isReady()) {
      throw new Error("Revolt bot is not ready");
    }
    
    await this.checkRateLimit('channelEdit');
    
    try {
      // Get the channel to be moved
      const channel = this.client.channels.get(channelId);
      if (!channel) {
        throw new Error(`Channel with ID ${channelId} not found`);
      }
      
      // Get the category channel
      const categoryChannel = this.client.channels.get(categoryId);
      if (!categoryChannel) {
        throw new Error(`Category with ID ${categoryId} not found`);
      }
      
      // In Revolt, we need to use the edit method to set the parent
      const channelAny = channel as any;
      
      // Update the channel with the new parent
      // Use type assertion to work around the TypeScript limitations
      await (channel as any).edit({
        // In Revolt, the parent field is used to link a channel to its category
        parent: categoryId
      });
      
      log(`Moved Revolt channel ${channelId} to category ${categoryId}`, "info");
    } catch (error) {
      log(`Error moving Revolt channel ${channelId} to category ${categoryId}: ${error}`, "error");
      throw error;
    }
  }
  
  /**
   * Check if the bot is in the starting process
   */
  public isStartingProcess(): boolean {
    return this.isConnecting;
  }
  
  /**
   * Send a file to a Revolt channel
   */
  public async sendFile(channelId: string, file: Buffer, filename: string, caption?: string): Promise<void> {
    if (!this.isReady()) {
      throw new Error("Revolt bot is not ready");
    }
    
    await this.messageCheck();
    
    try {
      // Get the channel from Revolt
      const channel = this.client.channels.get(channelId);
      if (!channel) {
        throw new Error(`Channel with ID ${channelId} not found`);
      }
      
      // Check if the channel is a text channel using type assertion
      const channelAny = channel as any;
      if ((channelAny.channel_type !== 'TextChannel') && (channelAny.type !== 'TextChannel')) {
        throw new Error(`Channel with ID ${channelId} is not a text channel`);
      }
      
      // Send the file using a more flexible approach with type assertions to overcome API typing issues
      // Cast to any to work around TypeScript limitations with Revolt API
      const api = this.client.api as any;
      const upload = await api.post('/attachments', {
        file
      });
      
      const uploadCast = upload as any;
      await channel.sendMessage({
        content: caption || '',
        attachments: [uploadCast._id || uploadCast.id]
      });
      
      log(`Sent file to Revolt channel ${channelId}`, "debug");
    } catch (error) {
      log(`Error sending file to Revolt channel ${channelId}: ${error}`, "error");
      throw error;
    }
  }
}