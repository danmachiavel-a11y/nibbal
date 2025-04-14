import { storage } from "../storage";
// Import the unified Telegram bot implementation
import { TelegramBot } from "./telegram";
import { DiscordBot } from "./discord";
import { RevoltBot } from "./revolt";
import type { Ticket, Message } from "@shared/schema";
import { log } from "../vite";
import fetch, { RequestInit } from 'node-fetch';
import { TextChannel } from 'discord.js';
import crypto from 'crypto';

class BridgeError extends Error {
  code?: string;
  details?: any;
  context?: string;

  constructor(message: string, details?: { context?: string; code?: string; details?: any }) {
    super(message);
    this.name = 'BridgeError';
    
    if (details) {
      this.context = details.context;
      this.code = details.code;
      this.details = details.details;
    }
  }
}

// Centralized error handler
const handleBridgeError = (error: Error, context: string): void => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorDetails = {
    context,
    code: error instanceof BridgeError ? error.code : undefined,
    details: error instanceof BridgeError ? error.details : undefined,
    timestamp: new Date().toISOString()
  };
  log(`Error in ${context}: ${errorMessage}`, "error");
  log(`Error details: ${JSON.stringify(errorDetails)}`, "error");
};

interface ImageCacheEntry {
  telegramFileId?: string;
  discordUrl?: string;
  buffer?: Buffer;
  timestamp: number;
  size: number;  // Track size in bytes
}

export class BridgeManager {
  private telegramBot: TelegramBot;
  private discordBot: DiscordBot;
  private revoltBot: RevoltBot | null = null;
  private retryAttempts: number = 0;
  private maxRetries: number = 3;
  private retryTimeout: number = 5000;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private readonly imageCacheTTL = 24 * 60 * 60 * 1000; // 24 hours
  private readonly maxImageCacheSize = 500 * 1024 * 1024; // 500MB
  private currentImageCacheSize = 0;
  private imageCache: Map<string, ImageCacheEntry> = new Map();
  private roleCache: Map<number, string> = new Map();
  private readonly imageCacheCleanupInterval = 3600000; // 1 hour
  
  // Message deduplication cache
  private readonly messageDedupCache: Map<string, number> = new Map();
  private readonly messageDedupWindow: number = 180000; // 3 minutes (increased from 60s)
  private readonly MAX_DEDUP_CACHE_SIZE = 1000; // Maximum number of cached entries
  
  // Deployment-aware fields for robust initialization
  private isDisabled: boolean = false;
  private disabledReason: string = '';
  private startTimestamp: number | null = null;
  private lastTelegramReconnectAttempt: number = 0;
  private lastDiscordReconnectAttempt: number = 0; 
  private readonly MIN_RECONNECT_INTERVAL = 15000; // 15 seconds between reconnection attempts
  
  // Enable extra deduplication logging to debug duplicate messages
  private readonly ENABLE_DEDUP_LOGGING = true;
  private readonly MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB per image
  private readonly MIN_IMAGE_SIZE = 32; // 32 bytes minimum


  constructor() {
    log("Initializing Bridge Manager");
    this.telegramBot = new TelegramBot(this);
    this.discordBot = new DiscordBot(this);
    // RevoltBot will be initialized later when needed
    this.revoltBot = null;
    this.startHealthCheck();
    this.startImageCacheCleanup();
    
    // Check active platform on startup
    this.detectActivePlatform().catch(err => {
      log(`Error detecting active platform: ${err}`, "error");
    });
  }
  
  /**
   * Detects which platform (Discord or Revolt) should be active based on database config
   */
  private async detectActivePlatform(): Promise<void> {
    try {
      const config = await storage.getBotConfig();
      if (!config) {
        log("No bot configuration found, using Discord as default platform", "warn");
        return;
      }
      
      const platform = config.activeProvider || 'discord';
      log(`Active platform detected from config: ${platform}`);
      
      // Ensure the appropriate platform is active
      if (platform === 'revolt') {
        // Start RevoltBot if it should be active
        if (config.revoltToken && config.revoltToken.length > 10) {
          await this.startRevoltBot();
        } else {
          log("Revolt configured as active platform but no valid token is available", "warn");
          log("Falling back to Discord as the active platform");
          // Update config to use Discord instead
          await storage.updateBotConfig({
            activeProvider: 'discord'
          });
        }
      } else if (platform === 'discord') {
        // Verify Discord token is valid
        if (!config.discordToken || config.discordToken.length < 10) {
          log("Discord configured as active platform but no valid token is available", "warn");
          // We won't auto-switch to Revolt here, as the admin needs to explicitly choose
        }
      }
    } catch (error) {
      log(`Error detecting active platform: ${error}`, "error");
    }
  }
  
  /**
   * Manually switch between Discord and Revolt as the secondary platform
   * Only one should be active at a time
   */
  public async switchPlatform(platform: 'discord' | 'revolt'): Promise<boolean> {
    try {
      log(`Attempting to switch to ${platform} platform`);
      
      // Check if we're already using the requested platform
      const config = await storage.getBotConfig();
      if (config?.activeProvider === platform) {
        log(`Platform ${platform} is already active, no change needed`);
        return true;
      }
      
      // Validate token for the platform we're switching to
      if (platform === 'discord') {
        if (!config?.discordToken || config.discordToken.length < 10) {
          const errorMsg = "Cannot switch to Discord: invalid or missing token";
          log(errorMsg, "error");
          throw new Error(errorMsg);
        }
      } else { // platform === 'revolt'
        if (!config?.revoltToken || config.revoltToken.length < 10) {
          const errorMsg = "Cannot switch to Revolt: invalid or missing token";
          log(errorMsg, "error");
          throw new Error(errorMsg);
        }
      }
      
      // Update config in database first
      await storage.updateBotConfig({
        activeProvider: platform
      });
      
      // Stop the currently active platform
      if (platform === 'discord') {
        // Stop RevoltBot if it's running
        if (this.revoltBot) {
          try {
            await this.revoltBot.stop();
            log("Stopped RevoltBot");
          } catch (stopError) {
            log(`Error stopping RevoltBot: ${stopError}`, "warn");
            // Continue anyway, as we want to start Discord regardless
          }
        }
        
        // Start DiscordBot if it's not running
        if (!this.discordBot.isReady()) {
          await this.restartDiscordBot();
          log("Started DiscordBot");
        } else {
          log("DiscordBot already running, no need to restart");
        }
      } else {
        // Stop DiscordBot if it's running
        if (this.discordBot.isReady()) {
          try {
            await this.discordBot.stop();
            log("Stopped DiscordBot");
          } catch (stopError) {
            log(`Error stopping DiscordBot: ${stopError}`, "warn");
            // Continue anyway
          }
        }
        
        // Initialize RevoltBot if it doesn't exist yet or restart it
        await this.startRevoltBot();
        log("Started RevoltBot");
      }
      
      log(`Successfully switched to ${platform} platform`);
      return true;
    } catch (error) {
      log(`Error switching platform to ${platform}: ${error}`, "error");
      return false;
    }
  }
  
  /**
   * Start the Discord bot with error handling and retries
   */
  private async startDiscordBot(): Promise<void> {
    try {
      // Check if already started
      if (this.discordBot.isReady()) {
        log("DiscordBot is already running");
        return;
      }
      
      // Get the config to check if token is available
      const config = await storage.getBotConfig();
      if (!config?.discordToken) {
        log("Cannot start DiscordBot: no token configured", "error");
        return;
      }
      
      log("Starting DiscordBot...");
      await this.discordBot.start();
      log("DiscordBot started successfully");
    } catch (error) {
      log(`Error starting DiscordBot: ${error}`, "error");
    }
  }
  
  /**
   * Start the Revolt bot with error handling and retries
   */
  private async startRevoltBot(): Promise<void> {
    try {
      // Get the config to check if token is available
      const config = await storage.getBotConfig();
      if (!config?.revoltToken) {
        log("Cannot start RevoltBot: no token configured", "error");
        return;
      }
      
      // Check if we should use the separate Telegram bot for Revolt
      // This is useful for testing with a different Telegram bot while keeping Discord integration intact
      if (config?.telegramRevoltToken && config.telegramRevoltToken !== config.telegramToken) {
        log("Using separate Telegram token for Revolt integration");
        // TODO: Implement separate Telegram bot instance for Revolt if needed
      }
      
      // Initialize RevoltBot if it doesn't exist yet
      if (!this.revoltBot) {
        log("Initializing new RevoltBot instance");
        const adminIds = config.adminRevoltIds || [];
        this.revoltBot = new RevoltBot(config.revoltToken, adminIds);
      }
      
      // Check if already started
      if (this.revoltBot.isReady()) {
        log("RevoltBot is already running");
        return;
      }
      
      log("Starting RevoltBot...");
      // RevoltBot doesn't need explicit start as it's initialized in the constructor
      // We just ensure it's set up correctly
      if (this.revoltBot.isStartingProcess()) {
        log("RevoltBot is already in the process of starting");
      } else {
        log("Initializing RevoltBot connection");
        await this.revoltBot.reconnect();
      }
      log("RevoltBot starting process initiated");
    } catch (error) {
      log(`Error starting RevoltBot: ${error}`, "error");
    }
  }

  private startImageCacheCleanup(): void {
    setInterval(() => this.cleanupImageCache(), this.imageCacheCleanupInterval);
  }

