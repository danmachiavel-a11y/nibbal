import { storage } from "../storage";
// Import the unified Telegram bot implementation
import { TelegramBot } from "./telegram";
import { DiscordBot } from "./discord";
import type { Ticket, Message } from "@shared/schema";
import { log } from "../vite";
import fetch, { RequestInit } from 'node-fetch';
import { TextChannel } from 'discord.js';
import crypto from 'crypto';
import { messageDeduplication } from './message-deduplication';

export class BridgeError extends Error {
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
  private isDiscordAvailable: boolean = true; // Added to handle Discord unavailability
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
  private discordStatusChangeCallbacks: Array<(isAvailable: boolean) => void> = [];
  
  // Message deduplication cache
  private readonly messageDedupCache: Map<string, number> = new Map();
  private readonly messageDedupWindow: number = 180000; // 3 minutes (increased from 60s)
  private readonly MAX_DEDUP_CACHE_SIZE = 1000; // Maximum number of cached entries
  
  // Deployment-aware fields for robust initialization
  private isDisabled: boolean = false;
  private disabledReason: string = '';
  private startTimestamp: number | undefined = undefined;
  private lastTelegramReconnectAttempt: number = 0;
  private lastDiscordReconnectAttempt: number = 0; 
  private readonly MIN_RECONNECT_INTERVAL = 15000; // 15 seconds between reconnection attempts
  
  // Enable extra deduplication logging to debug duplicate messages
  private readonly ENABLE_DEDUP_LOGGING = true;
  private readonly MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB per image
  private readonly MIN_IMAGE_SIZE = 32; // 32 bytes minimum
  
  // Message retry mechanism
  private messageRetryQueue: Array<{
    attempt: number;
    content: string;
    ticketId: number;
    username: string;
    avatarUrl?: string;
    photo?: string;
    firstName?: string;
    lastName?: string;
    telegramId?: number;
    timestamp: number;
    target: 'discord' | 'telegram'; // Target platform for the message
  }> = [];
  private readonly MAX_RETRY_QUEUE_SIZE = 1000; // Increased from 500 to handle more messages
  private readonly MAX_RETRY_ATTEMPTS = 8; // Increased from 5 to give more chances
  private readonly RETRY_INTERVAL = 5000; // Reduced from 10s to 5s for faster retries
  private readonly BATCH_SIZE = 3; // Process 3 messages per batch
  private readonly MESSAGE_PROCESSING_DELAY = 500; // 500ms delay between messages in a batch
  private discordConsecutiveFailures = 0; // Track failures for backoff
  private telegramConsecutiveFailures = 0; // Track failures for Telegram too
  private memoryCache = new Map<string, any>();
  private readonly MEMORY_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
  
  // Message counter for deduplication (allows sending duplicate messages while preventing spam)
  private messageCounters: Map<string, number> = new Map();

  constructor() {
    log("Initializing Bridge Manager");
    this.telegramBot = new TelegramBot(this);
    this.discordBot = new DiscordBot(this);
    this.startHealthCheck();
    this.startImageCacheCleanup();
    
    // Setup retry processor for queued messages
    setInterval(() => this.processRetryQueue(), this.RETRY_INTERVAL);
  }

  private startImageCacheCleanup(): void {
    setInterval(() => this.cleanupImageCache(), this.imageCacheCleanupInterval);
  }
  
  /**
   * Get a sequential counter for a given ticket and user
   * This allows users to send duplicate messages while still protecting against spam bots
   * @param ticketId The ID of the ticket
   * @param username The username to track
   * @returns An incremented counter value
   */
  private getMessageCounter(ticketId: number, username: string): number {
    const counterKey = `${ticketId}:${username}`;
    const current = this.messageCounters.get(counterKey) || 0;
    const next = current + 1;
    this.messageCounters.set(counterKey, next);
    
    // Clean up counters if we have too many (avoid memory leaks)
    if (this.messageCounters.size > 10000) {
      const oldestKeys = Array.from(this.messageCounters.keys()).slice(0, 5000);
      for (const key of oldestKeys) {
        this.messageCounters.delete(key);
      }
    }
    
    return next;
  }
  
  // Maximum number of duplicates allowed per message
  private readonly MAX_DUPLICATES_ALLOWED = 5; // Allow 5 identical messages per conversation
  
  /**
   * Check if a message should be considered a duplicate and blocked
   * Uses a configurable duplicate limit to allow users to send the same message multiple times
   * @param platform 'telegram' or 'discord' for platform-specific tracking
   * @param ticketId The ticket ID the message is for
   * @param content The message content
   * @param contentHash A hash of the content for faster comparison
   * @param additionalInfo Additional message metadata to include in deduplication
   * @returns boolean - true if message should be processed, false if it's a duplicate to be blocked
   */
  private shouldProcessMessage(
    platform: 'telegram' | 'discord',
    ticketId: number,
    content: string,
    contentHash: string,
    additionalInfo: string
  ): boolean {
    const dedupVersion = "v2";
    
    // Create a key for tracking exact duplicates regardless of sender
    const exactDuplicateKey = `${platform}-exact:${dedupVersion}:${ticketId}:${contentHash}:${content.substring(0, 50)}`;
    
    // Get current count of duplicates
    const currentDuplicateCount = this.messageDedupCache.get(exactDuplicateKey) || 0;
    
    // Log duplicate detection for debugging
    if (currentDuplicateCount > 0 && this.ENABLE_DEDUP_LOGGING) {
      log(`[DEDUP] Detected duplicate message #${currentDuplicateCount+1} of "${content.substring(0, 20)}..." in ticket #${ticketId}`, "debug");
    }
    
    // Check if we've exceeded the allowed duplicates
    if (currentDuplicateCount >= this.MAX_DUPLICATES_ALLOWED) {
      log(`Blocking duplicate: message "${content.substring(0, 20)}..." exceeded max allowed duplicates (${this.MAX_DUPLICATES_ALLOWED})`, "warn");
      return false;
    }
    
    // Update the duplicate counter for this exact message
    this.messageDedupCache.set(exactDuplicateKey, currentDuplicateCount + 1);
    
    // Also store a traditional deduplication entry with the timestamp and additional info
    const now = Date.now();
    const traditionalKey = `${platform}:${dedupVersion}:${ticketId}:${contentHash}:${additionalInfo}`;
    this.messageDedupCache.set(traditionalKey, now);
    
    return true;
  }
  