  private cleanupImageCache(): void {
    const now = Date.now();
    let deletedSize = 0;

    // Remove expired entries
    for (const [key, entry] of this.imageCache.entries()) {
      if (now - entry.timestamp > this.imageCacheTTL) {
        this.imageCache.delete(key);
        if (entry.buffer) {
          deletedSize += entry.buffer.length;
          // Avoid potential negative values in case of race conditions
          this.currentImageCacheSize = Math.max(0, this.currentImageCacheSize - entry.buffer.length);
        }
      }
    }

    // If still over size limit, remove oldest entries
    if (this.currentImageCacheSize > this.maxImageCacheSize) {
      const entries = Array.from(this.imageCache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);

      while (this.currentImageCacheSize > this.maxImageCacheSize && entries.length > 0) {
        const [key, entry] = entries.shift()!;
        this.imageCache.delete(key);
        if (entry.buffer) {
          deletedSize += entry.buffer.length;
          // Avoid potential negative values in case of race conditions
          this.currentImageCacheSize = Math.max(0, this.currentImageCacheSize - entry.buffer.length);
        }
      }
    }

    if (deletedSize > 0) {
      log(`Cleaned up ${(deletedSize / 1024 / 1024).toFixed(2)}MB from image cache`);
    }
  }

  private setCachedImage(key: string, entry: Partial<ImageCacheEntry>) {
    const buffer = entry.buffer;
    if (buffer) {
      // Check if adding this would exceed cache size
      if (this.currentImageCacheSize + buffer.length > this.maxImageCacheSize) {
        this.cleanupImageCache(); // Try to free up space

        // If still would exceed, don't cache
        if (this.currentImageCacheSize + buffer.length > this.maxImageCacheSize) {
          log(`Skipping cache for large image: ${buffer.length} bytes`);
          return;
        }
      }
      this.currentImageCacheSize += buffer.length;
    }

    this.imageCache.set(key, {
      ...entry,
      timestamp: Date.now(),
      size: buffer?.length || 0
    } as ImageCacheEntry);
  }

  private getCachedImage(key: string): ImageCacheEntry | undefined {
    const entry = this.imageCache.get(key);
    if (!entry) return undefined;

    if (Date.now() - entry.timestamp > this.imageCacheTTL) {
      if (entry.buffer) {
        // Avoid potential negative values in case of race conditions
        this.currentImageCacheSize = Math.max(0, this.currentImageCacheSize - entry.buffer.length);
      }
      this.imageCache.delete(key);
      return undefined;
    }

    return entry;
  }

  private async validateAndProcessImage(buffer: Buffer, context: string): Promise<Buffer | null> {
    try {
      if (!buffer || buffer.length < this.MIN_IMAGE_SIZE) {
        throw new BridgeError("Image too small or empty", { context });
      }

      if (buffer.length > this.MAX_IMAGE_SIZE) {
        throw new BridgeError(`Image too large (${buffer.length} bytes)`, { context });
      }

      return buffer;
    } catch (error) {
      handleBridgeError(error as BridgeError, context);
      return null;
    }
  }

  private async processTelegramToDiscord(fileId: string): Promise<Buffer | null> {
    try {
      // Try cache first
      const cacheKey = `telegram_${fileId}`;
      const cached = this.getCachedImage(cacheKey);
      if (cached?.buffer) {
        log(`Using cached buffer for Telegram file ${fileId}`);
        return cached.buffer;
      }

      log(`[BRIDGE] Processing Telegram file ID: ${fileId}`);

      // IMPROVEMENT: Better error handling for file ID format
      // Check if it's a direct URL rather than a file ID
      if (fileId.startsWith('http')) {
        log(`[BRIDGE] Detected URL instead of file ID: ${fileId.substring(0, 50)}...`, "debug");
        try {
          // Try to download directly from URL
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 30000) as unknown as number;
          const response = await fetch(fileId, { signal: controller.signal });
          clearTimeout(timeoutId);
          if (response.ok) {
            const buffer = Buffer.from(await response.arrayBuffer());
            const validatedBuffer = await this.validateAndProcessImage(buffer, "processTelegramToDiscord-url");
            if (validatedBuffer) {
              // Cache the result
              this.setCachedImage(cacheKey, { buffer: validatedBuffer });
              log(`[BRIDGE] Successfully downloaded file from URL, size: ${validatedBuffer.length} bytes`);
              return validatedBuffer;
            }
          }
        } catch (urlError) {
          log(`[BRIDGE] Error downloading from URL: ${urlError}`, "warn");
        }
      }

      // Use the telegram getter from TelegramBot which has built-in null safety
      try {
        // IMPROVEMENT: Get file directly from bot with better error handling
        const file = await this.telegramBot.getFile(fileId);
        if (!file?.file_path) {
          throw new Error(`Could not get file path for ID: ${fileId}`);
        }

        // IMPROVEMENT: Make sure token is properly included
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        if (!botToken) {
          throw new Error("Telegram bot token is missing");
        }

        const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
        log(`[BRIDGE] Attempting to download from Telegram API: ${fileUrl.substring(0, fileUrl.indexOf('/file/bot') + 9)}...`, "debug");

        // Use Promise.race to implement timeout
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Download timeout')), 30000)
        );

        const response = await Promise.race([
          fetch(fileUrl),
          timeoutPromise
        ]) as Response;

        if (!response.ok) {
          throw new BridgeError(`HTTP error! status: ${response.status}`, { context: "processTelegramToDiscord" });
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        const validatedBuffer = await this.validateAndProcessImage(buffer, "processTelegramToDiscord");
        if (!validatedBuffer) {
          throw new Error("Failed to validate image buffer");
        }

        // Cache the result
        this.setCachedImage(cacheKey, { buffer: validatedBuffer });

        log(`[BRIDGE] Successfully downloaded file from Telegram, size: ${validatedBuffer.length} bytes`);
        return validatedBuffer;
      } catch (telegramError) {
        // If Telegram download fails, try to get the image from the photo cache directly
        log(`[BRIDGE] Error downloading from Telegram API: ${telegramError}. Trying alternative methods...`, "warn");
        
        // Try to use ImgBB as a fallback if we have an API key
        if (process.env.IMGBB_API_KEY) {
          log(`[BRIDGE] Attempting to get photo directly from user state...`);
          
          try {
            // IMPROVEMENT: Get latest message with this file ID from database
            // Fetch more messages to increase chance of finding the attachment
            const allMessages = await storage.getRecentMessages(50);
            const messagesWithAttachments = allMessages.filter((msg: Message) => 
              msg.platform === 'telegram' && 
              msg.attachments && 
              Array.isArray(msg.attachments) && 
              msg.attachments.some(att => att === fileId || (typeof att === 'string' && att.includes(fileId)))
            );
            
            if (messagesWithAttachments.length > 0) {
              const message = messagesWithAttachments[0];
              log(`[BRIDGE] Found message with matching file ID: ${message.id}`);
              
              if (message.rawAttachmentData) {
                try {
                  // Try to parse the raw attachment data
                  const attachmentData = JSON.parse(message.rawAttachmentData);
                  if (attachmentData.buffer || attachmentData.data) {
                    // Convert base64 to buffer if needed (support both buffer and data fields)
                    const base64Data = attachmentData.buffer || attachmentData.data;
                    const rawBuffer = Buffer.from(base64Data, 'base64');
                    const validatedBuffer = await this.validateAndProcessImage(rawBuffer, "processTelegramToDiscord-fallback");
                    
                    if (validatedBuffer) {
                      log(`[BRIDGE] Successfully recovered image from message attachment data, size: ${validatedBuffer.length} bytes`);
                      return validatedBuffer;
                    }
                  }
                } catch (parseError) {
                  log(`[BRIDGE] Error parsing raw attachment data: ${parseError}`, "error");
                }
              }
            }
            
            // IMPROVEMENT: Try to direct upload the original Telegram photo to ImgBB
            try {
              // Create a simple image with a link to view the original
              const imageNotAvailableText = `🖼️ Image from Telegram\n\nFile ID: ${fileId.substring(0, 20)}...\n\nOriginal photo is available in Telegram`;
              
              // We'll upload this image directly to ImgBB, which needs raw image data
              const canvas = require('canvas');
              const canv = canvas.createCanvas(600, 300);
              const ctx = canv.getContext('2d');
              
              // Draw background
              ctx.fillStyle = '#f8f9fa';
              ctx.fillRect(0, 0, 600, 300);
              
              // Draw text
              ctx.fillStyle = '#333';
              ctx.font = '24px Arial';
              ctx.fillText('Image from Telegram', 30, 50);
              
              ctx.font = '16px Arial';
              ctx.fillText(`Unable to process directly`, 30, 90);
              
              // Convert to buffer
              const imgBuffer = canv.toBuffer('image/png');
              
              // Upload to ImgBB
              log(`[BRIDGE] Attempting direct ImgBB upload...`);
              const imgUrl = await uploadToImgbb(imgBuffer);
              
              if (imgUrl) {
                log(`[BRIDGE] Successfully uploaded image to ImgBB: ${imgUrl}`);
                
                // Now download from ImgBB to get the correct format
                const response = await fetch(imgUrl);
                if (response.ok) {
                  const buffer = Buffer.from(await response.arrayBuffer());
                  const validatedBuffer = await this.validateAndProcessImage(buffer, "processTelegramToDiscord-imgbb");
                  
                  if (validatedBuffer) {
                    log(`[BRIDGE] Successfully downloaded from ImgBB, size: ${validatedBuffer.length} bytes`);
                    // Cache this for future use
                    this.setCachedImage(cacheKey, { buffer: validatedBuffer });
                    return validatedBuffer;
                  }
                }
              }
            } catch (canvasError) {
              log(`[BRIDGE] Error creating image with canvas: ${canvasError}`, "error");
              
              // Fallback to simple SVG if canvas fails
              try {
                // Create an SVG as a fallback for simple image
                const svgImage = Buffer.from(`
                  <svg width="400" height="200" xmlns="http://www.w3.org/2000/svg">
                    <rect width="400" height="200" fill="#f0f0f0"/>
                    <text x="200" y="80" font-family="Arial" font-size="18" text-anchor="middle" fill="#333">
                      Image from Telegram
                    </text>
                    <text x="200" y="120" font-family="Arial" font-size="14" text-anchor="middle" fill="#666">
                      (Unable to process directly)
                    </text>
                  </svg>
                `);
                
                // Try to upload to ImgBB
                const imgUrl = await uploadToImgbb(svgImage);
                if (imgUrl) {
                  log(`[BRIDGE] Created SVG image and uploaded to ImgBB: ${imgUrl}`);
                  
                  // Now download from ImgBB
                  const response = await fetch(imgUrl);
                  if (response.ok) {
                    const buffer = Buffer.from(await response.arrayBuffer());
                    const validatedBuffer = await this.validateAndProcessImage(buffer, "processTelegramToDiscord-imgbb-svg");
                    
                    if (validatedBuffer) {
                      log(`[BRIDGE] Successfully downloaded from ImgBB (SVG), size: ${validatedBuffer.length} bytes`);
                      return validatedBuffer;
                    }
                  }
                }
              } catch (svgError) {
                log(`[BRIDGE] Error with SVG fallback: ${svgError}`, "error");
              }
            }
          } catch (fallbackError) {
            log(`[BRIDGE] Error in fallback image processing: ${fallbackError}`, "error");
          }
        }
        
        // Re-throw the original error if all fallbacks fail
        throw telegramError;
      }
    } catch (error) {
      handleBridgeError(error as BridgeError, "processTelegramToDiscord");
      return null;
    }
  }

  private async processDiscordToTelegram(url: string): Promise<Buffer | null> {
    try {
      // Try cache first
      const cacheKey = `discord_${url}`;
      const cached = this.getCachedImage(cacheKey);
      if (cached?.buffer) {
        log(`Using cached buffer for Discord URL ${url}`);
        return cached.buffer;
      }

      // Use Promise.race to implement timeout
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Download timeout')), 30000)
      );

      const response = await Promise.race([
        fetch(url),
        timeoutPromise
      ]) as Response;

      if (!response.ok) {
        throw new BridgeError(`Failed to fetch Discord image: ${response.status}`, { context: "processDiscordToTelegram" });
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const validatedBuffer = await this.validateAndProcessImage(buffer, "processDiscordToTelegram");
      if (!validatedBuffer) {
        return null;
      }

      // Cache the result
      this.setCachedImage(cacheKey, { buffer: validatedBuffer });

      return validatedBuffer;
    } catch (error) {
      handleBridgeError(error as BridgeError, "processDiscordToTelegram");
      return null;
    }
  }
  private startHealthCheck() {
    // Run health check every 15 minutes (matching Telegram bot's heartbeat)
    this.healthCheckInterval = setInterval(async () => {
      try {
        const health = await this.healthCheck();
        if (!health.telegram || !health.discord) {
          log("Bot disconnected, attempting to reconnect...");
          // Add delay before reconnection attempt
          await new Promise(resolve => setTimeout(resolve, 5000));
          await this.reconnectDisconnectedBots(health);
        }
      } catch (error) {
        handleBridgeError(error as BridgeError, "healthCheck");
      }
    }, 900000); // 15 minutes to match Telegram bot's heartbeat
  }

  async start() {
    log("Starting bots...");
    try {
      // Reset the disabled state when attempting to start
      this.isDisabled = false;
      this.disabledReason = '';
      
      // Record start timestamp for uptime tracking
      this.startTimestamp = Date.now();
      
      // Start both bots with Promise.allSettled to continue even if one fails
      const results = await Promise.allSettled([
        this.startBotWithRetry(
          () => this.telegramBot.start(),
          "Telegram"
        ),
        this.startBotWithRetry(
          () => this.discordBot.start(),
          "Discord"
        )
      ]);
      
      // Check for failures and log them
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length > 0) {
        log(`${failures.length} bot(s) failed to start`, "warn");
        
        // Log each failure
        failures.forEach((failure, index) => {
          if (failure.status === 'rejected') {
            log(`Bot startup failure ${index + 1}: ${failure.reason}`, "error");
          }
        });
        
        // If all bots failed, throw an error
        if (failures.length === results.length) {
          throw new Error("All bots failed to start");
        }
      }
      
      log("Bots initialization completed");
    } catch (error) {
      handleBridgeError(error as BridgeError, "start");
      throw error; // Re-throw to allow caller to handle
    }
  }

  private async startBotWithRetry(
    startFn: () => Promise<void>,
    botName: string
  ): Promise<void> {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        // Add significant delay between attempts
        if (attempt > 1) {
          log(`Waiting ${this.retryTimeout / 1000} seconds before attempt ${attempt}...`);
          await new Promise(resolve => setTimeout(resolve, this.retryTimeout));
        }

        log(`Starting ${botName} bot (attempt ${attempt}/${this.maxRetries})...`);
        await startFn();

        this.retryAttempts = 0; // Reset on success
        log(`${botName} bot started successfully`);
        return;
      } catch (error) {
        handleBridgeError(error as BridgeError, `startBotWithRetry-${botName}-${attempt}`);

        if (attempt === this.maxRetries) {
          log(`${botName} bot failed to start after ${this.maxRetries} attempts`, "error");
          throw error;
        }

        // Add longer delay after failure
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  // Restart only the Discord bot
  async restartDiscordBot() {
    log("Restarting Discord bot with new configuration...");
    try {
      // Gracefully stop the Discord bot
      await this.discordBot.stop();
      
      // Add a small delay before creating a new instance
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Create new instance with updated token
      this.discordBot = new DiscordBot(this);
      
      // Start the Discord bot
      await this.discordBot.start();
      
      log("Discord bot restarted successfully");
    } catch (error) {
      handleBridgeError(error as BridgeError, "restartDiscordBot");
      throw error;
    }
  }
  
  // Restart only the Telegram bot
  async restartTelegramBot() {
    log("Restarting Telegram bot with new configuration...");
    try {
      // Gracefully stop the Telegram bot
      await this.telegramBot.stop();
      
      // Add a small delay before creating a new instance
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Create new instance with updated token
      this.telegramBot = new TelegramBot(this);
      
      // Start the Telegram bot
      await this.telegramBot.start();
      
      log("Telegram bot restarted successfully");
    } catch (error) {
      handleBridgeError(error as BridgeError, "restartTelegramBot");
      throw error;
    }
  }

  async restart() {
    log("Restarting all bots with new configuration...");
    try {
      // Clear health check interval
      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = null;
      }

      // Stop both bots with graceful shutdown
      await Promise.allSettled([
        this.telegramBot.stop(),
        this.discordBot.stop()
      ]);

      // Add longer delay before creating new instances
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Create new instances with updated tokens
      this.telegramBot = new TelegramBot(this);
      this.discordBot = new DiscordBot(this);

      // Start both bots with retry mechanism
      await this.start();

      // Restart health check
      this.startHealthCheck();

      log("All bots restarted successfully");
    } catch (error) {
      handleBridgeError(error as BridgeError, "restart");
      throw error;
    }
  }

  private async reconnectDisconnectedBots(health: { telegram: boolean; discord: boolean }) {
    try {
      if (!health.telegram) {
        log("Attempting to reconnect Telegram bot...");
        // Add longer delay before reconnection
        await new Promise(resolve => setTimeout(resolve, 5000));
        await this.startBotWithRetry(() => this.telegramBot.start(), "Telegram");
      }
      if (!health.discord) {
        log("Attempting to reconnect Discord bot...");
        await this.startBotWithRetry(() => this.discordBot.start(), "Discord");
      }
    } catch (error) {
      handleBridgeError(error as BridgeError, "reconnectDisconnectedBots");
      throw error;
    }
  }

  async healthCheck(): Promise<{
    telegram: boolean;
    discord: boolean;
    revolt?: boolean;
    activeProvider: string;
    disabled?: boolean;
    disabledReason?: string;
    uptime?: number;
  }> {
    try {
      // Get the active provider from config
      let activeProvider = 'discord';
      try {
        const config = await storage.getBotConfig();
        if (config?.activeProvider) {
          activeProvider = config.activeProvider;
        }
      } catch (configError) {
        log(`Error getting active provider: ${configError}`, "warn");
      }
      
      // Return early if bridge is disabled
      if (this.isDisabled) {
        return {
          telegram: false,
          discord: false,
          revolt: false,
          activeProvider,
          disabled: true,
          disabledReason: this.disabledReason || "Bridge is disabled"
        };
      }
      
      // Calculate uptime if available
      let uptime = undefined;
      if (this.startTimestamp) {
        uptime = Math.floor((Date.now() - this.startTimestamp) / 1000);
      }
      
      // Add slight delay to prevent rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Check status of each platform
      const telegramConnected = this.telegramBot.getIsConnected();
      const discordConnected = this.discordBot.isReady();
      const revoltConnected = this.revoltBot?.isReady() || false;
      
      return {
        telegram: telegramConnected,
        discord: discordConnected,
        revolt: revoltConnected,
        activeProvider,
        uptime
      };
    } catch (error) {
      handleBridgeError(error as BridgeError, "healthCheck");
      return {
        telegram: false,
        discord: false,
        revolt: false,
        activeProvider: 'discord',
        disabled: this.isDisabled,
        disabledReason: this.isDisabled ? this.disabledReason : "Health check error"
      };
    }
  }
  
  /**
   * Mark this bridge as disabled with a reason
   * This is used when the bridge fails to initialize after multiple attempts
   * to ensure the API doesn't crash when bridge operations are attempted
   */
  markAsDisabled(reason: string): void {
    this.isDisabled = true;
    this.disabledReason = reason;
    log(`Bridge has been marked as disabled: ${reason}`, "warn");
  }
  
  /**
   * Cleanup Telegram connections when we detect a 409 Conflict error
   * This can happen during deployment when multiple instances are running
   */
  async cleanupTelegramConnections(): Promise<void> {
    try {
      log("Attempting to clean up Telegram connections...", "info");
      
      // Safely stop the Telegram bot if it exists
      if (this.telegramBot) {
        try {
          await this.telegramBot.stop();
          log("Telegram bot stopped successfully during cleanup", "info");
        } catch (stopError) {
          log(`Error stopping Telegram bot during cleanup: ${stopError}`, "error");
        }
      }
      
      // Force garbage collection if available (Node.js with --expose-gc flag)
      if (global.gc) {
        try {
          global.gc();
          log("Forced garbage collection to clean up stale connections", "info");
        } catch (gcError) {
          log(`Error during forced garbage collection: ${gcError}`, "error");
        }
      }
      
      // Add a delay to allow external connections to terminate
      log("Waiting for external connections to terminate...", "info");
      await new Promise(resolve => setTimeout(resolve, 10000)); // 10 second delay
      
      log("Telegram connection cleanup completed", "info");
    } catch (error) {
      log(`Error during Telegram connection cleanup: ${error}`, "error");
      throw error;
    }
  }

  /**
   * Send a system message to a Discord channel
   * Used for notifications about user actions that don't come from direct messages
   * @param channelId The Discord channel ID to send the message to
   * @param content The message content
   */
  async sendSystemMessageToDiscord(
    channelId: string, 
    content: string, 
    options?: { 
      showForceButton?: boolean, 
      telegramId?: string,
      ticketId?: number,
      username?: string
    }
  ): Promise<void> {
    try {
      if (!channelId) {
        throw new BridgeError("Missing Discord channel ID", { context: "sendSystemMessageToDiscord" });
      }

      if (!this.discordBot.isReady()) {
        throw new BridgeError("Discord bot is not ready", { context: "sendSystemMessageToDiscord" });
      }

      // Get the channel
      const channel = await this.discordBot.getChannelById(channelId);
      if (!channel || !(channel instanceof TextChannel)) {
        throw new BridgeError(`Invalid Discord channel: ${channelId}`, { context: "sendSystemMessageToDiscord" });
      }

      // Prepare components if showForceButton is true and we have telegramId and ticketId
      const components = (options?.showForceButton && options?.telegramId && options?.ticketId) 
        ? [
            {
              type: 1, // Action Row
              components: [
                {
                  type: 2, // Button
                  style: 1, // Primary
                  label: "Force Back to This Ticket",
                  custom_id: `force_ticket:${options.telegramId}:${options.ticketId}:${options.username || 'User'}`
                }
              ]
            }
          ] 
        : undefined;

      // Send the message using discord bot's sendMessage method with system webhook appearance
      await this.discordBot.sendMessage(channelId, {
        content: content,
        username: "System",
        avatarURL: "https://cdn.discordapp.com/embed/avatars/0.png", // Default system avatar
        components
      } as any, "System");

      log(`System message sent to Discord channel ${channelId}${components ? ' (with Force button)' : ''}`);
    } catch (error) {
      handleBridgeError(error as BridgeError, "sendSystemMessageToDiscord");
      // Don't throw the error to avoid disrupting the main flow
    }
  }

  async moveToTranscripts(ticketId: number): Promise<void> {
    try {
      // First verify the ticket still exists and has the expected status
      const ticket = await storage.getTicket(ticketId);
      log(`[BRIDGE] Moving ticket to transcripts. Ticket data:`, JSON.stringify(ticket, null, 2));

      if (!ticket) {
        throw new BridgeError(`Ticket not found: ${ticketId}`, { context: "moveToTranscripts" });
      }
      
      // Check if the ticket has a Discord channel ID
      if (!ticket.discordChannelId) {
        log(`[BRIDGE] Ticket ${ticketId} has no Discord channel ID, cannot move to transcripts`);
        throw new BridgeError(`Ticket ${ticketId} has no Discord channel ID`, { context: "moveToTranscripts" });
      }

      // Get the category for the transcript category ID
      const category = await storage.getCategory(ticket.categoryId!);
      log(`[BRIDGE] Category data for ticket:`, JSON.stringify(category, null, 2));

      // Validate that the category exists
      if (!category) {
        throw new BridgeError(`Category not found for ticket: ${ticketId}`, { context: "moveToTranscripts" });
      }

      // Get available Discord categories for debugging
      try {
        const availableCategories = await this.discordBot.getCategories();
        log(`[BRIDGE] Available Discord categories:`, JSON.stringify(availableCategories, null, 2));
      } catch (categoriesError) {
        log(`[BRIDGE] Error getting available Discord categories: ${categoriesError}`, "warn");
        // Continue execution, this is just for debugging
      }

      // Validate that the category has a transcript category ID
      if (!category.transcriptCategoryId) {
        log(`[BRIDGE] No transcript category ID found for category ${category.id}`);
        throw new BridgeError(`No transcript category set for service: ${category.name}. Please set it in the dashboard.`, { context: "moveToTranscripts" });
      }

      if (category.transcriptCategoryId.trim() === '') {
        log(`[BRIDGE] Empty transcript category ID for category ${category.id}`);
        throw new BridgeError(`No transcript category set for service: ${category.name}. Please set it in the dashboard.`, { context: "moveToTranscripts" });
      }

      log(`[BRIDGE] Moving channel ${ticket.discordChannelId} to transcript category ${category.transcriptCategoryId}`);

      // Try to move the channel to the transcripts category
      await this.discordBot.moveChannelToCategory(
        ticket.discordChannelId,
        category.transcriptCategoryId,
        true // Specify this is a transcript category for proper permissions
      );

      // Update the ticket status to "closed" (even though it might already be closed)
      await storage.updateTicketStatus(ticket.id, "closed");

      log(`[BRIDGE] Successfully moved ticket ${ticketId} to transcripts category ${category.transcriptCategoryId}`);
    } catch (error) {
      handleBridgeError(error as BridgeError, "moveToTranscripts");
      
      // Check if this is due to Discord channel no longer existing
      if (error instanceof Error && error.message.includes('Unknown Channel')) {
        log(`[BRIDGE] Discord channel for ticket ${ticketId} no longer exists, just updating status`);
        try {
          await storage.updateTicketStatus(ticketId, "closed");
          log(`[BRIDGE] Successfully updated ticket ${ticketId} status to closed`);
        } catch (statusUpdateError) {
          log(`[BRIDGE] Error updating ticket status: ${statusUpdateError}`, "error");
        }
      }
      
      throw error;
    }
  }
  
  async moveFromTranscripts(ticketId: number): Promise<void> {
    try {
      const ticket = await storage.getTicket(ticketId);
      log(`Moving ticket from transcripts back to active. Ticket data:`, JSON.stringify(ticket, null, 2));

      if (!ticket || !ticket.discordChannelId) {
        throw new BridgeError(`Invalid ticket or missing Discord channel: ${ticketId}`, { context: "moveFromTranscripts" });
      }

      // Get category info
      const category = await storage.getCategory(ticket.categoryId!);
      log(`Category data for ticket:`, JSON.stringify(category, null, 2));

      if (!category) {
        throw new BridgeError("Category not found", { context: "moveFromTranscripts" });
      }

      // Check if category has a Discord category ID
      if (!category.discordCategoryId) {
        log(`No Discord category ID found for category ${category.id}`);
        throw new BridgeError("No Discord category set for this service", { context: "moveFromTranscripts" });
      }

      if (category.discordCategoryId.trim() === '') {
        log(`Empty Discord category ID for category ${category.id}`);
        throw new BridgeError("No Discord category set for this service", { context: "moveFromTranscripts" });
      }

      log(`Moving channel ${ticket.discordChannelId} back to category ${category.discordCategoryId}`);

      // Move channel back to original category
      // Setting isTranscriptCategory to false will apply the appropriate permissions
      await this.discordBot.moveChannelToCategory(
        ticket.discordChannelId,
        category.discordCategoryId,
        false  // Specify this is NOT a transcript category for proper permissions
      );

      // Update ticket status
      await storage.updateTicketStatus(ticket.id, "open");

      log(`Successfully moved ticket ${ticketId} back to category ${category.discordCategoryId}`);
    } catch (error) {
      handleBridgeError(error as BridgeError, "moveFromTranscripts");
      throw error;
    }
  }

  async createTicketChannel(ticket: Ticket) {
    if (!ticket.categoryId) {
      throw new BridgeError("Ticket must have a category", { context: "createTicketChannel" });
    }

    const category = await storage.getCategory(ticket.categoryId);
    if (!category) {
      throw new BridgeError("Category not found", { context: "createTicketChannel" });
    }

    if (!ticket.userId) {
      throw new BridgeError("Ticket must have a user", { context: "createTicketChannel" });
    }

    const user = await storage.getUser(ticket.userId);
    if (!user) {
      throw new BridgeError("User not found", { context: "createTicketChannel" });
    }

    const tickets = await storage.getTicketsByCategory(ticket.categoryId);
    const ticketCount = tickets.length;
    const channelName = `${category.name.toLowerCase()}-${ticketCount + 1}`;

    log(`Creating ticket channel: ${channelName}`);

    try {
      // Ensure category.discordCategoryId is not null
      if (!category.discordCategoryId) {
        throw new BridgeError("Discord category ID is missing", { context: "createTicketChannel" });
      }
      
      // Create Discord channel
      const channelId = await this.discordBot.createTicketChannel(
        category.discordCategoryId,
        channelName
      );
      log(`Discord channel created with ID: ${channelId}`);

      // Update ticket with Discord channel ID
      await storage.updateTicketDiscordChannel(ticket.id, channelId);

      const updatedTicket = await storage.getTicket(ticket.id);
      log(`Updated ticket status: ${JSON.stringify(updatedTicket)}`);

      // Send only one embed for the ticket creation with pinning
      const embed = {
        username: "Ticket Bot",
        embeds: [{
          title: "🎫 New Ticket",
          description: "A new support ticket has been created",
          color: 0x5865F2,
          fields: category.questions.map((question, index) => ({
            name: question,
            value: `\`${ticket.answers?.[index] || 'No answer provided'}\``,
            inline: false
          }))
        }]
      };

      // Send and pin the ticket message
      await this.discordBot.sendTicketMessage(channelId, embed);

      // Send role ping if category has a role
      if (category.discordRoleId) {
        await this.pingRoleForCategory(ticket.categoryId, channelId);
      }

      log(`Ticket channel created: ${channelName}`);
    } catch (error) {
      handleBridgeError(error as BridgeError, "createTicketChannel");

      // Check if error is due to channel limit
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('Maximum number of channels in category') ||
        errorMessage.includes('channel limit')) {
        // Update ticket status to pending
        await storage.updateTicketStatus(ticket.id, "pending");
        throw new BridgeError("Category is at maximum channel limit. Please try again later or contact an administrator.", { context: "createTicketChannel" });
      }

      // For other errors, mark ticket as open but without channel
      await storage.updateTicketStatus(ticket.id, "open");
      throw error;
    }
  }

  /**
   * Send a direct message to a Telegram user by their Telegram ID
   * Used for system notifications, ticket updates, etc.
   */
  async sendMessageToTelegram(telegramId: number, message: string): Promise<void> {
    try {
      if (!this.telegramBot) {
        throw new BridgeError("Telegram bot is not ready", { context: "sendMessageToTelegram" });
      }

      // Check if the telegramId is valid
      if (!telegramId || isNaN(telegramId) || telegramId <= 0) {
        throw new BridgeError(`Invalid Telegram user ID: ${telegramId}`, { context: "sendMessageToTelegram" });
      }

      // Send message to Telegram user directly
      log(`Sending direct message to Telegram user ${telegramId}`, "debug");
      await this.telegramBot.sendMessage(telegramId, message);
    } catch (error) {
      log(`Error sending message to Telegram: ${error}`, "error");
      handleBridgeError(error as BridgeError, "sendMessageToTelegram");
      throw error; // Re-throw the error so it can be handled by the caller
    }
  }

  async forwardToTelegram(content: string, ticketId: number, username: string, attachments?: any[]) {
    try {
      // Clean Discord mentions from the content before sending to Telegram
      // This prevents <@1234567890> format mentions from being forwarded
      let cleanedContent = content;
      
      // Remove Discord user mentions (<@1234567890>) completely
      cleanedContent = cleanedContent.replace(/<@!?(\d+)>/g, "");
      
      // Remove Discord role mentions (<@&1234567890>) completely
      cleanedContent = cleanedContent.replace(/<@&(\d+)>/g, "");
      
      // Remove Discord channel mentions (<#1234567890>) completely  
      cleanedContent = cleanedContent.replace(/<#(\d+)>/g, "");
      
      // Trim any extra whitespace that might be left after removing mentions
      cleanedContent = cleanedContent.replace(/\s+/g, " ").trim();
      
      console.log(`[FORWARD_TO_TG] Original content: "${content}"`);
      console.log(`[FORWARD_TO_TG] Cleaned content: "${cleanedContent}"`);
      
      // Use the cleaned content for the message, but keep original for deduplication
      const contentForKey = content.length <= 50 ? content : content.substring(0, 50);
      
      // Remove timestamp from deduplication key to better catch duplicates sent rapidly
      // Instead, use fixed window time-based deduplication
      
      // Use content hash to better detect identical messages
      const contentHash = crypto
        .createHash('md5')
        .update(content)
        .digest('hex')
        .substring(0, 8);
      
      // Add attachments info to the key
      const attachmentInfo = attachments ? `${attachments.length}:${JSON.stringify(attachments).length}` : '0';
      
      // Create a more robust deduplication key without timestamp component
      const dedupKey = `tg:${ticketId}:${contentHash}:${contentForKey}:${attachmentInfo}:${username}`;
      const now = Date.now();
      
      if (this.ENABLE_DEDUP_LOGGING) {
        log(`[DEDUP] Generated key for Telegram: ${dedupKey}`, "debug");
      }
      
      // Check if this message was recently sent
      if (this.messageDedupCache.has(dedupKey)) {
        const lastSent = this.messageDedupCache.get(dedupKey);
        if (now - lastSent! < this.messageDedupWindow) {
          log(`Skipping duplicate message to Telegram within ${this.messageDedupWindow}ms window: ${contentForKey.substring(0, 20)}...`, "warn");
          return;
        }
      }
      
      // Update deduplication cache
      this.messageDedupCache.set(dedupKey, now);
      
      // Clean old entries from dedup cache if it gets too large
      if (this.messageDedupCache.size > this.MAX_DEDUP_CACHE_SIZE) {
        const expireTime = now - this.messageDedupWindow;
        let cleanedCount = 0;
        
        for (const [key, timestamp] of this.messageDedupCache.entries()) {
          if (timestamp < expireTime) {
            this.messageDedupCache.delete(key);
            cleanedCount++;
          }
          
          // If we've cleaned at least 20% of the cache, stop
          if (cleanedCount >= this.MAX_DEDUP_CACHE_SIZE * 0.2) break;
        }
        
        log(`Cleaned ${cleanedCount} entries from message deduplication cache`);
      }
      
      const ticket = await storage.getTicket(ticketId);
      log(`Forwarding to Telegram - Ticket: ${JSON.stringify(ticket)}`);

      if (!ticket || !ticket.userId) {
        log(`Invalid ticket or missing user ID: ${ticketId}`, "error");
        return;
      }

      const user = await storage.getUser(ticket.userId);
      log(`Found user: ${JSON.stringify(user)}`);

      if (!user || !user.telegramId) {
        log(`Invalid user or missing Telegram ID for ticket: ${ticketId}`, "error");
        return;
      }

      if (!user.telegramId.match(/^\d+$/)) {
        log(`Invalid Telegram ID format for user: ${user.id}`, "error");
        return;
      }

      // Handle attachments if present
      if (attachments && attachments.length > 0) {
        // Store message with attachment indication
        await storage.createMessage({
          ticketId,
          content: content || "Image sent",
          authorId: user.id,
          platform: "discord",
          timestamp: new Date(),
          senderName: username
        });

        // Send text content if any
        if (content?.trim()) {
          await this.telegramBot.sendMessage(parseInt(user.telegramId), `${username}: ${cleanedContent}`);
        }

        // Process each attachment
        for (const attachment of attachments) {
          if (attachment.url) {
            try {
              const cacheKey = attachment.url;
              const cachedImage = this.getCachedImage(cacheKey);

              if (cachedImage?.telegramFileId) {
                log(`Using cached Telegram fileId for ${attachment.url}`);
                await this.telegramBot.sendCachedPhoto(parseInt(user.telegramId), cachedImage.telegramFileId, `Image from ${username}`);
                continue;
              }

              log(`Processing Discord attachment: ${attachment.url}`);
              const buffer = await this.processDiscordToTelegram(attachment.url);
              if (!buffer) {
                throw new BridgeError("Failed to process image", { context: "forwardToTelegram" });
              }
              log(`Successfully processed image, size: ${buffer.length} bytes`);

              const caption = `Image from ${username}`;
              const fileId = await this.telegramBot.sendPhoto(parseInt(user.telegramId), buffer, caption);

              if (fileId) {
                this.setCachedImage(cacheKey, { telegramFileId: fileId, buffer });
              }

              log(`Successfully sent photo to Telegram user ${user.telegramId}`);
            } catch (error) {
              handleBridgeError(error as BridgeError, "forwardToTelegram-attachment");
            }
          }
        }
        return;
      }

      // Handle text messages with image URLs
      const imageUrlMatch = content.match(/(https?:\/\/[^\s]+\.(jpg|jpeg|png|gif))/i);
      if (imageUrlMatch) {
        const imageUrl = imageUrlMatch[0];
        const textContent = content.replace(imageUrl, '').trim();

        // Store message
        await storage.createMessage({
          ticketId,
          content: textContent || "Image sent",
          authorId: user.id,
          platform: "discord",
          timestamp: new Date(),
          senderName: username
        });

        // Send text if any
        if (textContent) {
          // Clean Discord mentions from the content - remove completely
          let cleanedTextContent = textContent
            .replace(/<@!?(\d+)>/g, "")
            .replace(/<@&(\d+)>/g, "")
            .replace(/<#(\d+)>/g, "")
            .replace(/\s+/g, " ").trim();
          
          await this.telegramBot.sendMessage(parseInt(user.telegramId), `${username}: ${cleanedTextContent}`);
        }

        // Process and send the image
        try {
          const cacheKey = imageUrl;
          const cachedImage = this.getCachedImage(cacheKey);

          if (cachedImage?.telegramFileId) {
            log(`Using cached Telegram fileId for ${imageUrl}`);
            await this.telegramBot.sendCachedPhoto(parseInt(user.telegramId), cachedImage.telegramFileId, `Image from ${username}`);
            return;
          }

          log(`Processing Discord image URL: ${imageUrl}`);
          const buffer = await this.processDiscordToTelegram(imageUrl);
          if (!buffer) {
            throw new BridgeError("Failed to process image", { context: "forwardToTelegram" });
          }
          log(`Successfully processed image, size: ${buffer.length} bytes`);

          const fileId = await this.telegramBot.sendPhoto(parseInt(user.telegramId), buffer, `Image from ${username}`);

          if (fileId) {
            this.setCachedImage(cacheKey, { telegramFileId: fileId, buffer });
          }

          log(`Successfully sent photo to Telegram user ${user.telegramId}`);
        } catch (error) {
          handleBridgeError(error as BridgeError, "forwardToTelegram-image");
        }
      } else {
        // Regular text message handling
        await storage.createMessage({
          ticketId,
          content,
          authorId: user.id,
          platform: "discord",
          timestamp: new Date(),
          senderName: username
        });
        // Clean Discord mentions in the content - remove completely
        let cleanedContent = content
          .replace(/<@!?(\d+)>/g, "")
          .replace(/<@&(\d+)>/g, "")
          .replace(/<#(\d+)>/g, "")
          .replace(/\s+/g, " ").trim();
          
        await this.telegramBot.sendMessage(parseInt(user.telegramId), `${username}: ${cleanedContent}`);
      }

      log(`Successfully sent message to Telegram user: ${user.username}`);
    } catch (error) {
      handleBridgeError(error as BridgeError, "forwardToTelegram");
    }
  }

  async forwardToDiscord(content: string, ticketId: number, username: string, avatarUrl?: string, photo?: string, firstName?: string, lastName?: string, telegramId?: number) {
    try {
      // Create a more robust deduplication key using content hash and context
      // For short content, use the full content, otherwise use a limited substring to avoid key size issues
      const contentForKey = content.length <= 50 ? content : content.substring(0, 50);
      
      // Remove timestamp from deduplication key to better catch duplicates sent rapidly
      // Instead, use fixed window time-based deduplication
      
      // Use content hash to better detect identical messages
      const contentHash = crypto
        .createHash('md5')
        .update(content)
        .digest('hex')
        .substring(0, 8);
        
      // Add photo information to the key
      const photoInfo = photo ? 'photo:' + photo.substring(0, 10) : 'text';
      
      // Create a more robust deduplication key without timestamp component
      const dedupKey = `dc:${ticketId}:${contentHash}:${contentForKey}:${photoInfo}:${username}`;
      const now = Date.now();
      
      if (this.ENABLE_DEDUP_LOGGING) {
        log(`[DEDUP] Generated key for Discord: ${dedupKey}`, "debug");
      }
      
      // Check if this message was recently sent - temporarily disabled for debugging
      // if (this.messageDedupCache.has(dedupKey)) {
      //   const lastSent = this.messageDedupCache.get(dedupKey);
      //   if (now - lastSent! < this.messageDedupWindow) {
      //     log(`Skipping duplicate message to Discord within ${this.messageDedupWindow}ms window: ${contentForKey.substring(0, 20)}...`, "warn");
      //     return;
      //   }
      // }
      
      log(`DEBUG: Processing message to Discord, bypassing dedup. Key was: ${dedupKey}`, "warn");
      
      // Update deduplication cache - temporarily disabled
      // this.messageDedupCache.set(dedupKey, now);
      
      // Clean old entries from dedup cache if it gets too large
      if (this.messageDedupCache.size > this.MAX_DEDUP_CACHE_SIZE) {
        const expireTime = now - this.messageDedupWindow;
        let cleanedCount = 0;
        
        for (const [key, timestamp] of this.messageDedupCache.entries()) {
          if (timestamp < expireTime) {
            this.messageDedupCache.delete(key);
            cleanedCount++;
          }
          
          // If we've cleaned at least 20% of the cache, stop
          if (cleanedCount >= this.MAX_DEDUP_CACHE_SIZE * 0.2) break;
        }
        
        log(`Cleaned ${cleanedCount} entries from message deduplication cache`);
      }
      
      const ticket = await storage.getTicket(ticketId);
      log(`Forwarding to Discord - Ticket: ${JSON.stringify(ticket)}`);

      if (!ticket) {
        throw new BridgeError(`Invalid ticket: ${ticketId}`, { context: "forwardToDiscord" });
      }
      
      if (!ticket.discordChannelId) {
        // Handle pending tickets that don't have channels yet
        if (ticket.status === 'pending') {
          log(`Ticket ${ticketId} is in pending state, storing message but not forwarding to Discord`, "warn");
          // We've already stored the message in the database in the handler
          return;
        } else {
          throw new BridgeError(`Missing Discord channel for ticket: ${ticketId} with status: ${ticket.status}`, { context: "forwardToDiscord" });
        }
      }

      const displayName = [firstName, lastName]
        .filter(Boolean)
        .join(' ') || username;

      if (photo) {
        try {
          // Process the image first
          const buffer = await this.processTelegramToDiscord(photo);
          if (!buffer) {
            throw new BridgeError("Failed to process image", { context: "forwardToDiscord" });
          }

          // Only send a separate text message if we have actual content
          // This prevents sending "Image sent" placeholder text
          if (content?.trim()) {
            await this.discordBot.sendMessage(
              ticket.discordChannelId,
              {
                content: content.toString().trim(),
                username: displayName,
                avatarURL: avatarUrl
              },
              displayName
            );
          }

          // Now send the actual image
          await this.forwardImageToDiscord(
            ticket.discordChannelId,
            buffer,
            null,
            displayName,
            avatarUrl
          );
          
          log(`Photo forwarded from Telegram to Discord for ticket ${ticketId}`);

        } catch (error) {
          handleBridgeError(error as BridgeError, "forwardToDiscord-photo");
          
          // If image processing failed, send a notification with the content
          try {
            // Create a message indicating photo was sent but couldn't be processed
            const photoNotification = content?.trim() 
              ? `${content.toString().trim()}\n\n(User sent a photo that couldn't be processed)`
              : "User sent a photo (couldn't be processed)";
              
            // Send the message with notification
            log(`Attempting to send message to Discord channel ${ticket.discordChannelId}`);
            
            const messageOptions = {
              content: photoNotification,
              username: displayName,
              avatarURL: avatarUrl
            };
            
            log(`Sending message with options: ${JSON.stringify({
              username: displayName,
              avatarURL: avatarUrl ? "avatarURL present" : "no avatar",
              content: photoNotification,
              files: "no files",
              embeds: "no embeds"
            })}`);
            
            await this.discordBot.sendMessage(
              ticket.discordChannelId,
              messageOptions,
              displayName
            );
            
            log(`Successfully sent message to Discord channel ${ticket.discordChannelId}`);
          } catch (secondaryError) {
            handleBridgeError(secondaryError as BridgeError, "forwardToDiscord-photo-fallback");
          }
        }
      } else {
        // Regular text message (no photo)
        // Get the ticket user info
        const user = await storage.getUser(ticket.userId!);
        
        // Don't add a Force Switch button to regular messages
        // The button will only be added to specific system messages about ticket switching
        const components = undefined;
          
        await this.discordBot.sendMessage(
          ticket.discordChannelId,
          {
            content: content ? content.toString().trim() : "\u200B",
            username: displayName,
            avatarURL: avatarUrl,
            components
          },
          displayName
        );
      }

      log(`Successfully forwarded message to Discord channel: ${ticket.discordChannelId}`);
    } catch (error) {
      handleBridgeError(error as BridgeError, "forwardToDiscord");
    }
  }


  async forwardPingToTelegram(ticketId: number, discordUsername: string) {
    try {
      console.log(`[PING] Processing ping from ${discordUsername} for ticket #${ticketId}`);
      
      const ticket = await storage.getTicket(ticketId);
      if (!ticket?.userId) {
        throw new BridgeError("Invalid ticket or missing user ID", { code: "INVALID_TICKET", context: "forwardPingToTelegram" });
      }

      const user = await storage.getUser(ticket.userId);
      if (!user?.telegramId) {
        throw new BridgeError("Could not find Telegram information for ticket creator", { code: "USER_NOT_FOUND", context: "forwardPingToTelegram" });
      }
      
      // Get category info for the message
      let categoryName = "Unknown service";
      let serviceName = "";
      if (ticket.categoryId) {
        const category = await storage.getCategory(ticket.categoryId);
        if (category) {
          categoryName = category.name;
          serviceName = ` in *${categoryName}*`;
        }
      }
      
      // Check if user is currently viewing a different ticket
      console.log(`[PING] Getting user state for telegramId: ${user.telegramId}`);
      let stateJson = await storage.getUserStateByTelegramId(user.telegramId);
      let userInDifferentTicket = false;
      let currentTicketId: number | undefined = undefined;
      let currentServiceName = "";
      
      if (stateJson) {
        try {
          const state = JSON.parse(stateJson);
          console.log(`[PING] User state: ${JSON.stringify(state)}`);
          
          // Check if user is in a different ticket
          if (state.activeTicketId && state.activeTicketId !== ticketId) {
            userInDifferentTicket = true;
            currentTicketId = state.activeTicketId;
            
            // Get current ticket category name
            if (state.categoryId) {
              const currentCategory = await storage.getCategory(state.categoryId);
              if (currentCategory) {
                currentServiceName = currentCategory.name;
              }
            }
            
            console.log(`[PING] User is currently in ticket #${currentTicketId} (${currentServiceName})`);
          } else if (state.activeTicketId === ticketId) {
            console.log(`[PING] User is already in this ticket #${ticketId}`);
          } else {
            console.log(`[PING] User doesn't have an active ticket in their state`);
          }
        } catch (stateError) {
          console.error(`[PING] Error parsing state: ${stateError}`);
        }
      } else {
        console.log(`[PING] No state found for user`);
      }
      
      // We're only sending this notification to the Telegram user, so it's OK to include their username for @ mentions
      // The mention ensures they get notified in Telegram's UI
      const telegramMention = user.telegramUsername ? `@${user.telegramUsername}` : '';
      // We add the mention in the message for Telegram notifications only - this is NEVER sent to Discord
      const usernameText = telegramMention ? ` ${telegramMention}` : '';
      
      // Different message format based on whether user is in a different ticket
      let message: string;
      if (userInDifferentTicket) {
        message = `🔔 *ATTENTION NEEDED*${usernameText}\n\n💬 A staff member is requesting your attention in *${categoryName}* (Ticket #${ticketId})\n\n⚠️ You are currently viewing *${currentServiceName}* (Ticket #${currentTicketId}).\n\n➡️ Use /switch to change to this ticket and respond.`;
      } else {
        message = `🔔 *ATTENTION NEEDED*${usernameText}\n\n💬 A staff member is requesting your attention in ticket #${ticketId}${serviceName}.\n\n➡️ Please respond as soon as possible.`;
      }

      // Send the message
      await this.telegramBot.sendMessage(
        parseInt(user.telegramId),
        message
      );

      log(`Successfully sent ping to Telegram user ${user.telegramId} for ticket #${ticketId}`);
    } catch (error) {
      handleBridgeError(error as BridgeError, "forwardPingToTelegram");
      throw error;
    }
  }

  /**
   * Force a user to switch back to a specific ticket
   * Used via Discord button or !forceswitch command
   * @param telegramId The Telegram ID of the user to force switch
   * @param ticketId The ticket ID to switch to
   */
  async forceUserTicketSwitch(telegramId: string, ticketId: number): Promise<{ alreadyInTicket: boolean }> {
    try {
      log(`Force switching user ${telegramId} to ticket ${ticketId}`, "info");
      
      // Validate inputs
      if (!telegramId || !ticketId) {
        throw new BridgeError("Missing required parameters", { 
          context: "forceUserTicketSwitch", 
          details: { telegramId, ticketId }
        });
      }
      
      // Get user by telegramId
      const user = await storage.getUserByTelegramId(telegramId);
      if (!user) {
        throw new BridgeError(`User not found with telegramId: ${telegramId}`, { 
          context: "forceUserTicketSwitch", 
          code: "USER_NOT_FOUND"
        });
      }
      
      // Get the ticket
      const ticket = await storage.getTicket(ticketId);
      if (!ticket) {
        throw new BridgeError(`Ticket not found with id: ${ticketId}`, { 
          context: "forceUserTicketSwitch", 
          code: "TICKET_NOT_FOUND"
        });
      }
      
      // Check that ticket belongs to this user
      if (ticket.userId !== user.id) {
        throw new BridgeError(`Ticket ${ticketId} does not belong to user ${telegramId}`, { 
          context: "forceUserTicketSwitch", 
          code: "INVALID_TICKET_USER"
        });
      }
      
      // Check if the ticket is active or paid
      const validStatuses = ["open", "in-progress", "pending", "paid"];
      const isPaidTicket = ticket.amount && ticket.amount > 0;
      
      console.log(`[FORCE_SWITCH] Checking ticket #${ticketId} status: "${ticket.status}" and amount: ${ticket.amount}`);
      
      // Ticket is considered active if:
      // 1. It has a valid status OR
      // 2. It's a paid ticket (amount > 0)
      if (!validStatuses.includes(ticket.status) && !isPaidTicket) {
        throw new BridgeError(`Ticket ${ticketId} is not active (status: ${ticket.status}) and is not paid`, { 
          context: "forceUserTicketSwitch", 
          code: "INVALID_TICKET_STATUS"
        });
      }
      
      // If this is a paid ticket, log that we're allowing access despite status
      if (isPaidTicket && !validStatuses.includes(ticket.status)) {
        console.log(`[FORCE_SWITCH] Allowing access to paid ticket #${ticketId} despite status "${ticket.status}"`);
      }
      
      // Fetch ticket category
      const category = await storage.getCategory(ticket.categoryId!);
      if (!category) {
        throw new BridgeError(`Category not found for ticket ${ticketId}`, { 
          context: "forceUserTicketSwitch", 
          code: "CATEGORY_NOT_FOUND"
        });
      }
      
      // Check if user is already in this ticket
      // First check memory state
      const telegramIdNum = parseInt(telegramId);
      if (isNaN(telegramIdNum)) {
        throw new BridgeError(`Invalid Telegram ID format: ${telegramId}`, { 
          context: "forceUserTicketSwitch" 
        });
      }
      
      // Get Telegram bot instance and check current user state
      const telegramBot = this.getTelegramBot();
      const currentState = telegramBot.getUserState(telegramIdNum);
      
      if (currentState && currentState.activeTicketId === ticketId) {
        log(`User ${telegramId} is already in ticket ${ticketId}, skipping force switch`, "info");
        return { alreadyInTicket: true };
      }
      
      // Create the user state for the switch
      const state = {
        activeTicketId: ticketId,
        categoryId: ticket.categoryId || 1,
        currentQuestion: 0,
        answers: [],
        inQuestionnaire: false,
        lastUpdated: Date.now()
        // Removed fromSwitchCommand flag to prevent duplicate ticket creation in same category
      };
      
      // Update state in memory 
      try {
        // Set the state in Telegram bot memory
        await telegramBot.setState(telegramIdNum, state);
        
        // Persist state to database
        await storage.saveUserState(user.id, telegramId, JSON.stringify(state));
        
        // Send notification to the Telegram user
        await this.sendMessageToTelegram(
          telegramIdNum, 
          `🔄 Staff has switched your active ticket to #${ticketId} (${category.name}).\nYou can switch to another ticket by using /switch`
        );
        
        // We'll skip sending a system message to the current channel here
        // because Discord.ts already handles sending a notification in the channel
        // when the button is clicked
        
        // Get all other active tickets for this user
        const otherTickets = await storage.getActiveTicketsByUserId(user.id);
        for (const otherTicket of otherTickets) {
          if (otherTicket.id !== ticketId && otherTicket.discordChannelId) {
            // In other channels, add the Force button to allow staff to force user back
            await this.sendSystemMessageToDiscord(
              otherTicket.discordChannelId,
              `**Note:** The user has been forced to switch to ticket #${ticketId} by staff.`,
              {
                showForceButton: true,
                telegramId: telegramId,
                ticketId: otherTicket.id, // Allow forcing back to THIS ticket
                username: user.telegramName || user.username
              }
            );
          }
        }
        
        log(`Successfully forced user ${telegramId} to switch to ticket ${ticketId}`, "info");
        return { alreadyInTicket: false };
      } catch (error) {
        throw new BridgeError(`Failed to set user state: ${error}`, { 
          context: "forceUserTicketSwitch",
          details: error
        });
      }
    } catch (error) {
      handleBridgeError(error as BridgeError, "forceUserTicketSwitch");
      throw error;
    }
  }

  async forwardPingToDiscord(ticketId: number, telegramUsername: string) {
    try {
      const ticket = await storage.getTicket(ticketId);
      if (!ticket?.categoryId) {
        throw new BridgeError("Invalid ticket or missing category", { code: "INVALID_TICKET", context: "forwardPingToDiscord" });
      }

      if (!ticket.discordChannelId) {
        throw new BridgeError("No Discord channel found for ticket", { code: "MISSING_CHANNEL", context: "forwardPingToDiscord" });
      }
      
      // Check if the ticket is claimed by a staff member
      if (ticket.claimedBy) {
        // Send notification to the staff member who claimed the ticket with proper mention
        try {
          console.log(`[PING] Pinging staff member ${ticket.claimedBy} for ticket #${ticketId}`);
          
          // Create a message that will properly ping the staff member
          await this.discordBot.sendMessage(
            ticket.discordChannelId,
            {
              content: `🔔 <@${ticket.claimedBy}> The user has requested your assistance in this ticket.`,
              // Use simplified format to avoid LSP errors
              username: "Ticket Bot"
            },
            "Ticket Bot"
          );
        } catch (error) {
          log(`Error sending ping to staff member: ${error}`, "error");
          // Fallback with a simpler message
          await this.discordBot.sendMessage(
            ticket.discordChannelId,
            {
              content: `🔔 <@${ticket.claimedBy}> The user has requested your assistance in this ticket.`,
              username: "Ticket Bot"
            },
            "Ticket Bot"
          );
        }
        
        log(`Successfully sent ping to staff member ${ticket.claimedBy} for ticket #${ticketId}`);
        return;
      }
      
      // No staff has claimed the ticket, ping the role
      const category = await storage.getCategory(ticket.categoryId);
      
      if (!category?.discordRoleId) {
        // No role ID set, just send a general message
        await this.discordBot.sendMessage(
          ticket.discordChannelId,
          {
            content: `🔔 **Attention:** The user has requested assistance in ticket #${ticketId}`,
            username: "Ticket Bot"
          },
          "Ticket Bot"
        );
        return;
      }

      // Send ping to the appropriate role
      await this.discordBot.sendMessage(
        ticket.discordChannelId,
        {
          content: `🔔 <@&${category.discordRoleId}> The user has requested assistance in ticket #${ticketId}`,
          username: "Ticket Bot"
        },
        "Ticket Bot"
      );

      log(`Successfully sent ping to Discord role ${category.discordRoleId} for ticket #${ticketId}`);
    } catch (error) {
      handleBridgeError(error as BridgeError, "forwardPingToDiscord");
      throw error;
    }
  }

  async pingRole(roleId: string, channelId: string, message?: string) {
    try {
      // Remove @ symbols and format for Discord mention
      const cleanRoleId = roleId.replace(/[@]/g, '');

      // Get channel from Discord client's cache
      const channel = this.discordBot.client.channels.cache.get(channelId) as TextChannel;
      if (channel?.isTextBased()) {
        // Send message as bot directly
        await channel.send({
          content: `<@&${cleanRoleId}>`
        });
        log(`Successfully pinged role ${cleanRoleId} in channel ${channelId}`);
      }
    } catch (error) {
      handleBridgeError(error as BridgeError, "pingRole");
    }
  }

  async pingRoleForCategory(categoryId: number, channelId: string): Promise<void> {
    try {
      const ticket = await storage.getTicketByDiscordChannel(channelId);
      if (!ticket) {
        log(`No ticket found for Discord channel ${channelId}`);
        return;
      }
      
      const category = await storage.getCategory(categoryId);
      
      // Check if ticket is claimed by someone
      if (ticket.claimedBy) {
        // Send a direct message to the person who claimed it
        const channel = this.discordBot.client.channels.cache.get(channelId) as TextChannel;
        if (channel?.isTextBased()) {
          await channel.send({
            content: `<@${ticket.claimedBy}> The user has pinged for assistance in this ticket.`
          });
          log(`Successfully pinged staff ${ticket.claimedBy} for ticket #${ticket.id}`);
        }
        return;
      }
      
      // Not claimed, ping role if available
      if (!category?.discordRoleId) {
        log(`No role ID found for category ${categoryId}`);
        // Still send a message to the channel
        const channel = this.discordBot.client.channels.cache.get(channelId) as TextChannel;
        if (channel?.isTextBased()) {
          await channel.send({
            content: `**Attention:** The user has requested assistance in this ticket.`
          });
        }
        return;
      }

      // Cache the role ID for future use
      const cleanRoleId = category.discordRoleId.replace(/[@]/g, '');
      this.roleCache.set(categoryId, cleanRoleId);

      // Get channel from Discord client's cache
      const channel = this.discordBot.client.channels.cache.get(channelId) as TextChannel;
      if (channel?.isTextBased()) {
        // Send message as bot directly with role ping
        await channel.send({
          content: `<@&${cleanRoleId}> The user has requested assistance in this ticket.`
        });
        log(`Successfully pinged role ${cleanRoleId} for category ${categoryId} in ticket #${ticket.id}`);
      }
    } catch (error) {
      handleBridgeError(error as BridgeError, "pingRoleForCategory");
    }
  }

  // Image processing methods
  async forwardImageToDiscord(channelId: string, buffer: Buffer, content: string | null, username: string, avatarUrl?: string): Promise<void> {
    try {
      // Generate unique ID for this image transfer for better logging
      const transferId = Date.now().toString(36) + Math.random().toString(36).substring(2, 5);
      log(`[${transferId}] Starting image transfer to Discord: ${buffer.length} bytes`);
      
      // Prepare base message data regardless of upload method
      const baseMessageData = {
        // Use empty string instead of invisible character to prevent extra newlines
        content: content ? content.toString().trim() : "",
        username,
        avatarURL: avatarUrl
      };
      
      // Check if image size is within reasonable limits (1KB to 10MB)
      if (buffer.length < 1024 || buffer.length > 10 * 1024 * 1024) {
        log(`[${transferId}] Image size outside acceptable range (${buffer.length} bytes), skipping ImgBB`, "warn");
        // Skip ImgBB attempt for extremely small or large images to avoid wasting API calls
        await this.sendDirectImageToDiscord(channelId, buffer, baseMessageData, username, transferId);
        return;
      }
      
      try {
        // Start ImgBB upload with retry and timeout
        log(`[${transferId}] Attempting ImgBB upload first...`);
        
        // Use improved uploadToImgbb with retry logic
        // Create a timer for overall timeout (different from internal retry timeouts)
        const uploadTimeout = 25000; // 25 seconds max total time
        
        // Set upload start time
        const uploadStart = Date.now();
        
        // Use a Promise.race between the upload and a timeout
        const timeoutPromise = new Promise<null>((_, reject) => {
          setTimeout(() => reject(new Error('ImgBB upload timeout (global)')), uploadTimeout);
        });
        
        // Start the upload process with retry capability (3 attempts, 2 second initial delay)
        const imageUrl = await Promise.race([
          uploadToImgbb(buffer, 3, 2000),
          timeoutPromise
        ]);
        
        const uploadTime = Date.now() - uploadStart;
        
        if (imageUrl) {
          // ImgBB upload succeeded - send message with the URL
          log(`[${transferId}] ImgBB upload successful in ${uploadTime}ms, sending as URL`);
          
          // Create message with the URL (no extra newlines)
          const messageData = {
            ...baseMessageData,
            // If there's content, add the URL without any extra newlines
            // If no content, just use the URL directly
            content: baseMessageData.content && baseMessageData.content.trim() 
              ? `${baseMessageData.content.trim()} ${imageUrl}` 
              : imageUrl
          };
          
          // Send via Discord webhook
          await this.discordBot.sendMessage(channelId, messageData, username);
          log(`[${transferId}] Successfully sent image via ImgBB URL`);
          return;
        } else {
          // Upload returned null without throwing (unlikely but possible)
          log(`[${transferId}] ImgBB upload returned null without error after ${uploadTime}ms`, "warn");
        }
      } catch (error) {
        // Handle ImgBB upload failure
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(`[${transferId}] ImgBB upload failed: ${errorMessage}`, "warn");
        
        // Check if error suggests API key issues
        if (errorMessage.includes('API key') || errorMessage.includes('401') || errorMessage.includes('403')) {
          log(`[${transferId}] Possible API key issues detected with ImgBB`, "error");
        }
      }
      
      // Fallback to direct upload
      await this.sendDirectImageToDiscord(channelId, buffer, baseMessageData, username, transferId);
    } catch (error) {
      handleBridgeError(error as BridgeError, "forwardImageToDiscord");
      throw error;
    }
  }
  
  // Helper method for direct Discord image uploads
  private async sendDirectImageToDiscord(
    channelId: string, 
    buffer: Buffer, 
    baseMessageData: any, 
    username: string,
    transferId: string
  ): Promise<void> {
    log(`[${transferId}] Using direct buffer upload to Discord (${buffer.length} bytes)`);
    
    // Build message with file attachment
    const messageData = {
      ...baseMessageData,
      files: [{
        attachment: buffer,
        name: `photo_${transferId}.jpg`, // Use transfer ID for consistent naming
        description: 'Photo from Telegram'
      }]
    };
    
    // Send to Discord
    await this.discordBot.sendMessage(channelId, messageData, username);
    log(`[${transferId}] Successfully sent image via direct buffer upload`);
  }

  getTelegramBot(): TelegramBot {
    return this.telegramBot;
  }

  getDiscordBot(): DiscordBot {
    return this.discordBot;
  }
  
  /**
   * Gets the RevoltBot instance, initializing it if necessary
   * This is used by the API to get information about the Revolt integration
   * If the RevoltBot is not initialized and autoInit is true, it will be initialized
   * @param autoInit Whether to auto-initialize the RevoltBot if it's not already initialized
   * @returns The RevoltBot instance, or null if it's not initialized and autoInit is false
   */
  getRevoltBot(autoInit: boolean = false): RevoltBot | null {
    // Check if the Revolt integration is active
    const checkActive = async (): Promise<boolean> => {
      try {
        const config = await storage.getBotConfig();
        return config?.activeProvider === 'revolt';
      } catch (error) {
        log(`Error checking if Revolt is active: ${error}`, "error");
        return false;
      }
    };
    
    if (!this.revoltBot && autoInit) {
      log("Auto-initializing RevoltBot");
      
      // Initialize the RevoltBot asynchronously, but only if Revolt is the active platform
      checkActive().then(isActive => {
        if (isActive) {
          log("Revolt is the active platform, initializing RevoltBot");
          return this.startRevoltBot();
        } else {
          log("Revolt is not the active platform, skipping initialization");
          return Promise.resolve();
        }
      }).catch(err => {
        log(`Error auto-initializing RevoltBot: ${err}`, "error");
      });
      
      // We still return null on the first call as the initialization is asynchronous
      return null;
    }
    
    return this.revoltBot;
  }
}

async function uploadToImgbb(buffer: Buffer, retryCount: number = 3, delayMs: number = 1000): Promise<string | null> {
  let lastError: Error | null = null;
  const startTime = Date.now();
  
  for (let attempt = 1; attempt <= retryCount; attempt++) {
    try {
      // Log message for each attempt
      if (attempt > 1) {
        log(`ImgBB upload retry ${attempt}/${retryCount}...`, "warn");
      }
      
      const formData = new URLSearchParams();
      formData.append('image', buffer.toString('base64'));
      formData.append('name', `bridge_upload_${Date.now()}`);
      // Preserve image quality
      formData.append('quality', '100');
      // Don't auto-resize
      formData.append('width', '0');
      formData.append('height', '0');
      
      const apiKey = process.env.IMGBB_API_KEY;
      if (!apiKey) {
        throw new BridgeError('IMGBB_API_KEY is not defined', { context: "uploadToImgbb" });
      }
      
      const url = `https://api.imgbb.com/1/upload?key=${apiKey}`;
      
      // Create request options
      const requestOptions: RequestInit = {
        method: 'POST',
        body: formData,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        }
      };
      
      // Set up an AbortController with timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000) as unknown as number;
      requestOptions.signal = controller.signal;
      
      // Make the request
      const response = await fetch(url, requestOptions);
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        // If rate limited or server error, retry
        if (response.status === 429 || response.status >= 500) {
          throw new BridgeError(`ImgBB API error: ${response.status} ${response.statusText}`, 
            { context: "uploadToImgbb", code: response.status.toString() });
        }
        
        // For other error codes like 403, get the response body for more info
        const errorBody = await response.text();
        throw new BridgeError(`ImgBB API error: ${response.status} ${response.statusText} - ${errorBody}`, 
          { context: "uploadToImgbb", code: response.status.toString() });
      }
      
      const responseText = await response.text();
      const data = JSON.parse(responseText);
      
      if (!data.success || !data.data?.url) {
        throw new BridgeError('ImgBB upload failed: No URL returned', { context: "uploadToImgbb" });
      }
      
      const elapsed = Date.now() - startTime;
      
      // Log detailed image information
      log(`Successfully uploaded image to ImgBB in ${elapsed}ms (attempt ${attempt}/${retryCount}):
      Original size: ${buffer.length} bytes
      URL: ${data.data.url}
      Display URL: ${data.data.display_url}
      Size: ${data.data.size} bytes
      Width: ${data.data.width}px
      Height: ${data.data.height}px
      Type: ${data.data.image.mime}`);
      
      // Use display_url which provides full resolution
      return data.data.display_url || data.data.url;
      
    } catch (error) {
      const bridgeError = error instanceof BridgeError ? error : new BridgeError(
        error instanceof Error ? error.message : String(error),
        { context: "uploadToImgbb" }
      );
      
      lastError = bridgeError;
      
      // Handle different errors differently
      const isRateLimit = bridgeError.code === '429' || bridgeError.message.includes('rate limit');
      const isTimeout = bridgeError.message.includes('abort') || bridgeError.message.includes('timeout');
      
      handleBridgeError(bridgeError, `uploadToImgbb (attempt ${attempt}/${retryCount})`);
      
      // If this is the last attempt, don't wait
      if (attempt < retryCount) {
        // Use exponential backoff for rate limits
        const waitTime = isRateLimit 
          ? delayMs * Math.pow(2, attempt - 1) 
          : isTimeout
            ? delayMs * 2 // Longer delay for timeouts
            : delayMs;
        
        log(`Waiting ${waitTime}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  // All attempts failed
  const errorMessage = lastError ? lastError.message : 'Unknown error';
  log(`All ${retryCount} ImgBB upload attempts failed: ${errorMessage}`, "error");
  return null;
}