  /**
   * Clean the deduplication cache to prevent memory leaks
   * Handles both timestamp-based entries and counter-based entries
   */
  /**
   * Clean deduplication cache more aggressively to handle rapid message sequences
   * Two-phase cleaning first handles expired entries, then oldest counter-based entries if needed
   */
  private cleanDedupCache(): void {
    if (this.messageDedupCache.size <= this.MAX_DEDUP_CACHE_SIZE * 0.8) {
      return; // Only clean when we reach 80% capacity to reduce overhead
    }
    
    const now = Date.now();
    const expireTime = now - this.messageDedupWindow;
    let cleanedCount = 0;
    
    // Phase 1: Clean up keys that are definitely expired by timestamp
    for (const [key, value] of this.messageDedupCache.entries()) {
      // If the entry is a timestamp (greater than 1000000000000 - meaning a Unix timestamp after 2001)
      if (typeof value === 'number' && value > 1000000000000 && value < expireTime) {
        this.messageDedupCache.delete(key);
        cleanedCount++;
      }
      
      // If we've cleaned at least 20% of the cache (doubled from 10%), move to next phase
      if (cleanedCount >= this.MAX_DEDUP_CACHE_SIZE * 0.2) break;
    }
    
    // Phase 2: If we still need to clean more entries (cache > 90% full)
    if (this.messageDedupCache.size > this.MAX_DEDUP_CACHE_SIZE * 0.9) {
      // Find keys for exact match counters (used for allowing duplicate messages)
      const exactKeys = Array.from(this.messageDedupCache.keys())
        .filter(key => key.startsWith('dc-exact:') || key.startsWith('tg-exact:'))
        .sort((a, b) => {
          // Sort by counter value - older entries (lower counters) get cleaned first
          const valueA = this.messageDedupCache.get(a) || 0;
          const valueB = this.messageDedupCache.get(b) || 0;
          return valueA - valueB; // Sort ascending so oldest are first
        });
      
      // Find regular timestamp keys to clean by age
      const timestampKeys = Array.from(this.messageDedupCache.entries())
        .filter(([key, val]) => 
          !key.startsWith('dc-exact:') && 
          !key.startsWith('tg-exact:') && 
          typeof val === 'number'
        )
        .sort((a, b) => a[1] - b[1]) // Sort by timestamp value (oldest first)
        .map(([key]) => key); // Extract just the keys
      
      // Determine how many more entries to clean (up to 20% of cache size)
      const moreToClean = Math.ceil(this.MAX_DEDUP_CACHE_SIZE * 0.2);
      let additionalCleaned = 0;
      
      // First try to clean older exact match counter entries
      for (let i = 0; i < Math.min(exactKeys.length, moreToClean); i++) {
        this.messageDedupCache.delete(exactKeys[i]);
        additionalCleaned++;
        
        // If we've cleaned enough, stop
        if (additionalCleaned >= moreToClean) break;
      }
      
      // If we still need to clean more, try timestamp entries too
      if (additionalCleaned < moreToClean) {
        for (let i = 0; i < Math.min(timestampKeys.length, moreToClean - additionalCleaned); i++) {
          this.messageDedupCache.delete(timestampKeys[i]);
          additionalCleaned++;
        }
      }
      
      cleanedCount += additionalCleaned;
    }
    
    if (cleanedCount > 0) {
      log(`Cleaned ${cleanedCount} entries from message deduplication cache, size now: ${this.messageDedupCache.size}`);
    }
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

      // Add AbortController for cleaner cancellation
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      const response = await Promise.race([
        fetch(url, { 
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 Message-Bridge/1.0'
          }
        }),
        timeoutPromise
      ]) as Response;
      
      clearTimeout(timeoutId);

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
    // Run health check every 5 minutes (reduced from 15 to catch issues sooner)
    this.healthCheckInterval = setInterval(async () => {
      try {
        const health = await this.healthCheck();
        
        // Update availability flags based on health check
        if (!health.discord) {
          log("Discord bot is unavailable, setting isDiscordAvailable = false", "warn");
          this.isDiscordAvailable = false;
        } else if (!this.isDiscordAvailable) {
          log("Discord bot is now available, restoring isDiscordAvailable = true", "info");
          this.isDiscordAvailable = true;
        }
        
        if (!health.telegram || !health.discord) {
          log("Bot disconnected, attempting to reconnect...");
          // Add delay before reconnection attempt
          await new Promise(resolve => setTimeout(resolve, 5000));
          await this.reconnectDisconnectedBots(health);
        }
      } catch (error) {
        handleBridgeError(error as BridgeError, "healthCheck");
      }
    }, 300000); // 5 minutes (reduced from 15) to catch issues sooner
  }

  async start() {
    log("Starting bots...");
    try {
      // Reset the disabled state when attempting to start
      this.isDisabled = false;
      this.disabledReason = "";
      
      // Record start timestamp for uptime tracking
      this.startTimestamp = Date.now();
      
      // Start both bots with Promise.allSettled to continue even if one fails
      const results = await Promise.allSettled([
        this.startBotWithRetry(
          () => this.telegramBot.start(),
          "Telegram"
        ),
        this.startBotWithRetry(
          () => {
            // Check if Discord token is present and looks valid
            const token = process.env.DISCORD_BOT_TOKEN;
            if (!token || token === "REPLACE_WITH_VALID_DISCORD_BOT_TOKEN" || token.length < 50) {
              log("Discord bot token is missing or invalid. Skipping Discord bot initialization.", "warn");
              log("Please set up a valid token using the instructions in discord-setup-instructions.md", "info");
              this.isDiscordAvailable = false;
              return Promise.resolve(); // Return resolved promise to continue without Discord
            }
            return this.discordBot.start();
          },
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
        
        // If all bots failed, throw an error, but handle case where Discord is intentionally skipped
        if (failures.length === results.length) {
          if (!this.isDiscordAvailable) {
            log("Continuing without Discord bot", "warn");
          } else {
            throw new Error("All bots failed to start");
          }
        }
      }
      
      log("Bots initialization completed");
    } catch (error) {
      handleBridgeError(error as BridgeError, "start");
      throw error; // Re-throw to allow caller to handle
    }
  }

  /**
   * Specialized method to reconnect the Telegram bot with enhanced conflict handling
   * This handles network issues and the case where we're getting 409 Conflict errors
   */
  async reconnectTelegram(): Promise<void> {
    if (!this.telegramBot) {
      log("Cannot reconnect Telegram, bot is not initialized", "error");
      return;
    }
    
    // Record attempt time for rate limiting
    this.lastTelegramReconnectAttempt = Date.now();
    
    try {
      log("Attempting to reconnect Telegram bot with enhanced conflict handling...", "info");
      
      // First check if Telegram API is accessible by making a simple test request
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        // Create an anonymous fetch request to simply check if Telegram API is reachable
        const response = await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/getWebhookInfo', {
          method: 'GET',
          headers: { 
            'Content-Type': 'application/json',
            'User-Agent': 'TelegramBotBridge/1.0' 
          },
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (response.status === 409) {
          log("409 Conflict detected during pre-reconnect check - will use more aggressive cleanup", "warn");
          // Force a longer delay for conflicts
          await new Promise(resolve => setTimeout(resolve, 10000));
        } else if (response.status < 200 || response.status >= 300) {
          log(`Telegram API returned status ${response.status} in pre-reconnect check`, "warn");
        } else {
          log("Telegram API is accessible, proceeding with normal reconnection", "info");
        }
      } catch (preCheckError) {
        // Just log the error and continue with reconnection attempt
        log(`Error during pre-reconnect API check: ${preCheckError}`, "warn");
      }
      
      // First stop the bot completely with timeout protection - use a longer timeout
      try {
        log("Stopping current Telegram bot instance...", "info");
        await Promise.race([
          this.telegramBot.stop(),
          new Promise<void>(resolve => {
            setTimeout(() => {
              log("Stop operation timed out, forcing cleanup", "warn");
              resolve();
            }, 8000); // Increased from 5s to 8s
          })
        ]);
        log("Telegram bot stopped successfully", "debug");
      } catch (stopError) {
        log(`Error stopping Telegram bot before reconnect: ${stopError}`, "warn");
        // Continue with reconnect anyway
      }
      
      // Give the system time to fully release connections - longer wait for conflict situations
      log("Waiting for connections to fully close...", "debug");
      await new Promise(resolve => setTimeout(resolve, 8000));
      
      // Attempt to force release webhook/getUpdates to prevent conflicts
      try {
        log("Forcing webhook cleanup to prevent conflicts...", "debug");
        await this.cleanupTelegramConnections();
      } catch (cleanupError) {
        log(`Error during pre-start cleanup: ${cleanupError}`, "warn");
        // Continue anyway, just a preemptive attempt
      }
      
      // Try to start the bot with enhanced conflict detection
      try {
        // Start the Telegram bot with automatic conflict resolution
        log("Starting Telegram bot with conflict prevention...", "info");
        await this.telegramBot.start();
        log("Telegram bot reconnected successfully", "info");
      } catch (startError) {
        const errorStr = String(startError).toLowerCase();
        
        if (errorStr.includes('409') || errorStr.includes('conflict')) {
          log("409 Conflict detected during reconnection - another instance is running", "error");
          
          // For conflict errors, try a more aggressive cleanup approach
          log("Attempting aggressive cleanup for conflict resolution...", "warn");
          
          try {
            // Force a longer delay for conflicts
            await new Promise(resolve => setTimeout(resolve, 15000));
            
            // Try forceful webhook deletion and connection cleanup
            await this.cleanupTelegramConnections();
            
            // Schedule a delayed retry with a 2-minute cooldown
            log("Scheduling reconnection retry after 120s cooldown", "info");
            setTimeout(() => {
              log("Attempting reconnection after conflict cooldown...", "info");
              this.reconnectTelegram().catch(e => {
                log(`Post-conflict reconnection failed: ${e}`, "error");
              });
            }, 120000); // 2 minute cooldown after conflict
          } catch (cleanupError) {
            log(`Error during aggressive connection cleanup: ${cleanupError}`, "error");
          }
          
          // Don't rethrow - we've scheduled a retry
          return;
        }
        
        // For non-conflict errors, add more detailed logging
        log(`Non-conflict error during Telegram reconnection: ${errorStr}`, "error");
        
        // Handle specific known error cases
        if (errorStr.includes('econnrefused') || errorStr.includes('timeout') || errorStr.includes('network')) {
          log("Network connectivity issue detected, scheduling retry with backoff", "warn");
          // Schedule a retry with shorter delay for network issues
          setTimeout(() => {
            this.reconnectTelegram().catch(e => {
              log(`Network-related reconnection retry failed: ${e}`, "error");
            });
          }, 30000); // 30 second retry for network issues
          return;
        }
        
        throw startError; // Rethrow other errors
      }
    } catch (error) {
      log(`Error reconnecting Telegram bot: ${error}`, "error");
      throw error;
    }
  }

  private async startBotWithRetry(
    startFn: () => Promise<void>,
    botName: string,
    maxRetries?: number,
    handleConflicts?: boolean
  ): Promise<void> {
    // Use provided maxRetries or default to this.maxRetries
    const retryLimit = maxRetries || this.maxRetries;
    
    for (let attempt = 1; attempt <= retryLimit; attempt++) {
      try {
        // Add significant delay between attempts
        if (attempt > 1) {
          log(`Waiting ${this.retryTimeout / 1000} seconds before attempt ${attempt}...`);
          await new Promise(resolve => setTimeout(resolve, this.retryTimeout));
        }

        log(`Starting ${botName} bot (attempt ${attempt}/${retryLimit})...`);
        await startFn();

        this.retryAttempts = 0; // Reset on success
        
        // If Discord started successfully, make sure isDiscordAvailable is true
        if (botName === "Discord") {
          this.isDiscordAvailable = true;
          log("Setting Discord as available after successful startup");
        }
        
        log(`${botName} bot started successfully`);
        return;
      } catch (error) {
        handleBridgeError(error as BridgeError, `startBotWithRetry-${botName}-${attempt}`);
        
        // Check for conflict errors if handling is enabled
        if (handleConflicts && botName === "Telegram") {
          const errorStr = String(error).toLowerCase();
          if (errorStr.includes('409') || errorStr.includes('conflict')) {
            log(`409 Conflict detected during ${botName} startup - another instance is running`, "error");
            
            // For conflict errors, we'll throw with a special message
            throw new Error(`409 Conflict: terminated by other getUpdates request; make sure that only one bot instance is running`);
          }
        }

        // If Discord failed to start, mark it as unavailable
        if (botName === "Discord") {
          log("Setting Discord as unavailable due to startup failure", "warn");
          this.isDiscordAvailable = false;
        }

        if (attempt === retryLimit) {
          log(`${botName} bot failed to start after ${retryLimit} attempts`, "error");
          throw error;
        }

        // Add longer delay after failure - use longer delay for network errors
        const errorStr = String(error).toLowerCase();
        const networkError = errorStr.includes('network') || 
                             errorStr.includes('econnreset') || 
                             errorStr.includes('timeout');
        
        const delay = networkError ? 15000 : 5000;
        log(`Waiting ${delay/1000}s before next attempt${networkError ? ' (network error)' : ''}...`);
        await new Promise(resolve => setTimeout(resolve, delay));
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
        const now = Date.now();
        // Check if we've attempted a reconnect too recently
        if (now - this.lastTelegramReconnectAttempt < this.MIN_RECONNECT_INTERVAL) {
          log(`Skipping Telegram reconnect - attempted too recently (${Math.floor((now - this.lastTelegramReconnectAttempt) / 1000)}s ago)`, "warn");
        } else {
          this.lastTelegramReconnectAttempt = now;
          log("Attempting to reconnect Telegram bot...", "express");
          
          // First ensure the bot is properly stopped
          try {
            await Promise.race([
              this.telegramBot.stop(),
              new Promise<void>(resolve => setTimeout(resolve, 5000)) // Don't wait more than 5 seconds
            ]);
          } catch (stopError) {
            log(`Error stopping Telegram bot before reconnect: ${stopError}`, "warn");
            // Continue with reconnect anyway
          }
          
          // Add longer delay before reconnection to allow connections to fully close
          await new Promise(resolve => setTimeout(resolve, 5000));
          
          try {
            await this.startBotWithRetry(
              () => this.telegramBot.start(),
              "Telegram",
              3, // Max attempts
              true // Enable conflict detection
            );
          } catch (startError) {
            // Handle conflict errors specially
            const errorStr = String(startError).toLowerCase();
            if (errorStr.includes('409') || errorStr.includes('conflict')) {
              log("409 Conflict error during reconnection - will try again after extended cooldown", "warn");
              
              // Schedule a delayed retry with much longer interval
              setTimeout(() => {
                log("Attempting reconnection after conflict cooldown...", "info");
                this.reconnectTelegram().catch(e => {
                  log(`Post-conflict reconnection failed: ${e}`, "error");
                });
              }, 120000); // 2 minute cooldown after conflict
            }
          }
        }
      }
      
      if (!health.discord) {
        const now = Date.now();
        // Check if we've attempted a reconnect too recently
        if (now - this.lastDiscordReconnectAttempt < this.MIN_RECONNECT_INTERVAL) {
          log(`Skipping Discord reconnect - attempted too recently (${Math.floor((now - this.lastDiscordReconnectAttempt) / 1000)}s ago)`, "warn");
        } else {
          this.lastDiscordReconnectAttempt = now;
          log("Attempting to reconnect Discord bot...", "express");
          await this.startBotWithRetry(() => this.discordBot.start(), "Discord");
        }
      }
    } catch (error) {
      handleBridgeError(error as BridgeError, "reconnectDisconnectedBots");
      throw error;
    }
  }

  async healthCheck(): Promise<{
    telegram: boolean;
    discord: boolean;
    discordAvailable?: boolean;
    disabled?: boolean;
    disabledReason?: string;
    uptime?: number;
  }> {
    try {
      // Return early if bridge is disabled
      if (this.isDisabled) {
        return {
          telegram: false,
          discord: false,
          discordAvailable: false,
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
      
      // Get the current Discord state
      const discordReady = this.discordBot.isReady();
      
      // Update isDiscordAvailable flag based on the check
      if (discordReady !== this.isDiscordAvailable) {
        log(`Updating Discord availability state: ${this.isDiscordAvailable} → ${discordReady}`);
        this.isDiscordAvailable = discordReady;
      }
      
      return {
        telegram: this.telegramBot.getIsConnected(),
        discord: discordReady,
        discordAvailable: this.isDiscordAvailable,
        uptime
      };
    } catch (error) {
      handleBridgeError(error as BridgeError, "healthCheck");
      return {
        telegram: false,
        discord: false,
        discordAvailable: false,
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
   * Process the message retry queue
   * Attempts to resend messages that failed due to Discord unavailability
   */
  /**
   * Process the message retry queue in batches with delays between messages
   * Handles both Discord and Telegram messages with separate availability checks
   */
  private async processRetryQueue(): Promise<void> {
    // Skip if queue is empty
    if (this.messageRetryQueue.length === 0) {
      return;
    }
    
    // Check platform availability
    const discordAvailable = this.isDiscordAvailable && this.discordBot.isReady();
    const telegramAvailable = this.telegramBot.getIsConnected();
    
    if (!discordAvailable && !telegramAvailable) {
      // Both platforms unavailable, skip processing
      return;
    }
    
    log(`Processing message retry queue (${this.messageRetryQueue.length} messages)`);
    
    // Group messages by platform
    const discordMessages = this.messageRetryQueue.filter(msg => 
      msg.target === 'discord' && discordAvailable
    );
    const telegramMessages = this.messageRetryQueue.filter(msg => 
      msg.target === 'telegram' && telegramAvailable
    );
    const skippedMessages = this.messageRetryQueue.filter(msg => 
      (msg.target === 'discord' && !discordAvailable) || 
      (msg.target === 'telegram' && !telegramAvailable)
    );
    
    // Reset the queue with skipped messages (platforms not available)
    this.messageRetryQueue = [...skippedMessages];
    
    // Process messages for each available platform in small batches
    // This helps prevent one platform from monopolizing the queue
    await this.processPlatformMessages('discord', discordMessages.slice(0, this.BATCH_SIZE));
    await this.processPlatformMessages('telegram', telegramMessages.slice(0, this.BATCH_SIZE));
    
    // Add remaining messages back to the queue
    this.messageRetryQueue = [
      ...this.messageRetryQueue,
      ...discordMessages.slice(this.BATCH_SIZE),
      ...telegramMessages.slice(this.BATCH_SIZE)
    ];
    
    // Log queue status if not empty
    if (this.messageRetryQueue.length > 0) {
      log(`Messages remaining in queue: ${this.messageRetryQueue.length}`);
    }
  }
  
  /**
   * Process a batch of messages for a specific platform
   * Adds delays between messages to avoid rate limits
   */
  private async processPlatformMessages(
    platform: 'discord' | 'telegram',
    messages: Array<{
      attempt: number;
      content: string;
      ticketId: number;
      username: string;
      avatarUrl?: string;
      photo?: string;
      firstName?: string;
      lastName?: string;
      telegramId?: number;
      timestamp: number;
      target: 'discord' | 'telegram';
    }>
  ): Promise<void> {
    if (messages.length === 0) return;
    
    let successCount = 0;
    let failureCount = 0;
    
    // Process each message with individual try/catch to continue even if one fails
    for (const message of messages) {
      try {
        // Skip messages that have exceeded retry attempts
        if (message.attempt >= this.MAX_RETRY_ATTEMPTS) {
          log(`Message for ticket ${message.ticketId} exceeded max retry attempts (${message.attempt}/${this.MAX_RETRY_ATTEMPTS}), discarding`);
          failureCount++;
          continue;
        }
        
        // Increment attempt count
        message.attempt++;
        
        // Add delay between messages to avoid rate limits
        // The delay increases with consecutive failures for dynamic backoff
        if (successCount > 0 || failureCount > 0) {
          const baseDelay = this.MESSAGE_PROCESSING_DELAY;
          const failureMultiplier = platform === 'discord' 
            ? Math.min(this.discordConsecutiveFailures, 5)
            : Math.min(this.telegramConsecutiveFailures, 5);
          const actualDelay = baseDelay * (1 + failureMultiplier * 0.5);
          
          await new Promise(resolve => setTimeout(resolve, actualDelay));
        }
        
        log(`Retrying ${platform} message for ticket ${message.ticketId} (attempt ${message.attempt}/${this.MAX_RETRY_ATTEMPTS})`);
        
        if (platform === 'discord') {
          // Forward the message to Discord
          await this.forwardToDiscord(
            message.content,
            message.ticketId,
            message.username,
            message.avatarUrl,
            message.photo,
            message.firstName,
            message.lastName,
            message.telegramId
          );
          
          // If we've been failing consistently, reset the counter since we had a success
          if (this.discordConsecutiveFailures > 0) {
            log(`Successfully sent Discord message after ${this.discordConsecutiveFailures} consecutive failures, resetting failure counter`);
            this.discordConsecutiveFailures = 0;
          }
        } else {
          // Forward to Telegram
          // We don't have explicit attachments parameter here, so pass undefined
          await this.forwardToTelegram(
            message.content,
            message.ticketId,
            message.username
          );
          
          // Reset Telegram failure counter on success
          if (this.telegramConsecutiveFailures > 0) {
            log(`Successfully sent Telegram message after ${this.telegramConsecutiveFailures} consecutive failures, resetting failure counter`);
            this.telegramConsecutiveFailures = 0;
          }
        }
        
        successCount++;
      } catch (error) {
        failureCount++;
        
        // Handle the error but continue processing other messages
        log(`Failed to retry ${platform} message for ticket ${message.ticketId}: ${error}`, "error");
        
        // Increment failure counter for the appropriate platform
        if (platform === 'discord') {
          this.discordConsecutiveFailures++;
        } else {
          this.telegramConsecutiveFailures++;
        }
        
        // Add the message back to the queue if we haven't exceeded max attempts
        if (message.attempt < this.MAX_RETRY_ATTEMPTS) {
          this.messageRetryQueue.push(message);
        }
      }
    }
    
    log(`Processed ${successCount + failureCount} ${platform} messages: ${successCount} succeeded, ${failureCount} failed`);
  }

  /**
   * Enhanced cleanup for Telegram connections when we detect a 409 Conflict error
   * This can happen during deployment when multiple instances are running
   * or when a previous bot instance was not properly terminated
   */
  async cleanupTelegramConnections(): Promise<void> {
    try {
      log("Performing aggressive cleanup of Telegram connections...", "info");
      
      // 1. First attempt: Safely stop the Telegram bot if it exists
      if (this.telegramBot) {
        try {
          // Use timeout to prevent hanging
          await Promise.race([
            this.telegramBot.stop(),
            new Promise<void>((resolve) => setTimeout(() => {
              log("Stop operation timed out during cleanup, forcing continuation", "warn");
              resolve();
            }, 5000))
          ]);
          log("Telegram bot stopped successfully during cleanup", "info");
        } catch (stopError) {
          log(`Error stopping Telegram bot during cleanup: ${stopError}`, "error");
          // Continue with cleanup regardless
        }
      }
      
      // 2. Attempt to delete any webhook
      try {
        log("Attempting to delete any existing webhook...", "info");
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        const webhookDeleteResponse = await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/deleteWebhook?drop_pending_updates=true', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'User-Agent': 'TelegramBotBridge/1.0'
          },
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (webhookDeleteResponse.ok) {
          const result = await webhookDeleteResponse.json();
          log(`Webhook deletion result: ${JSON.stringify(result)}`, "info");
        } else {
          log(`Failed to delete webhook: ${webhookDeleteResponse.status} ${webhookDeleteResponse.statusText}`, "warn");
        }
      } catch (webhookError) {
        log(`Error during webhook deletion: ${webhookError}`, "warn");
        // Continue with other cleanup steps
      }
      
      // 3. Force garbage collection if available (Node.js with --expose-gc flag)
      if (typeof global.gc === 'function') {
        try {
          global.gc();
          log("Forced garbage collection to clean up stale connections", "info");
        } catch (gcError) {
          log(`Error during forced garbage collection: ${gcError}`, "error");
        }
      }
      
      // 4. Add a more significant delay to allow external connections to terminate
      log("Waiting for external connections to terminate completely...", "info");
      await new Promise(resolve => setTimeout(resolve, 15000)); // 15 second delay (increased from 10s)
      
      // 5. Make a simple API call to check if the conflict is resolved
      try {
        log("Testing Telegram API access after cleanup...", "debug");
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        const testResponse = await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/getMe', {
          method: 'GET',
          headers: { 
            'Content-Type': 'application/json',
            'User-Agent': 'TelegramBotBridge/1.0'
          },
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (testResponse.status === 409) {
          log("⚠️ Conflict still detected after cleanup. A longer cooldown period may be needed.", "warn");
        } else if (testResponse.ok) {
          log("✅ Telegram API accessible after cleanup - conflict appears to be resolved", "info");
        } else {
          log(`Telegram API returned status ${testResponse.status} after cleanup`, "warn");
        }
      } catch (testError) {
        log(`Error testing Telegram API after cleanup: ${testError}`, "warn");
      }
      
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
      telegramId?: string | number,
      ticketId?: number,
      username?: string
    }
  ): Promise<void> {
    try {
      if (!channelId) {
        throw new BridgeError("Missing Discord channel ID", { context: "sendSystemMessageToDiscord" });
      }
      
      // Check Discord availability first
      if (!this.isDiscordAvailable) {
        log(`Discord bot is unavailable, cannot send system message to channel ${channelId}`, "warn");
        return;
      }

      if (!this.discordBot.isReady()) {
        log("Discord bot is not ready, marking as unavailable", "warn");
        this.isDiscordAvailable = false;
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
      // If Telegram bot is not connected, queue the message for later
      if (!this.telegramBot.getIsConnected()) {
        log(`Telegram bot is not connected, storing message but not forwarding ticket ${ticketId}`, "warn");
        
        // Store the message in the database for transcript history
        try {
          const ticket = await storage.getTicket(ticketId);
          if (ticket?.userId) {
            await storage.createMessage({
              ticketId,
              content: `[QUEUED] ${content}`, // Mark as queued 
              authorId: ticket.userId,
              platform: "discord",
              timestamp: new Date(),
              senderName: username
            });
            
            log(`Message stored in database, will be forwarded when Telegram reconnects: ${ticketId}`);
          }
        } catch (dbError) {
          log(`Failed to store message in database: ${dbError}`, "error");
        }
        
        // Add to retry queue to send when Telegram becomes available
        if (this.messageRetryQueue.length < this.MAX_RETRY_QUEUE_SIZE) {
          this.messageRetryQueue.push({
            attempt: 0,
            content,
            ticketId,
            username,
            timestamp: Date.now(),
            target: 'telegram' // Specify the target platform
          });
          log(`Added message to Telegram retry queue for ticket ${ticketId}, queue size: ${this.messageRetryQueue.length}`);
        } else {
          log(`Retry queue full (${this.messageRetryQueue.length}), discarding message for ticket ${ticketId}`, "warn");
        }
        
        return {
          sent: false,
          error: "telegram_unavailable"
        };
      }
      
      // Add delay if there have been recent failures
      if (this.telegramConsecutiveFailures > 0) {
        const backoffDelay = Math.min(this.telegramConsecutiveFailures * 200, 2000); // 200ms per failure, max 2s
        log(`Adding ${backoffDelay}ms delay due to ${this.telegramConsecutiveFailures} consecutive Telegram failures`);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
      }
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
      // Include a version number to make it easier to change deduplication behavior in the future
      const dedupVersion = "v3"; // Updated version to reflect changes
      
      // Add a sequential counter to allow duplicate identical messages
      // This will create a unique key for each message, but we'll still check timing
      const messageCounter = this.getMessageCounter(ticketId, username);
      
      // Generate deduplication key with uniqueness counter
      const dedupKey = `tg:${dedupVersion}:${ticketId}:${contentHash}:${contentForKey}:${attachmentInfo}:${username}:${messageCounter}`;
      const now = Date.now();
      
      if (this.ENABLE_DEDUP_LOGGING) {
        log(`[DEDUP] Generated key for Telegram: ${dedupKey}`, "debug");
      }
      
      // Allow a certain number of duplicate messages from the same user
      // This pattern will still protect against bots sending the exact same message dozens of times
      const duplicateKey = `tg-exact:${dedupVersion}:${ticketId}:${contentHash}:${contentForKey}`;
      const maxDuplicatesAllowed = this.MAX_DUPLICATES_ALLOWED; // Use the class constant (5)
      
      // Each duplicate message gets a counter rather than a timestamp
      const currentDuplicateCount = this.messageDedupCache.get(duplicateKey) || 0;
      
      // If we've exceeded the allowed duplicates, warn and drop the message
      if (currentDuplicateCount >= maxDuplicatesAllowed) {
        log(`Preventing spam: message "${contentForKey.substring(0, 20)}..." exceeded max allowed duplicates (${maxDuplicatesAllowed})`, "warn");
        return {
          sent: false,
          error: "duplicate_message"
        };
      }
      
      // Log duplicate detection for debugging
      if (currentDuplicateCount > 0 && this.ENABLE_DEDUP_LOGGING) {
        log(`[DEDUP] Processing duplicate message #${currentDuplicateCount+1} of "${contentForKey.substring(0, 20)}..." in ticket #${ticketId}`, "debug");
      }
      
      // Update the duplicate counter for this exact message
      this.messageDedupCache.set(duplicateKey, currentDuplicateCount + 1);
      
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
      
      // First get the ticket
      const ticket = await storage.getTicket(ticketId);
      log(`Forwarding to Telegram - Ticket ID: ${ticketId}, Status: ${ticket?.status}`);

      // Validate ticket
      if (!ticket || !ticket.userId) {
        log(`Invalid ticket or missing user ID: ${ticketId}`, "error");
        return {
          sent: false,
          error: "invalid_ticket"
        };
      }
      
      // Skip if ticket is already closed/deleted/transcript
      if (ticket.status === 'closed' || ticket.status === 'deleted' || ticket.status === 'transcript') {
        log(`Not forwarding message for closed ticket #${ticketId}`, "warn");
        return {
          sent: false,
          error: "ticket_closed"
        };
      }

      // Get the user associated with this ticket
      const user = await storage.getUser(ticket.userId);
      log(`Found user: ${user?.id}, Telegram ID: ${user?.telegramId}`);

      // Validate user
      if (!user || !user.telegramId) {
        log(`Invalid user or missing Telegram ID for ticket: ${ticketId}`, "error");
        return {
          sent: false,
          error: "invalid_user"
        };
      }

      // Validate Telegram ID format
      if (!Number.isFinite(user.telegramId)) {
        log(`Invalid Telegram ID format for user: ${user.id}`, "error");
        return {
          sent: false,
          error: "invalid_telegram_id"
        };
      }
      
      // Check if user is banned
      if (user.isBanned) {
        log(`Not forwarding message to banned user: ${user.id}`, "warn");
        return {
          sent: false,
          error: "user_banned"
        };
      }

      try {
        // Retry the message from this ticket but with improved error handling and logging
        
        // Track which forwarding we are actually doing
        let forwardType = "text"; // Default to text
        
        // Handle attachments if present
        if (attachments && attachments.length > 0) {
          forwardType = "attachment";
          
          // Store message with attachment indication
          await storage.createMessage({
            ticketId,
            content: content || "Image sent",
            authorId: user.id,
            platform: "discord",
            timestamp: new Date(),
            senderName: username
          });
          
          log(`Stored Discord message with attachments in database for ticket ${ticketId}`);

          // Send text content if any
          if (content?.trim()) {
            try {
              const messagePrefix = `[${ticket.categoryId ? `#${ticket.categoryId}` : 'Ticket'}] ${username}: `;
              await this.telegramBot.sendMessage(user.telegramId, `${messagePrefix}${cleanedContent}`);
              log(`Sent text portion of message with attachments to Telegram user ${user.telegramId} for ticket ${ticketId}`);
            } catch (textError) {
              log(`Error sending text portion of message with attachments: ${textError}`, "error");
              // Continue with attachments even if text fails
            }
          }

          // Process each attachment
          let attachmentSuccess = false;
          for (const attachment of attachments) {
            if (attachment.url) {
              try {
                const cacheKey = attachment.url;
                const cachedImage = this.getCachedImage(cacheKey);

                if (cachedImage?.telegramFileId) {
                  log(`Using cached Telegram fileId for ${attachment.url} in ticket ${ticketId}`);
                  await this.telegramBot.sendCachedPhoto(user.telegramId, cachedImage.telegramFileId, `Image from ${username}`);
                  attachmentSuccess = true;
                  continue;
                }

                log(`Processing Discord attachment: ${attachment.url} for ticket ${ticketId}`);
                const buffer = await this.processDiscordToTelegram(attachment.url);
                if (!buffer) {
                  throw new BridgeError("Failed to process image", { context: "forwardToTelegram" });
                }
                log(`Successfully processed image, size: ${buffer.length} bytes for ticket ${ticketId}`);

                const caption = `[${ticket.categoryId ? `#${ticket.categoryId}` : 'Ticket'}] Image from ${username}`;
                const fileId = await this.telegramBot.sendPhoto(user.telegramId, buffer, caption);

                if (fileId) {
                  this.setCachedImage(cacheKey, { telegramFileId: fileId, buffer });
                  attachmentSuccess = true;
                }

                log(`Successfully sent photo to Telegram user ${user.telegramId} for ticket ${ticketId}`);
              } catch (attachmentError) {
                log(`Error processing attachment: ${attachment.url} for ticket ${ticketId}: ${attachmentError}`, "error");
                // Continue with other attachments even if one fails
              }
            }
          }
          
          if (attachmentSuccess) {
            log(`Successfully forwarded at least one attachment to Telegram for ticket ${ticketId}`);
            return {
              sent: true,
              type: "attachment"
            };
          } else {
            log(`Failed to forward any attachments to Telegram for ticket ${ticketId}`, "warn");
            return {
              sent: false,
              error: "attachment_failed"
            };
          }
        }

        // Handle text messages with image URLs
        const imageUrlMatch = content.match(/(https?:\/\/[^\s]+\.(jpg|jpeg|png|gif))/i);
        if (imageUrlMatch) {
          forwardType = "image-url";
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
          
          log(`Stored Discord message with image URL in database for ticket ${ticketId}`);

          // Send text if any
          let textSuccess = false;
          if (textContent) {
            try {
              // Clean Discord mentions from the content - remove completely
              let cleanedTextContent = textContent
                .replace(/<@!?(\d+)>/g, "")
                .replace(/<@&(\d+)>/g, "")
                .replace(/<#(\d+)>/g, "")
                .replace(/\s+/g, " ").trim();
              
              const messagePrefix = `${username}: `;
              await this.telegramBot.sendMessage(user.telegramId, `${messagePrefix}${cleanedTextContent}`);
              textSuccess = true;
              log(`Sent text portion of message with image URL to Telegram user ${user.telegramId} for ticket ${ticketId}`);
            } catch (textError) {
              log(`Error sending text portion of message with image URL: ${textError}`, "error");
              // Continue with image even if text fails
            }
          }

          // Process and send the image
          try {
            const cacheKey = imageUrl;
            const cachedImage = this.getCachedImage(cacheKey);

            if (cachedImage?.telegramFileId) {
              log(`Using cached Telegram fileId for ${imageUrl} in ticket ${ticketId}`);
              await this.telegramBot.sendCachedPhoto(user.telegramId, cachedImage.telegramFileId, `Image from ${username}`);
              
              log(`Successfully sent cached image to Telegram user ${user.telegramId} for ticket ${ticketId}`);
              return {
                sent: true,
                type: "image-url"
              };
            }

            log(`Processing Discord image URL: ${imageUrl} for ticket ${ticketId}`);
            const buffer = await this.processDiscordToTelegram(imageUrl);
            if (!buffer) {
              throw new BridgeError("Failed to process image", { context: "forwardToTelegram" });
            }
            log(`Successfully processed image, size: ${buffer.length} bytes for ticket ${ticketId}`);

            const caption = `Image from ${username}`;
            const fileId = await this.telegramBot.sendPhoto(user.telegramId, buffer, caption);

            if (fileId) {
              this.setCachedImage(cacheKey, { telegramFileId: fileId, buffer });
            }

            log(`Successfully sent image URL to Telegram user ${user.telegramId} for ticket ${ticketId}`);
            return {
              sent: true,
              type: "image-url"
            };
          } catch (imageError) {
            log(`Error processing image URL: ${imageUrl} for ticket ${ticketId}: ${imageError}`, "error");
            // If text was successful but image failed, we still consider it partial success
            if (textSuccess) {
              return {
                sent: true,
                partial: true,
                type: "text-only"
              };
            }
            return {
              sent: false,
              error: "image_url_failed"
            };
          }
        } else {
          // Regular text message handling
          forwardType = "text";
          
          try {
            await storage.createMessage({
              ticketId,
              content,
              authorId: user.id,
              platform: "discord",
              timestamp: new Date(),
              senderName: username
            });
            
            log(`Stored Discord text message in database for ticket ${ticketId}`);
            
            // Add sender name to message for context without including category 
            const messagePrefix = `${username}: `;
            
            // Clean Discord mentions in the content - remove completely
            let cleanedContent = content
              .replace(/<@!?(\d+)>/g, "")
              .replace(/<@&(\d+)>/g, "")
              .replace(/<#(\d+)>/g, "")
              .replace(/\s+/g, " ").trim();
              
            await this.telegramBot.sendMessage(user.telegramId, `${messagePrefix}${cleanedContent}`);
            
            log(`Successfully sent text message to Telegram user ${user.telegramId} for ticket ${ticketId}`);
            return {
              sent: true,
              type: "text"
            };
          } catch (textError) {
            log(`Error sending text message to Telegram: ${textError}`, "error");
            return {
              sent: false,
              error: "text_failed"
            };
          }
        }
      } catch (innerError) {
        log(`Error in forwardToTelegram for ticket ${ticketId}: ${innerError}`, "error");
        return {
          sent: false,
          error: "unknown_error"
        };
      }
    } catch (error) {
      // Track failures for backoff
      this.telegramConsecutiveFailures++;
      log(`Telegram forward error (failures: ${this.telegramConsecutiveFailures}): ${error}`, "error");
      
      // Add to retry queue if appropriate
      if (this.messageRetryQueue.length < this.MAX_RETRY_QUEUE_SIZE) {
        this.messageRetryQueue.push({
          attempt: 0,
          content,
          ticketId,
          username,
          timestamp: Date.now(),
          target: 'telegram'
        });
        log(`Added failed message to retry queue for ticket ${ticketId}`);
      }
      
      return {
        sent: false,
        error: String(error)
      };
    }
  }

  async forwardToDiscord(content: string, ticketId: number, username: string, avatarUrl?: string, photo?: string, firstName?: string, lastName?: string, telegramId?: number) {
    try {
      // Early return if Discord is not available
      if (!this.isDiscordAvailable) {
        log(`Discord bot is not available, storing message but not forwarding ticket ${ticketId}`, "warn");
        
        // Still store the message in the database to preserve history
        try {
          const ticket = await storage.getTicket(ticketId);
          if (ticket?.userId) {
            await storage.createMessage({
              ticketId,
              content: `[QUEUED] ${content}`, // Mark as queued for visibility in the transcript
              authorId: ticket.userId,
              platform: "telegram",
              timestamp: new Date(),
              senderName: username
            });
            
            log(`Message stored in database, will be forwarded when Discord reconnects: ${ticketId}`);
          }
        } catch (dbError) {
          log(`Failed to store message in database: ${dbError}`, "error");
        }
        
        // Add to retry queue to ensure it will be sent when Discord becomes available
        if (this.messageRetryQueue.length < this.MAX_RETRY_QUEUE_SIZE) {
          this.messageRetryQueue.push({
            attempt: 0,
            content,
            ticketId,
            username,
            avatarUrl,
            photo,
            firstName,
            lastName,
            telegramId,
            timestamp: Date.now(),
            target: 'discord' // Specify target platform for proper handling
          });
          log(`Added message to Discord retry queue for ticket ${ticketId}, queue size: ${this.messageRetryQueue.length}`);
        } else {
          log(`Retry queue full (${this.messageRetryQueue.length}), discarding message for ticket ${ticketId}`, "warn");
        }
        
        return {
          sent: false,
          error: "discord_unavailable"
        };
      }
      
      // Check connection strength before sending
      // If there were recent failures, add a small delay
      if (this.discordConsecutiveFailures > 0) {
        const backoffDelay = Math.min(this.discordConsecutiveFailures * 200, 2000); // 200ms per failure, max 2 seconds
        log(`Adding ${backoffDelay}ms delay due to ${this.discordConsecutiveFailures} consecutive Discord failures`);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
      }
      
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
      // Include a version number to make it easier to change deduplication behavior in the future
      const dedupVersion = "v3"; // Updated version to reflect changes
      
      // Add a sequential counter to allow duplicate identical messages
      // This will create a unique key for each message, but we'll still check timing
      const messageCounter = this.getMessageCounter(ticketId, username);
      
      // Generate deduplication key with uniqueness counter
      const dedupKey = `dc:${dedupVersion}:${ticketId}:${contentHash}:${contentForKey}:${photoInfo}:${username}:${messageCounter}`;
      const now = Date.now();
      
      if (this.ENABLE_DEDUP_LOGGING) {
        log(`[DEDUP] Generated key for Discord: ${dedupKey}`, "debug");
      }
      
      // Allow a certain number of duplicate messages from the same user
      // This pattern will still protect against bots sending the exact same message dozens of times
      const duplicateKey = `dc-exact:${dedupVersion}:${ticketId}:${contentHash}:${contentForKey}`;
      const maxDuplicatesAllowed = this.MAX_DUPLICATES_ALLOWED; // Use the class constant (5)
      
      // Each duplicate message gets a counter rather than a timestamp
      const currentDuplicateCount = this.messageDedupCache.get(duplicateKey) || 0;
      
      // If we've exceeded the allowed duplicates, warn and drop the message
      if (currentDuplicateCount >= maxDuplicatesAllowed) {
        log(`Preventing spam: message "${contentForKey.substring(0, 20)}..." exceeded max allowed duplicates (${maxDuplicatesAllowed})`, "warn");
        return {
          sent: false,
          error: "duplicate_message"
        };
      }
      
      // Log duplicate detection for debugging
      if (currentDuplicateCount > 0 && this.ENABLE_DEDUP_LOGGING) {
        log(`[DEDUP] Processing duplicate message #${currentDuplicateCount+1} of "${contentForKey.substring(0, 20)}..." in ticket #${ticketId}`, "debug");
      }
      
      // Update the duplicate counter for this exact message
      this.messageDedupCache.set(duplicateKey, currentDuplicateCount + 1);
      
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
      
      // First get the ticket
      const ticket = await storage.getTicket(ticketId);
      log(`Forwarding to Discord - Ticket ID: ${ticketId}, Status: ${ticket?.status}`);

      // Validate ticket
      if (!ticket) {
        log(`Invalid ticket: ${ticketId}`, "error");
        return {
          sent: false,
          error: "invalid_ticket"
        };
      }
      
      // Skip if ticket is closed/deleted/transcript
      if (ticket.status === 'closed' || ticket.status === 'deleted' || ticket.status === 'transcript') {
        log(`Not forwarding message for closed ticket #${ticketId}`, "warn");
        return {
          sent: false,
          error: "ticket_closed"
        };
      }
      
      // Handle pending tickets that don't have channels yet
      if (!ticket.discordChannelId) {
        if (ticket.status === 'pending') {
          log(`Ticket ${ticketId} is in pending state, storing message but not forwarding to Discord`, "warn");
          // We've already stored the message in the database in the handler
          return {
            sent: false,
            error: "ticket_pending"
          };
        } else {
          log(`Missing Discord channel for ticket: ${ticketId} with status: ${ticket.status}`, "error");
          return {
            sent: false,
            error: "missing_channel"
          };
        }
      }
      
      // Verify the Discord channel still exists before attempting to send
      try {
        const channelStatus = await this.checkDiscordChannelStatus(ticket.discordChannelId);
        if (!channelStatus.exists) {
          log(`Discord channel ${ticket.discordChannelId} for ticket ${ticketId} does not exist`, "error");
          return {
            sent: false,
            error: "channel_not_found"
          };
        }
        
        if (channelStatus.inTranscripts && ticket.status !== 'transcript') {
          log(`Discord channel ${ticket.discordChannelId} for ticket ${ticketId} is in transcripts but ticket status is ${ticket.status}`, "warn");
          // Update ticket status to match reality
          await storage.updateTicket(ticketId, { status: 'transcript' });
          return {
            sent: false,
            error: "ticket_in_transcripts"
          };
        }
      } catch (channelError) {
        log(`Error checking Discord channel status: ${channelError}`, "error");
        // Continue anyway, the message send will fail if the channel is truly invalid
      }

      try {
        // Get user display name
        const displayName = [firstName, lastName]
          .filter(Boolean)
          .join(' ') || username;
  
        // Get category name for context
        let categoryName = "Unknown";
        if (ticket.categoryId) {
          const category = await storage.getCategory(ticket.categoryId);
          categoryName = category?.name || `#${ticket.categoryId}`;
        }
        
        // Add prefix to show which ticket/category the message is coming from (for context)
        const categoryPrefix = `(${categoryName}) `;
        
        // Process based on message type
        if (photo) {
          try {
            // First store message in database
            await storage.createMessage({
              ticketId,
              content: content || "Image sent",
              authorId: ticket.userId,
              platform: "telegram",
              timestamp: new Date(),
              senderName: username
            });
            
            log(`Stored Telegram message with photo in database for ticket ${ticketId}`);
            
            // Process the image
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
              
              log(`Successfully sent text portion of image message to Discord channel ${ticket.discordChannelId} for ticket ${ticketId}`);
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
            return {
              sent: true,
              type: "photo"
            };
          } catch (error) {
            handleBridgeError(error as BridgeError, "forwardToDiscord-photo");
            
            // If image processing failed, send a notification with the content
            try {
              // Create a message indicating photo was sent but couldn't be processed
              const photoNotification = content?.trim() 
                ? `${content.toString().trim()}\n\n(User sent a photo that couldn't be processed)`
                : `User sent a photo (couldn't be processed)`;
                
              // Send the message with notification
              log(`Attempting to send fallback message to Discord channel ${ticket.discordChannelId} for ticket ${ticketId}`);
              
              const messageOptions = {
                content: photoNotification,
                username: displayName,
                avatarURL: avatarUrl
              };
              
              await this.discordBot.sendMessage(
                ticket.discordChannelId,
                messageOptions,
                displayName
              );
              
              log(`Successfully sent fallback message to Discord channel ${ticket.discordChannelId} for ticket ${ticketId}`);
              return {
                sent: true,
                partial: true,
                type: "photo-fallback"
              };
            } catch (secondaryError) {
              handleBridgeError(secondaryError as BridgeError, "forwardToDiscord-photo-fallback");
              return {
                sent: false,
                error: "photo_fallback_failed"
              };
            }
          }
        } else {
          try {
            // Regular text message (no photo)
            // Store message in database
            await storage.createMessage({
              ticketId,
              content: content,
              authorId: ticket.userId,
              platform: "telegram",
              timestamp: new Date(),
              senderName: username
            });
            
            log(`Stored Telegram text message in database for ticket ${ticketId}`);
            
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
            
            log(`Successfully sent text message to Discord channel ${ticket.discordChannelId} for ticket ${ticketId}`);
            return {
              sent: true,
              type: "text"
            };
          } catch (textError) {
            handleBridgeError(textError as BridgeError, "forwardToDiscord-text");
            return {
              sent: false,
              error: "text_failed"
            };
          }
        }
      } catch (innerError) {
        log(`Error in forwardToDiscord for ticket ${ticketId}: ${innerError}`, "error");
        return {
          sent: false,
          error: "unknown_error"
        };
      }
    } catch (error) {
      // Track failures for backoff
      this.discordConsecutiveFailures++;
      log(`Discord forward error (failures: ${this.discordConsecutiveFailures}): ${error}`, "error");
      
      // Add to retry queue if appropriate
      if (this.messageRetryQueue.length < this.MAX_RETRY_QUEUE_SIZE) {
        this.messageRetryQueue.push({
          attempt: 0,
          content,
          ticketId,
          username,
          avatarUrl,
          photo,
          firstName,
          lastName,
          telegramId,
          timestamp: Date.now(),
          target: 'discord'
        });
        log(`Added failed message to retry queue for ticket ${ticketId}`);
      }
      
      return {
        sent: false,
        error: String(error)
      };
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
        user.telegramId,
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
   * Checks the status of a Discord channel associated with a ticket
   * Used to verify if tickets in database are actually still active in Discord
   * 
   * @param channelId Discord channel ID to check
   * @returns Object with exists and inTranscripts properties
   */
  public async checkDiscordChannelStatus(channelId: string): Promise<{ exists: boolean, inTranscripts: boolean }> {
    try {
      if (!this.isDiscordAvailable || !this.discordBot) {
        log(`[BRIDGE] Discord bot not available, cannot check channel status`, "warn");
        return { exists: false, inTranscripts: false };
      }
      
      return await this.discordBot.checkChannelStatus(channelId);
    } catch (error) {
      log(`[BRIDGE] Error checking Discord channel status for ${channelId}: ${error}`, "error");
      return { exists: false, inTranscripts: false };
    }
  }
  
  /**
   * Update the Discord connection status
   * This method is called by the Discord bot when its connection status changes
   * It updates the internal state and notifies any registered callbacks
   */
  updateDiscordStatus(isAvailable: boolean): void {
    // Don't trigger updates if the status hasn't changed
    if (this.isDiscordAvailable === isAvailable) {
      return;
    }
    
    log(`Discord status changed: ${isAvailable ? 'Connected' : 'Disconnected'}`, isAvailable ? "info" : "warn");
    
    this.isDiscordAvailable = isAvailable;
    
    // Notify any registered callbacks
    for (const callback of this.discordStatusChangeCallbacks) {
      try {
        callback(isAvailable);
      } catch (error) {
        log(`Error in Discord status change callback: ${error}`, "error");
      }
    }
    
    // If Discord has been reconnected, try to process any pending messages
    if (isAvailable) {
      log("Discord reconnected, checking for pending operations...");
      // Any reconnection logic can go here
    }
  }
  
  /**
   * Register a callback to be notified when Discord connection status changes
   */
  onDiscordStatusChange(callback: (isAvailable: boolean) => void): void {
    this.discordStatusChangeCallbacks.push(callback);
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