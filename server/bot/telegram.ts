/**
 * Telegram Bot Implementation for Support Ticket System
 * With enhanced null-safety using the telegram getter
 */

import { Telegraf, Context } from "telegraf";
import { BridgeManager } from "./bridge";
import { log } from "../vite";
import { storage } from "../storage";
import fetch from "node-fetch";
import { processRawMessage } from "./direct-commands";

// Default special chars to escape in markdown
const DEFAULT_SPECIAL_CHARS = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];

// Cache for escaped text to avoid repeating the same work
const escapeCache = new Map<string, string>();

interface RateLimit {
  lastRequest: number;
  count: number;
}

class RateLimitManager {
  private userRateLimits = new Map<number, Map<string, RateLimit>>();
  private readonly cleanupInterval: NodeJS.Timeout;
  private readonly RATE_LIMIT_WINDOW = 60000; // 1 minute
  private readonly MAX_REQUESTS_PER_WINDOW = 30;
  private readonly COMMAND_MAX_REQUESTS = 15;  // Increased from 10 to 15
  private readonly COMMAND_SPECIFIC_LIMITS: { [key: string]: number } = {
    'ping': 5,      // Increased from 3 to 5
    'start': 5,     // Increased from 3 to 5
    'cancel': 5,    // Increased from 3 to 5
    'close': 5,     // Added specific limit for close
    'switch': 5,    // Limit for switch command
    'help': 10,     // High limit for help command
    'category': 8,  // Increased from 5 to 8
    'ban': 10,
    'unban': 10,
    'info': 10
  };

  constructor() {
    this.cleanupInterval = setInterval(() => this.cleanup(), 300000); // Clean every 5 minutes
  }

  isRateLimited(userId: number, type: 'command' | 'message' = 'message', command?: string): boolean {
    const now = Date.now();
    const key = type === 'command' && command ? `cmd:${command}` : type;
    
    // Initialize user's rate limit map if it doesn't exist
    if (!this.userRateLimits.has(userId)) {
      this.userRateLimits.set(userId, new Map());
    }
    
    const userLimits = this.userRateLimits.get(userId)!;
    let limit = userLimits.get(key);

    // If no limit exists for this specific command/type, create one
    if (!limit) {
      limit = { lastRequest: now, count: 1 };
      userLimits.set(key, limit);
      return false;
    }

    // Reset if outside window
    if (now - limit.lastRequest > this.RATE_LIMIT_WINDOW) {
      limit.count = 1;
      limit.lastRequest = now;
      return false;
    }

    // Apply different limits based on type and command
    let maxRequests = this.MAX_REQUESTS_PER_WINDOW;
    if (type === 'command') {
      maxRequests = command && this.COMMAND_SPECIFIC_LIMITS[command]
        ? this.COMMAND_SPECIFIC_LIMITS[command]
        : this.COMMAND_MAX_REQUESTS;
    }

    // Check if limit exceeded
    if (limit.count >= maxRequests) {
      return true;
    }

    // Increment counter and update timestamp
    limit.count++;
    limit.lastRequest = now;
    return false;
  }

  private cleanup(): void {
    const now = Date.now();
    // Clean up expired rate limits for all users
    for (const [userId, limitMap] of this.userRateLimits.entries()) {
      let allExpired = true;
      
      // Check each command/type limit
      for (const [key, limit] of limitMap.entries()) {
        if (now - limit.lastRequest > this.RATE_LIMIT_WINDOW) {
          // Remove expired limits
          limitMap.delete(key);
        } else {
          allExpired = false;
        }
      }
      
      // If all entries for this user are expired, remove the user entirely
      if (allExpired || limitMap.size === 0) {
        this.userRateLimits.delete(userId);
      }
    }
  }

  stop(): void {
    clearInterval(this.cleanupInterval);
  }
}

interface UserState {
  categoryId: number;
  currentQuestion: number;
  answers: string[];
  inQuestionnaire: boolean;
  activeTicketId?: number;
  // Record time of last state change to help with recovery logic
  lastUpdated?: number;
  // Flag used to be used to bypass duplicate ticket check from /switch command
  // Kept for backward compatibility but no longer used
  fromSwitchCommand?: boolean;
}

interface StateCleanup {
  timeout: NodeJS.Timeout;
  createdAt: number;
}

interface BackoffConfig {
  initialDelay: number;
  maxDelay: number;
  factor: number;
}

interface ConnectionState {
  status: 'connected' | 'disconnected' | 'reconnecting';
  lastTransition: number;
  lastError?: string;
}

/**
 * Simple markdown character escaping for Telegram
 * Escapes characters that would otherwise have special meaning in MarkdownV2
 */
function simpleEscape(text: string, specialChars: string[] = DEFAULT_SPECIAL_CHARS): string {
  // Check cache first
  const cacheKey = `${text}|${specialChars.join('')}`;
  if (escapeCache.has(cacheKey)) {
    return escapeCache.get(cacheKey)!;
  }

  const escaped = escapeWithoutCache(text, specialChars);
  
  // Store in cache (with a maximum size to prevent memory issues)
  if (escapeCache.size > 1000) {
    // Clear oldest entries when cache gets too large
    const keys = Array.from(escapeCache.keys()).slice(0, 200);
    for (const key of keys) {
      escapeCache.delete(key);
    }
  }
  
  escapeCache.set(cacheKey, escaped);
  return escaped;
}

function escapeWithoutCache(text: string, specialChars: string[]): string {
  if (!text) return '';
  
  // This is the correct way to escape characters for Telegram MarkdownV2
  // Replace each special character with its escaped version
  let result = text;
  
  // These characters must be escaped in MarkdownV2
  const telegramSpecialChars = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
  
  // Use the intersection of provided specialChars and telegramSpecialChars
  const charsToEscape = specialChars.filter(char => telegramSpecialChars.includes(char));
  
  // Escape each character one by one
  for (const char of charsToEscape) {
    // Use a regex with global flag to replace all occurrences
    const regex = new RegExp('\\' + char, 'g');
    result = result.replace(regex, '\\' + char);
  }
  
  return result;
}

/**
 * Preserve intentional Markdown formatting while escaping other special characters
 * Modified for better compatibility with Telegram's MarkdownV2 format
 */
function preserveMarkdown(text: string): string {
  if (!text) return '';
  
  // Define the special characters that need to be escaped in MarkdownV2
  const specialChars = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
  
  // Replace all markdown formatting patterns with placeholders
  // This is done to protect the formatting from being escaped
  let processedText = text;
  
  // Replace bold with placeholder
  processedText = processedText.replace(/\*\*(.*?)\*\*/g, '§BOLD§$1§BOLD§');
  
  // Replace italic with placeholder
  processedText = processedText.replace(/\*(.*?)\*/g, '§ITALIC§$1§ITALIC§');
  processedText = processedText.replace(/_(.*?)_/g, '§ITALIC§$1§ITALIC§');
  
  // Replace code with placeholder
  processedText = processedText.replace(/`(.*?)`/g, '§CODE§$1§CODE§');
  
  // Replace links with placeholder
  processedText = processedText.replace(/\[(.*?)\]\((.*?)\)/g, '§LINK_TEXT§$1§LINK_TEXT§§LINK_URL§$2§LINK_URL§');
  
  // Escape all special characters
  for (const char of specialChars) {
    processedText = processedText.replace(new RegExp('\\' + char, 'g'), '\\' + char);
  }
  
  // Restore bold formatting
  processedText = processedText.replace(/§BOLD§(.*?)§BOLD§/g, '*$1*');
  
  // Restore italic formatting
  processedText = processedText.replace(/§ITALIC§(.*?)§ITALIC§/g, '_$1_');
  
  // Restore code formatting
  processedText = processedText.replace(/§CODE§(.*?)§CODE§/g, '`$1`');
  
  // Restore link formatting
  processedText = processedText.replace(/§LINK_TEXT§(.*?)§LINK_TEXT§§LINK_URL§(.*?)§LINK_URL§/g, '[$1]($2)');
  
  return processedText;
}

/**
 * Remove all markdown formatting from text
 * Useful for plain text contexts
 */
function removeMarkdown(text: string): string {
  // Remove bold
  text = text.replace(/\*\*(.*?)\*\*/g, '$1');
  
  // Remove italic
  text = text.replace(/\*(.*?)\*/g, '$1');
  text = text.replace(/_(.*?)_/g, '$1');
  
  // Remove code
  text = text.replace(/`(.*?)`/g, '$1');
  
  // Remove links, keep link text
  text = text.replace(/\[(.*?)\]\((.*?)\)/g, '$1');
  
  return text;
}

export class TelegramBot {
  private bot: Telegraf | null = null;
  private bridge: BridgeManager;
  private userStates: Map<number, UserState> = new Map();
  private stateCleanups: Map<number, StateCleanup> = new Map();
  private rateLimitManager: RateLimitManager = new RateLimitManager();
  private _isConnected: boolean = false;
  private isStarting: boolean = false;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private forcedReconnectionTimer: NodeJS.Timeout | null = null;
  
  /**
   * Get the current state for a user from memory
   * @param userId The Telegram user ID
   * @returns The user state or undefined if not found
   */
  getUserState(userId: number): UserState | undefined {
    return this.userStates.get(userId);
  }
  
  /**
   * Safe getter for the telegram property
   * Returns a proxy that throws a helpful error if the bot is null
   */
  private get telegram() {
    if (!this.bot) {
      // Try to auto-recover by forcing a reconnection
      log("Auto-recovering from null bot instance", "warn");
      
      // Don't throw immediately, first try to fix the issue
      this._isConnected = false;
      
      // Schedule an immediate reconnection 
      setTimeout(() => {
        log("Initiating emergency bot reconnection due to null instance", "warn");
        this.start().catch(e => {
          log(`Emergency reconnection failed: ${e}`, "error");
        });
      }, 100);
      
      // Still throw for the current operation so caller knows to retry
      throw new Error("Bot not initialized (recovery initiated)");
    }
    return this.bot.telegram;
  }

  private reconnectAttempts: number = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private readonly CLEANUP_DELAY = 10000; // 10 seconds
  private readonly HEARTBEAT_INTERVAL = 60000; // 1 minute (reduced from 2 minutes)
  private readonly STATE_TIMEOUT = 900000; // 15 minutes
  private readonly RECONNECT_COOLDOWN = 30000; // 30 seconds
  private readonly MAX_FAILED_HEARTBEATS = 3;
  private failedHeartbeats = 0;
  private readonly MAX_CONCURRENT_USERS = 500;
  private activeUsers: Set<number> = new Set();
  private lastHeartbeatSuccess: number = Date.now();
  private backoffConfig: BackoffConfig = {
    initialDelay: 1000,
    maxDelay: 60000,
    factor: 2
  };
  
  private connectionState: ConnectionState = {
    status: 'disconnected',
    lastTransition: Date.now()
  };

  constructor(bridge: BridgeManager) {
    this.bridge = bridge;
  }

  /**
   * Public method for verifying connection
   * Exposed so bridge manager can check the connection status
   */
  async verifyConnection(): Promise<boolean> {
    return this._verifyConnection();
  }

  /**
   * Internal method for verifying connection
   */
  private async _verifyConnection(): Promise<boolean> {
    if (!this.bot) return false;
    
    try {
      // Add timeout to getMe operation to avoid hanging
      const timeoutPromise = new Promise<boolean>((_, reject) => {
        setTimeout(() => reject(new Error("Connection verification timed out")), 10000);
      });
      
      // Race between the actual operation and the timeout
      const result = await Promise.race([
        this.telegram.getMe().then(() => true),
        timeoutPromise
      ]);
      
      // If verification succeeds, update the connection state
      if (result === true && !this._isConnected) {
        this._isConnected = true;
        this.updateConnectionState('connected');
        log("Telegram connection verified and restored", "info");
      }
      
      return result === true;
    } catch (error) {
      // Log specific error types for better diagnosis
      const errorMessage = String(error);
      if (errorMessage.includes("ETIMEOUT") || errorMessage.includes("ECONNRESET")) {
        log(`Telegram connection verification failed due to network issue: ${errorMessage}`, "warn");
      } else if (errorMessage.includes("Conflict")) {
        log(`Telegram connection verification failed due to conflict: ${errorMessage}`, "warn");
      } else {
        log(`Telegram connection verification failed: ${errorMessage}`, "debug");
      }
      
      // Update connection state on failure
      if (this._isConnected) {
        this._isConnected = false;
        this.updateConnectionState('disconnected', errorMessage);
        log("Telegram connection marked as disconnected after verification failure", "warn");
      }
      
      return false;
    }
  }

  private async handleHeartbeat() {
    if (!this._isConnected || !this.bot) {
      log(`Skipping heartbeat - bot is disconnected or not initialized`, "debug");
      return;
    }

    try {
      // Use a more aggressive timeout to prevent connection check from hanging
      const connectionPromise = this.verifyConnection();
      const timeoutPromise = new Promise<boolean>((_, reject) => {
        setTimeout(() => reject(new Error("Connection verification timed out")), 5000); // Shorter timeout (5s)
      });
      
      // Race the verification against the timeout
      const isConnected = await Promise.race([connectionPromise, timeoutPromise]);
      
      if (isConnected) {
        // Success - Reset failure counters
        this.failedHeartbeats = 0;
        this.lastHeartbeatSuccess = Date.now();
        
        // Only log periodically to avoid log spam
        if (Date.now() % 5 === 0) {
          log(`Telegram heartbeat successful`, "debug");
        }
      } else {
        // Connection verification failed
        this.failedHeartbeats++;
        const timeSinceLastSuccess = Math.floor((Date.now() - this.lastHeartbeatSuccess) / 1000);
        log(`Telegram heartbeat failed, count: ${this.failedHeartbeats}/${this.MAX_FAILED_HEARTBEATS}, time since last success: ${timeSinceLastSuccess}s`, "warn");
        
        // Check if we need to attempt reconnection - be more aggressive with reconnection
        if (this.failedHeartbeats >= this.MAX_FAILED_HEARTBEATS || timeSinceLastSuccess > 300) {
          log(`Connection problems detected (${this.failedHeartbeats} failed heartbeats), initiating forced reconnection`, "warn");
          await this.performForcedReconnection();
        }
      }
    } catch (error) {
      // Error during heartbeat operation
      this.failedHeartbeats++;
      log(`Error during Telegram heartbeat: ${error}`, "error");
      
      // Check for specific critical errors that require immediate reconnection
      const errorStr = String(error).toLowerCase();
      const criticalErrors = [
        'timeout', 'econnreset', 'socket hang up', 'network error', 'econnrefused',
        'etimedout', 'enotfound', 'network', 'failed to fetch', 'aborted'
      ];
      const isCritical = criticalErrors.some(e => errorStr.includes(e));
      
      if (isCritical || this.failedHeartbeats >= this.MAX_FAILED_HEARTBEATS) {
        log(`${isCritical ? 'Critical connection error' : 'Too many failed heartbeats'}, forcing immediate reconnection`, "warn");
        await this.performForcedReconnection();
      }
    }
  }
  
  /**
   * Perform a complete forced reconnection of the Telegram bot
   * This is called when we detect severe connection issues
   * Enhanced with multi-strategy approach for maximum resilience
   */
  private async performForcedReconnection(): Promise<void> {
    try {
      log("Starting enhanced forced reconnection procedure", "info");
      
      // First, update the connection state immediately
      this.updateConnectionState('reconnecting');
      
      // Reset the bot instance - use a timeout to avoid hanging 
      if (this.bot) {
        try {
          log("Stopping Telegram bot for forced reconnection", "info");
          
          // Attempt graceful stop with timeout protection
          const stopPromise = this.bot.stop();
          const stopTimeoutPromise = new Promise<void>(resolve => {
            setTimeout(() => {
              log("Stop operation timed out during forced reconnection", "warn");
              resolve();
            }, 3000);
          });
          
          await Promise.race([stopPromise, stopTimeoutPromise]);
        } catch (stopError) {
          log(`Error stopping bot during forced reconnection: ${stopError}`, "warn");
          // Continue with reconnection regardless
        }
        
        // Clear instance variables
        this.bot = null;
        this._isConnected = false;
      }
      
      // Additional steps to ensure clean reconnection
      try {
        // Pre-check: Verify the API is responsive before reconnection attempt
        log("Performing API availability pre-check...", "debug");
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        const preCheckResponse = await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/getMe', {
          method: 'GET',
          headers: { 
            'Content-Type': 'application/json',
            'User-Agent': 'TelegramBotBridge/2.0 (Reconnection)' 
          },
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!preCheckResponse.ok) {
          log(`API returned ${preCheckResponse.status} during pre-check, delaying reconnection`, "warn");
          // Wait longer before attempting reconnection if API is having issues
          await new Promise(resolve => setTimeout(resolve, 5000));
        } else {
          log("API pre-check successful, proceeding with reconnection", "debug");
          // Shorter delay if API is responsive
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (preCheckError) {
        log(`API pre-check failed: ${preCheckError}, still attempting reconnection`, "warn");
        // Longer cooldown if API is completely unreachable
        await new Promise(resolve => setTimeout(resolve, 8000));
      }
      
      // Try multiple reconnection strategies in sequence
      let reconnected = false;
      
      // Strategy 1: Bridge-managed reconnection (preferred)
      if (!reconnected) {
        try {
          log("Strategy 1: Initiating Telegram reconnection through bridge manager", "info");
          await this.bridge.reconnectTelegram();
          log("Telegram bot reconnected successfully via bridge", "info");
          reconnected = true;
        } catch (bridgeError) {
          log(`Bridge-initiated reconnection failed: ${bridgeError}`, "error");
        }
      }
      
      // Strategy 2: Direct reconnection if bridge method fails
      if (!reconnected) {
        try {
          log("Strategy 2: Attempting direct reconnection...", "info");
          this.reconnectAttempts++;
          await this.start();
          log("Direct reconnection successful", "info");
          reconnected = true;
        } catch (directError) {
          log(`Direct reconnection failed: ${directError}`, "error");
          
          // If direct reconnection fails, try after a short delay
          try {
            const backoffDelay = Math.min(2000 * this.reconnectAttempts, 10000);
            log(`Waiting ${backoffDelay/1000}s before retry...`, "info");
            await new Promise(resolve => setTimeout(resolve, backoffDelay));
            
            log("Retrying direct reconnection...", "info");
            await this.start();
            log("Retry reconnection successful", "info");
            reconnected = true;
          } catch (retryError) {
            log(`Retry reconnection also failed: ${retryError}`, "error");
          }
        }
      }
      
      // Strategy 3: Last resort - clean restart with webhook reset
      if (!reconnected) {
        try {
          log("Strategy 3: Performing clean restart with webhook reset...", "info");
          
          // Force cleanup of any existing webhooks
          try {
            const webhookResponse = await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/deleteWebhook?drop_pending_updates=true', {
              method: 'GET',
              headers: { 'User-Agent': 'TelegramBotBridge/2.0 (EmergencyReconnect)' }
            });
            
            if (webhookResponse.ok) {
              log("Successfully cleaned webhook configuration before emergency restart", "debug");
            }
          } catch (webhookError) {
            log(`Webhook cleanup failed: ${webhookError}`, "warn");
          }
          
          // Wait a bit longer to ensure clean state
          await new Promise(resolve => setTimeout(resolve, 3000));
          
          // Final attempt with original reconnection logic as backup
          this.reconnectAttempts++;
          log("Scheduling fallback bridge reconnection after webhook cleanup", "info"); 
          
          const backoffDelay = this.calculateBackoffDelay();
          log(`Using ${backoffDelay/1000}s backoff delay for emergency retry`, "info");
          
          setTimeout(() => {
            log("Executing emergency reconnection via bridge", "info");
            this.bridge.reconnectTelegram().catch(e => {
              log(`Emergency reconnection also failed: ${e}`, "error");
            });
          }, backoffDelay);
        } catch (emergencyError) {
          log(`Emergency reconnection failed: ${emergencyError}`, "error");
        }
      }
      
      if (reconnected) {
        log("Telegram reconnection completed successfully", "info");
        this.failedHeartbeats = 0;
        this.lastHeartbeatSuccess = Date.now();
        
        // Process any pending messages in the message queue
        if (typeof this.bridge.processMessageRetryQueue === 'function') {
          await this.bridge.processMessageRetryQueue();
        } else {
          // Fallback if the method doesn't exist
          log("Message retry queue processing not available", "warn");
        }
        
        // Force an immediate heartbeat check to verify connection
        setTimeout(() => {
          this.handleHeartbeat().catch(e => {
            log(`Error in post-reconnection heartbeat: ${e}`, "warn");
          });
        }, 5000);
      } else {
        log("All immediate reconnection strategies failed, waiting for scheduled retries", "warn");
        
        // Schedule one final reconnection attempt after a longer delay
        this.forcedReconnectionTimer = setTimeout(() => {
          log("Attempting final emergency reconnection...", "info");
          this.start().catch(e => {
            log(`Emergency reconnection also failed: ${e}`, "error");
          });
        }, 30000); // 30 second delay
      }
    } catch (error) {
      log(`Unexpected error during forced reconnection: ${error}`, "error");
      // Even on complete failure, schedule one more attempt with maximum backoff
      const maxBackoff = this.backoffConfig.maxDelay;
      setTimeout(() => {
        log("Last-chance reconnection attempt after complete failure", "info");
        this.bridge.reconnectTelegram().catch(() => {
          this.updateConnectionState('disconnected', "All reconnection attempts failed");
        });
      }, maxBackoff);
    }
  }

  private startHeartbeat = (): void => {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    // Use a more frequent heartbeat interval in production for faster failure detection
    const heartbeatInterval = process.env.NODE_ENV === 'production' 
      ? 60000 // 1 minute in production (more frequent)
      : this.HEARTBEAT_INTERVAL; // 2 minutes in development
    
    log(`Starting enhanced Telegram heartbeat system every ${heartbeatInterval / 60000} minutes`, "info");
    
    // Use arrow function to preserve 'this' context
    this.heartbeatInterval = setInterval(() => {
      // Wrap heartbeat in a try-catch for additional resilience
      this.handleHeartbeat().catch(error => {
        log(`Error in heartbeat: ${error}`, "error");
        
        // If there's a serious error, schedule an immediate retry
        const errorStr = String(error).toLowerCase();
        if (errorStr.includes('timeout') || 
            errorStr.includes('econnreset') || 
            errorStr.includes('socket') || 
            errorStr.includes('network')) {
          
          log("Critical network error detected in heartbeat, scheduling immediate retry", "warn");
          
          // Try again very quickly instead of waiting for the next interval
          setTimeout(() => {
            log("Executing emergency heartbeat check after critical error", "debug");
            this.handleHeartbeat().catch(e => {
              log(`Emergency heartbeat also failed: ${e}`, "error");
              
              // If both attempts fail quickly, force a full reconnection
              this.performForcedReconnection().catch(reconnectError => {
                log(`Forced reconnection failed after heartbeat failures: ${reconnectError}`, "error");
              });
            });
          }, 5000); // Try again in 5 seconds
        }
      });
    }, heartbeatInterval);
    
    // Execute a heartbeat immediately to verify initial connection
    this.handleHeartbeat().catch(error => {
      log(`Initial heartbeat check failed: ${error}`, "warn");
    });
    
    log(`Enhanced Telegram heartbeat started with ${heartbeatInterval}ms interval`, "info");
  }

  private stopHeartbeat = (): void => {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      log(`Stopped heartbeat monitoring`, "debug");
    }
  }

  private startCleanupInterval(): void {
    setInterval(() => this.cleanupStaleStates(), this.CLEANUP_DELAY);
  }

  private cleanupStaleStates(): void {
    const now = Date.now();
    
    // Clean up expired state timeouts
    for (const [userId, cleanup] of this.stateCleanups.entries()) {
      const age = now - cleanup.createdAt;
      if (age > this.STATE_TIMEOUT) {
        clearTimeout(cleanup.timeout);
        this.stateCleanups.delete(userId);
        this.userStates.delete(userId);
        this.activeUsers.delete(userId);
        log(`Cleared stale state for user ${userId}`, "debug");
      }
    }
  }

  private checkRateLimit(userId: number, type: 'command' | 'message', command?: string): boolean {
    if (this.rateLimitManager.isRateLimited(userId, type, command)) {
      log(`Rate limit exceeded for user ${userId}, type: ${type}, command: ${command || 'N/A'}`, "warn");
      return false;
    }
    return true;
  }

  async setState(userId: number, state: UserState) {
    try {
      // Make a deep copy of the state to protect against race conditions
      const stateCopy = JSON.parse(JSON.stringify(state));
      
      // Update state with lastUpdated timestamp
      stateCopy.lastUpdated = Date.now();
      
      // Add a unique transaction ID to help track state changes
      stateCopy.transactionId = `${userId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      
      // Clear existing timeout if any
      if (this.stateCleanups.has(userId)) {
        clearTimeout(this.stateCleanups.get(userId)!.timeout);
      }
      
      // FIRST - validate user exists in database before setting state
      let user;
      
      try {
        // Try first with the userId from memory which is faster
        user = await storage.getUser(userId);
        
        // If not found, try to look up by telegramId as string
        if (!user || !user.telegramId) {
          log(`User not found by ID ${userId}, trying to look up by Telegram ID`, "debug");
          user = await storage.getUserByTelegramId(userId.toString());
        }
        
        if (!user || !user.telegramId) {
          log(`Could not persist state: User ${userId} not found in database or missing telegramId`, "warn");
          return;
        }
      } catch (userLookupError) {
        log(`Error looking up user ${userId}: ${userLookupError}`, "error");
        // Continue with memory state update but don't try database persistence
        user = null;
      }
      
      // SECOND - Set the state in memory
      this.userStates.set(userId, stateCopy);
      
      // THIRD - Setup cleanup timeout
      const timeout = setTimeout(() => {
        // Before auto-clearing, check if ticket is active in DB
        (async () => {
          try {
            if (stateCopy.activeTicketId && user) {
              const ticket = await storage.getTicket(stateCopy.activeTicketId);
              // Only clear state if ticket is inactive or closed
              if (!ticket || ticket.status === "closed") {
                this.userStates.delete(userId);
                this.stateCleanups.delete(userId);
                this.activeUsers.delete(userId);
                log(`Auto-cleared state for inactive user ${userId} - ticket ${stateCopy.activeTicketId} is closed or deleted`, "debug");
                
                // Also deactivate state in database
                if (user.telegramId) {
                  await storage.deactivateUserState(user.telegramId);
                }
              } else {
                // Ticket still active, extend timeout
                log(`Not clearing state for user ${userId} - ticket ${stateCopy.activeTicketId} is still active (${ticket.status})`, "debug");
                
                // Refresh the timeout
                this.setState(userId, stateCopy);
              }
            } else {
              // No active ticket, go ahead and clear
              this.userStates.delete(userId);
              this.stateCleanups.delete(userId);
              this.activeUsers.delete(userId);
              log(`Auto-cleared state for inactive user ${userId}`, "debug");
              
              // Also deactivate state in database if we have user info
              if (user && user.telegramId) {
                await storage.deactivateUserState(user.telegramId);
              }
            }
          } catch (error) {
            log(`Error in state cleanup check: ${error}`, "error");
            // Default to keeping the state when in doubt
          }
        })();
      }, this.STATE_TIMEOUT);
      
      // Save the cleanup info
      this.stateCleanups.set(userId, {
        timeout,
        createdAt: Date.now()
      });
      
      // FOURTH - If user exists, persist state to database
      if (user && user.telegramId) {
        try {
          // Convert state to JSON string
          const stateStr = JSON.stringify(stateCopy);
          await storage.saveUserState(user.id, user.telegramId, stateStr);
          log(`Persisted state for user ${userId} (telegramId: ${user.telegramId}, tx: ${stateCopy.transactionId})`, "debug");
        } catch (dbError: unknown) {
          log(`Error persisting state to database: ${String(dbError)}`, "error");
          
          // Attempt one retry with minimized state if the state is too large
          const errorStr = String(dbError);
          if (errorStr.includes("too large") || errorStr.includes("exceeded")) {
            try {
              // Create a minimal state with just the critical fields
              const minimalState = {
                activeTicketId: stateCopy.activeTicketId,
                categoryId: stateCopy.categoryId,
                inQuestionnaire: stateCopy.inQuestionnaire,
                lastUpdated: stateCopy.lastUpdated,
                transactionId: stateCopy.transactionId
              };
              
              const minimalStateStr = JSON.stringify(minimalState);
              await storage.saveUserState(user.id, user.telegramId, minimalStateStr);
              log(`Persisted minimal state for user ${userId} after size error`, "debug");
            } catch (retryError) {
              log(`Failed to persist even minimal state: ${retryError}`, "error");
            }
          }
        }
      }
      
      log(`State updated for user ${userId} (tx: ${stateCopy.transactionId})`, "debug");
    } catch (error) {
      log(`Error in setState: ${error}`, "error");
      // State may be partially updated - we prioritize memory state integrity
    }
    
    log(`Set state for user ${userId}: ${JSON.stringify(state)}`, "debug");
  }

  private updateConnectionState(newStatus: 'connected' | 'disconnected' | 'reconnecting', error?: string) {
    const oldStatus = this.connectionState.status;
    
    if (oldStatus !== newStatus) {
      log(`Connection state transition: ${oldStatus} -> ${newStatus}${error ? ` (${error})` : ''}`, "warn");
      
      this.connectionState = {
        status: newStatus,
        lastTransition: Date.now(),
        lastError: error
      };
      
      this._isConnected = newStatus === 'connected';
    }
  }

  private calculateBackoffDelay(): number {
    // Exponential backoff with jitter
    let delay = this.backoffConfig.initialDelay * Math.pow(this.backoffConfig.factor, this.reconnectAttempts);
    delay = Math.min(delay, this.backoffConfig.maxDelay);
    
    // Add random jitter (±20%)
    const jitter = delay * 0.2;
    delay = delay - jitter + (Math.random() * jitter * 2);
    
    return Math.floor(delay);
  }

  private async handleDisconnect() {
    this._isConnected = false;
    this.updateConnectionState('disconnected');
    
    // Stop the bot and clear resources
    try {
      if (this.bot) {
        // Add timeout to stop operation to prevent hanging
        const stopPromise = this.bot.stop();
        const timeoutPromise = new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error("Bot stop operation timed out")), 5000);
        });
        
        await Promise.race([stopPromise, timeoutPromise]);
      }
    } catch (error) {
      log(`Error stopping Telegram bot during disconnect: ${error}`, "error");
      // Continue with reconnection logic even if stopping fails
    }
    
    this.bot = null;
    this.stopHeartbeat();
    
    // Reset on severe failures or after many attempts
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      // Reset the counter every 30 minutes to allow future reconnection attempts
      if (Date.now() - this.lastHeartbeatSuccess > 30 * 60 * 1000) {
        log("Resetting reconnect attempts counter after 30 minute cooldown", "info");
        this.reconnectAttempts = 0;
      } else {
        log(`Maximum reconnect attempts reached (${this.MAX_RECONNECT_ATTEMPTS}), waiting for cooldown`, "error");
        this.updateConnectionState('disconnected', "Max reconnect attempts exceeded");
        return;
      }
    }
    
    // Calculate delay with exponential backoff
    const delay = this.calculateBackoffDelay();
    this.reconnectAttempts++;
    log(`Will attempt to reconnect Telegram bot in ${delay}ms (attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})`, "warn");
    
    this.updateConnectionState('reconnecting');
    
    // Set a reconnection timeout
    setTimeout(async () => {
      try {
        // Check for Telegram API availability before trying to reconnect
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 10000);
          
          const response = await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/getMe', {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal
          });
          
          clearTimeout(timeoutId);
          
          if (response.status >= 200 && response.status < 300) {
            log("Telegram API is available, proceeding with reconnection", "info");
          } else if (response.status === 409) {
            // Special handling for conflict errors
            log("Detected 409 Conflict during pre-connect check, delaying reconnection", "warn");
            // Wait longer than usual for conflict errors
            await new Promise(resolve => setTimeout(resolve, 10000));
          } else {
            log(`Telegram API returned status ${response.status} during pre-connect check`, "warn");
          }
        } catch (apiCheckError) {
          log(`Error checking Telegram API availability: ${apiCheckError}`, "warn");
          // Continue anyway, the main reconnection attempt will handle errors
        }
        
        await this.start();
        // Reset reconnect attempts on successful reconnection
        this.reconnectAttempts = 0;
      } catch (error) {
        log(`Error during reconnect attempt: ${error}`, "error");
        
        // Check for specific error types
        const errorStr = String(error);
        if (errorStr.includes("409") || errorStr.includes("Conflict")) {
          log("Detected conflict error, using longer backoff for next attempt", "warn");
          // Double the usual delay for conflict errors
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        // Continue with reconnection
        await this.handleDisconnect();
      }
    }, delay);
  }

  async start() {
    if (this.isStarting) {
      log("Telegram bot start already in progress", "warn");
      return;
    }
    
    if (this._isConnected && this.bot) {
      log("Telegram bot already started", "warn");
      return;
    }
    
    this.isStarting = true;
    log("Starting Telegram bot with improved connection handling...", "info");
    
    try {
      // Reset reconnect attempts if this is a manual start
      if (this.connectionState.status === 'disconnected') {
        this.reconnectAttempts = 0;
      }
      
      this.updateConnectionState('reconnecting');
      this.stopHeartbeat();
      
      // Cancel any pending forced reconnection
      if (this.forcedReconnectionTimer) {
        clearTimeout(this.forcedReconnectionTimer);
        this.forcedReconnectionTimer = null;
      }
      
      // BEFORE STARTING: Verify that the API is accessible and there are no conflicts
      // This pre-flight check helps prevent 409 errors during initialization
      try {
        log("Performing Telegram API pre-flight check...", "debug");
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        if (!process.env.TELEGRAM_BOT_TOKEN) {
          throw new Error("TELEGRAM_BOT_TOKEN environment variable is not set");
        }
        
        // First try to delete any existing webhook to prevent conflicts
        try {
          log("Attempting to clean webhook configuration...", "debug");
          const deleteWebhookResponse = await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/deleteWebhook?drop_pending_updates=true', {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              'User-Agent': 'TelegramBotBridge/1.0' 
            },
            signal: controller.signal
          });
          
          if (!deleteWebhookResponse.ok) {
            if (deleteWebhookResponse.status === 409) {
              // If we get a conflict here, we need to wait
              log("409 Conflict detected during webhook cleanup, delaying startup", "warn");
              await new Promise(resolve => setTimeout(resolve, 15000));
            } else {
              log(`Warning: Webhook deletion returned status ${deleteWebhookResponse.status}`, "warn");
            }
          } else {
            log("Webhook configuration cleaned successfully", "debug");
          }
        } catch (webhookError) {
          log(`Error during webhook cleanup: ${webhookError}`, "warn");
          // Wait a bit before continuing
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
        
        // Then check if the bot is accessible via getMe
        const response = await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/getMe', {
          method: 'GET',
          headers: { 
            'Content-Type': 'application/json',
            'User-Agent': 'TelegramBotBridge/1.0' 
          },
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (response.status === 409) {
          log("409 Conflict detected during pre-flight check - another instance is running", "error");
          // Wait significantly longer before proceeding
          await new Promise(resolve => setTimeout(resolve, 15000));
          
          // Try one more time with an exponential backoff
          log("Retrying pre-flight check after delay...", "debug");
          const retryResponse = await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/getMe', {
            method: 'GET',
            headers: { 
              'Content-Type': 'application/json',
              'User-Agent': 'TelegramBotBridge/1.0' 
            }
          });
          
          if (retryResponse.status === 409) {
            // If we still have conflict, throw an error
            throw new Error("409 Conflict: Another bot instance is running. Cannot start.");
          }
        } else if (!response.ok) {
          log(`Telegram API returned status ${response.status} during pre-flight check`, "warn");
        } else {
          log("Telegram API accessible, proceeding with initialization", "debug");
        }
      } catch (preFlightError) {
        log(`Error during Telegram pre-flight check: ${preFlightError}`, "warn");
        // Don't throw here - we'll attempt to start the bot anyway and let Telegraf handle errors
      }
      
      // Create new bot instance
      if (!process.env.TELEGRAM_BOT_TOKEN) {
        throw new Error("TELEGRAM_BOT_TOKEN environment variable is not set");
      }
      
      log("Creating new Telegram bot instance", "debug");
      log("Initializing Telegram bot with enhanced connection stability", "debug");
      // Prioritize environment variable for production deployments
      let token = process.env.TELEGRAM_BOT_TOKEN;
      
      // Fall back to token loader only if environment variable is missing
      if (!token) {
        try {
          const { loadTelegramToken } = await import('./token-loader');
          const loadedToken = loadTelegramToken();
          if (loadedToken) {
            token = loadedToken;
            log("Using token from token-loader as fallback", "info");
          }
        } catch (tokenLoaderError) {
          log(`Error using token-loader, falling back to environment: ${tokenLoaderError}`, "warn");
        }
      }
      
      if (!token) {
        throw new Error("Telegram bot token is missing. Please set TELEGRAM_BOT_TOKEN in your .env file.");
      }
      
      // Validate token format
      if (!token.includes(':')) {
        log(`Warning: Telegram token format appears invalid (should contain a colon ':'): ${token.substring(0, 5)}...`, "warn");
        // Continue anyway - some tokens may have unusual formats
      }
      
      // Create a new Telegram bot instance with enhanced stability settings
      // These settings are optimized for stability in challenging network environments
      const telegrafOptions = {
        telegram: {
          apiRoot: 'https://api.telegram.org',
          webhookReply: false,
        },
        handlerTimeout: 30000 // 30 seconds timeout for handlers
      };
      
      // Create with maximum network resilience
      log("Initializing Telegram bot with maximum connection stability settings", "debug");
      this.bot = new Telegraf(token, telegrafOptions);
      
      // Check connection
      const botInfo = await this.telegram.getMe();
      log(`Connected to Telegram as @${botInfo.username}`, "info");
      
      // Setup event handlers
      this.setupHandlers();
      
      // Just check db connection instead of preloading all user states
      // This addresses the slow startup issue without sacrificing functionality
      await this.checkDatabaseConnection();
      
      // Setup commands first (same for both environments)
      await this.bot.telegram.setMyCommands([
        { command: 'start', description: 'Start a new ticket' },
        { command: 'close', description: 'Close the current ticket' },
        { command: 'switch', description: 'Switch between active tickets' },
        { command: 'info', description: 'Show information about your tickets' },
        { command: 'ping', description: 'Ping staff for attention' }
      ]);
      
      // Setup error handling for network issues
      this.bot.catch((err, ctx) => {
        const errorStr = String(err).toLowerCase();
        
        // Check if it's a network-related error
        if (
          errorStr.includes('econnreset') || 
          errorStr.includes('timeout') || 
          errorStr.includes('socket') || 
          errorStr.includes('network')
        ) {
          log(`Network error in Telegram bot handler: ${err}`, "warn");
          
          // Increment failed heartbeat to trigger reconnection if needed
          this.failedHeartbeats++;
          
          // Force immediate heartbeat check if we've seen multiple network errors
          if (this.failedHeartbeats >= 2) {
            log("Multiple network errors detected, triggering immediate connection check", "warn");
            this.handleHeartbeat().catch(e => {
              log(`Error in forced heartbeat: ${e}`, "error");
            });
          }
        } else {
          // For non-network errors, just log normally
          log(`Error in Telegram bot handler: ${err}`, "error");
        }
      });
      
      // Start polling for updates with custom parameters for better reliability
      if (process.env.NODE_ENV === 'production') {
        log("Using production launch configuration with enhanced network resilience", "info");
        
        // Force-kill any other bot instances by stopping first
        // This helps prevent 409 conflicts
        try {
          log("Stopping any existing bot instances before launching...", "info");
          await this.bot.telegram.deleteWebhook({ drop_pending_updates: true });
          
          // Additional small delay to ensure webhook is fully removed
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (webhookError) {
          log(`Warning: Could not delete webhook: ${webhookError}`, "warn");
          // Continue anyway, as this is just a precaution
        }
        
        log("Launching with conflict prevention in production mode", "info");
        
        // Add a small random delay before launching to prevent multiple instances
        // from connecting at the exact same time (mitigating conflicts)
        const randomStartupDelay = Math.floor(Math.random() * 3000) + 1000; // 1-4 seconds
        log(`Adding random startup delay of ${randomStartupDelay}ms to prevent conflicts`, "debug");
        await new Promise(resolve => setTimeout(resolve, randomStartupDelay));
        
        // Explicitly use the standard launch method with enhanced stability
        // Note: Launch options vary by Telegraf version, need to use compatible format
        await this.bot.launch({
          // Add options that don't cause type errors
          dropPendingUpdates: false,
          allowedUpdates: [
            'message',
            'callback_query',
            'inline_query'
          ]
        });
        
        log("Telegram bot launched in production mode with enhanced network reliability", "info");
      } else {
        // Development environment configuration - with enhanced stability
        const developmentPollingParams = {
          // Also limit updates
          allowed_updates: ['message', 'callback_query', 'inline_query', 'channel_post', 'edited_message'],
          // Don't drop updates in development
          drop_pending_updates: false,
          // Use shorter timeout in development for faster reconnection
          timeout: 20
        };
        
        // In development mode, also use standard launch
        await this.bot.launch();
        
        log("Telegram bot launched in development mode with standard polling", "info");
      }
      
      // Start recurring tasks
      this.startHeartbeat();
      this.startCleanupInterval();
      
      // Update state
      this._isConnected = true;
      this.updateConnectionState('connected');
      this.failedHeartbeats = 0;
      this.lastHeartbeatSuccess = Date.now();
      
      log("Telegram bot started successfully", "info");
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log(`Error starting Telegram bot: ${errorMsg}`, "error");
      
      // Check for conflict error (another bot instance running)
      if (errorMsg.includes("409") || errorMsg.includes("Conflict")) {
        log("409 Conflict detected - another bot instance is already running", "error");
      }
      
      this.updateConnectionState('disconnected', errorMsg);
      this._isConnected = false;
      throw error;
    } finally {
      this.isStarting = false;
    }
  }

  async stop() {
    log("Stopping Telegram bot...", "info");
    
    try {
      this.stopHeartbeat();
      
      if (this.bot) {
        await this.bot.stop();
        this.bot = null;
      }
      
      this.rateLimitManager.stop();
      this._isConnected = false;
      this.updateConnectionState('disconnected');
      
      log("Telegram bot stopped successfully", "info");
    } catch (error) {
      log(`Error stopping Telegram bot: ${error}`, "error");
      throw error;
    }
  }

  getIsConnected(): boolean {
    return this._isConnected;
  }

  isStartingProcess(): boolean {
    return this.isStarting;
  }

  getLastError(): string | undefined {
    return this.connectionState.lastError;
  }
  
  async getFile(fileId: string) {
    try {
      // Use the telegram getter for null safety
      return await this.telegram.getFile(fileId);
    } catch (error) {
      log(`Error getting file: ${error}`, "error");
      throw error;
    }
  }

  async sendMessage(chatId: number | string, text: string, attemptNumber = 0): Promise<void> {
    try {
      // Convert chatId to number if it's a string
      const numericChatId = typeof chatId === 'string' ? parseInt(chatId, 10) : chatId;
      
      // Check if the bot is connected
      if (!this._isConnected || !this.bot) {
        if (attemptNumber === 0) {
          log(`Bot not connected when trying to send message to ${chatId}, initiating reconnection`, "warn");
          
          // Try to reconnect the bot
          try {
            await this.start();
            log("Successfully reconnected bot while sending message", "info");
            
            // Wait a moment for the connection to stabilize
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Try again after reconnection (recursive with attempt tracking)
            return this.sendMessage(chatId, text, attemptNumber + 1);
          } catch (reconnectError) {
            log(`Failed to reconnect bot during message send: ${reconnectError}`, "error");
            throw new Error(`Cannot send message - bot disconnected and reconnection failed: ${reconnectError}`);
          }
        } else {
          throw new Error("Bot still not connected after reconnection attempt");
        }
      }
      
      // Use the telegram getter for null safety
      await this.telegram.sendMessage(numericChatId, preserveMarkdown(text), {
        parse_mode: "MarkdownV2"
      });
      
      // Reset failed heartbeats on successful message
      this.failedHeartbeats = 0;
      this.lastHeartbeatSuccess = Date.now();
      log(`Successfully sent message to ${chatId}`, "debug");
    } catch (error) {
      log(`Error sending message to ${chatId}: ${error}`, "error");
      
      // Handle specific error conditions
      const errorStr = String(error).toLowerCase();
      
      // For "bot not initialized" errors, we've already tried to reconnect above
      // but we can attempt emergency retry for network errors
      if ((errorStr.includes('network') || errorStr.includes('timeout')) && attemptNumber < 2) {
        log(`Network error while sending message, trying emergency retry (attempt ${attemptNumber + 1})`, "warn");
        await new Promise(resolve => setTimeout(resolve, 2000));
        return this.sendMessage(chatId, text, attemptNumber + 1);
      }
      
      throw error;
    }
  }

  async sendPhoto(chatId: number | string, photo: Buffer | string, caption?: string, attemptNumber = 0): Promise<string | undefined> {
    try {
      // Convert chatId to number if it's a string
      const numericChatId = typeof chatId === 'string' ? parseInt(chatId, 10) : chatId;
      
      // Check if the bot is connected
      if (!this._isConnected || !this.bot) {
        if (attemptNumber === 0) {
          log(`Bot not connected when trying to send photo to ${chatId}, initiating reconnection`, "warn");
          
          // Try to reconnect the bot
          try {
            await this.start();
            log("Successfully reconnected bot while sending photo", "info");
            
            // Wait a moment for the connection to stabilize
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Try again after reconnection (recursive with attempt tracking)
            return this.sendPhoto(chatId, photo, caption, attemptNumber + 1);
          } catch (reconnectError) {
            log(`Failed to reconnect bot during photo send: ${reconnectError}`, "error");
            throw new Error(`Cannot send photo - bot disconnected and reconnection failed: ${reconnectError}`);
          }
        } else {
          throw new Error("Bot still not connected after reconnection attempt");
        }
      }
      
      log(`Sending photo to chat ${chatId}`);
      let sentMessage;

      // If photo is a URL, download it first
      if (typeof photo === 'string' && photo.startsWith('http')) {
        const response = await fetch(photo);
        const buffer = await response.buffer();
        sentMessage = await this.telegram.sendPhoto(numericChatId, { source: buffer }, {
          caption: caption ? preserveMarkdown(caption) : undefined,
          parse_mode: "MarkdownV2"
        });
      } else if (photo instanceof Buffer) {
        // Handle buffer by using InputFile format
        sentMessage = await this.telegram.sendPhoto(numericChatId, { source: photo }, {
          caption: caption ? preserveMarkdown(caption) : undefined,
          parse_mode: "MarkdownV2"
        });
      } else {
        // Handle file_id string
        sentMessage = await this.telegram.sendPhoto(numericChatId, photo, {
          caption: caption ? preserveMarkdown(caption) : undefined,
          parse_mode: "MarkdownV2"
        });
      }

      // Reset failed heartbeats on successful photo send
      this.failedHeartbeats = 0;
      this.lastHeartbeatSuccess = Date.now();

      // Return the file_id for caching
      if (sentMessage?.photo && sentMessage.photo.length > 0) {
        const fileId = sentMessage.photo[sentMessage.photo.length - 1].file_id;
        log(`Got file_id ${fileId} for photo`);
        return fileId;
      }

      log(`Successfully sent photo to chat ${chatId}`);
      return undefined;
    } catch (error) {
      log(`Error sending photo to ${chatId}: ${error}`, "error");
      
      // Handle specific error conditions
      const errorStr = String(error).toLowerCase();
      
      // For "bot not initialized" errors, we've already tried to reconnect above
      // but we can attempt emergency retry for network errors
      if ((errorStr.includes('network') || errorStr.includes('timeout')) && attemptNumber < 2) {
        log(`Network error while sending photo, trying emergency retry (attempt ${attemptNumber + 1})`, "warn");
        await new Promise(resolve => setTimeout(resolve, 2000));
        return this.sendPhoto(chatId, photo, caption, attemptNumber + 1);
      }
      
      throw error;
    }
  }

  async sendCachedPhoto(chatId: number | string, fileId: string, caption?: string, attemptNumber = 0): Promise<void> {
    try {
      // Convert chatId to number if it's a string
      const numericChatId = typeof chatId === 'string' ? parseInt(chatId, 10) : chatId;
      
      // Check if the bot is connected
      if (!this._isConnected || !this.bot) {
        if (attemptNumber === 0) {
          log(`Bot not connected when trying to send cached photo to ${chatId}, initiating reconnection`, "warn");
          
          // Try to reconnect the bot
          try {
            await this.start();
            log("Successfully reconnected bot while sending cached photo", "info");
            
            // Wait a moment for the connection to stabilize
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Try again after reconnection (recursive with attempt tracking)
            return this.sendCachedPhoto(chatId, fileId, caption, attemptNumber + 1);
          } catch (reconnectError) {
            log(`Failed to reconnect bot during cached photo send: ${reconnectError}`, "error");
            throw new Error(`Cannot send cached photo - bot disconnected and reconnection failed: ${reconnectError}`);
          }
        } else {
          throw new Error("Bot still not connected after reconnection attempt");
        }
      }
      
      await this.telegram.sendPhoto(numericChatId, fileId, {
        caption: caption ? preserveMarkdown(caption) : undefined,
        parse_mode: "MarkdownV2"
      });

      // Reset failed heartbeats on successful photo send
      this.failedHeartbeats = 0;
      this.lastHeartbeatSuccess = Date.now();
      
      log(`Successfully sent cached photo (${fileId}) to chat ${chatId}`);
    } catch (error) {
      log(`Error sending cached photo to ${chatId}: ${error}`, "error");
      
      // Handle specific error conditions
      const errorStr = String(error).toLowerCase();
      
      // For "bot not initialized" errors, we've already tried to reconnect above
      // but we can attempt emergency retry for network errors
      if ((errorStr.includes('network') || errorStr.includes('timeout')) && attemptNumber < 2) {
        log(`Network error while sending cached photo, trying emergency retry (attempt ${attemptNumber + 1})`, "warn");
        await new Promise(resolve => setTimeout(resolve, 2000));
        return this.sendCachedPhoto(chatId, fileId, caption, attemptNumber + 1);
      }
      
      throw error;
    }
  }

  private async checkActiveUsers(userId: number): Promise<boolean> {
    // Clean up disconnected users first
    for (const activeId of this.activeUsers) {
      try {
        // Use telegram getter for null safety
        await this.telegram.getChat(activeId);
      } catch (error) {
        this.activeUsers.delete(activeId);
        this.userStates.delete(activeId);
        this.stateCleanups.delete(activeId);
        log(`Removed inactive user ${activeId}`);
      }
    }

    // Check if we can add new user
    if (!this.activeUsers.has(userId)) {
      if (this.activeUsers.size >= this.MAX_CONCURRENT_USERS) {
        return false;
      }
      this.activeUsers.add(userId);
    }
    return true;
  }

  private async handleTicketMessage(ctx: Context, user: any, ticket: any) {
    if (!ctx.message || !('text' in ctx.message)) return;

    const userId = ctx.from?.id;
    if (!userId) return;

    // Get user state before rate limit check
    const state = this.userStates.get(userId);
    log(`Received message from user ${userId}. Current state: ${JSON.stringify(state)}`);

    // Log the telegramId as a string to help diagnose issues
    const telegramIdStr = userId.toString();
    log(`Telegram ID as string: ${telegramIdStr} for ticket ${ticket.id}`);

    // Log the full ticket and user objects to help diagnose issues
    log(`Full ticket object: ${JSON.stringify(ticket)}`);
    log(`Full user object: ${JSON.stringify(user)}`);

    if (!this.checkRateLimit(userId, 'message')) {
      await ctx.reply("⚠️ You are sending messages too fast. Please wait a moment.");
      return;
    }

    try {
      // If we're in a questionnaire, handle that first
      if (state?.inQuestionnaire) {
        await this.handleQuestionnaireResponse(ctx, state);
        return;
      }

      // Check if user still has this specific active ticket
      const activeTickets = await storage.getActiveTicketsByUserId(user.id);
      const isActiveTicket = activeTickets.some(t => t.id === ticket.id);
      
      if (!isActiveTicket) {
        await ctx.reply("❌ This ticket is no longer active. Use /start to create a new ticket.");
        return;
      }

      // Process message
      // Note: Removed the paid notification message as requested
      
      // Get user display name for the transcript
      const senderName = user.telegramName || user.telegramUsername || user.username || 'Telegram User';
      
      await storage.createMessage({
        ticketId: ticket.id,
        content: ctx.message.text,
        authorId: user.id,
        platform: "telegram",
        timestamp: new Date(),
        senderName: senderName
      });

      let avatarUrl: string | undefined;
      try {
        // Use telegram getter for null safety
        const photos = await this.telegram.getUserProfilePhotos(ctx.from.id, 0, 1);
        if (photos && photos.total_count > 0) {
          const fileId = photos.photos[0][0].file_id;
          const file = await this.telegram.getFile(fileId);
          if (file?.file_path) {
            avatarUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
          }
        }
      } catch (error) {
        log(`Error getting Telegram user avatar: ${error}`, "error");
      }

      // Get user's first and last name
      const firstName = ctx.from?.first_name || "";
      const lastName = ctx.from?.last_name || "";
      const displayName = [firstName, lastName].filter(Boolean).join(' ') || "Telegram User";

      await this.bridge.forwardToDiscord(
        ctx.message.text,
        ticket.id,
        displayName,
        avatarUrl,
        undefined,
        firstName,
        lastName,
        userId
      );

      log(`Message processed successfully for ticket ${ticket.id}`);
    } catch (error) {
      log(`Error in handleTicketMessage: ${error}`, "error");
      await ctx.reply("Sorry, there was an error processing your message. Please try again.");
    }
  }

  private async handleCategoryMenu(ctx: Context) {
    try {
      // Fetch bot config and categories in parallel to improve performance
      const [botConfig, categories] = await Promise.all([
        storage.getBotConfig(),
        storage.getCategories()
      ]);

      // Filter categories - do this in a single pass for better performance
      const submenus = [];
      const rootCategories = [];
      
      for (const cat of categories) {
        if (cat.isSubmenu) {
          submenus.push(cat);
        } else if (!cat.parentId) {
          rootCategories.push(cat);
        }
      }

      // Build keyboard layout
      const keyboard: { text: string; callback_data: string; }[][] = [];
      let currentRow: { text: string; callback_data: string; }[] = [];

      // Process submenus
      const processCategories = (categoryList: any[]) => {
        for (const category of categoryList) {
          const button = {
            text: category.isClosed ? `🔴 ${category.name}` : category.name,
            callback_data: category.isSubmenu ? `submenu_${category.id}` : `category_${category.id}`
          };
  
          if (category.newRow && currentRow.length > 0) {
            keyboard.push([...currentRow]);
            currentRow = [button];
          } else {
            currentRow.push(button);
            if (currentRow.length >= 2) {
              keyboard.push([...currentRow]);
              currentRow = [];
            }
          }
        }
      };
      
      // Process both types of categories
      processCategories(submenus);
      processCategories(rootCategories);

      if (currentRow.length > 0) {
        keyboard.push(currentRow);
      }

      // Use our new preserveMarkdown function to keep markdown formatting while escaping special chars
      let welcomeMessage = botConfig?.welcomeMessage || "Welcome to the support bot! Please select a service:";
      
      // Add clear visual separator and instructions
      welcomeMessage = `━━━━━━━━━━━━━━━━━━━━━━\n🎫 *Create a new support ticket*\n\n${welcomeMessage}\n\n⚠️ *Please select a service category below*\n*This will start a new ticket creation process.*\n━━━━━━━━━━━━━━━━━━━━━━`;
      
      // Preserve markdown in the enhanced message (calculate this once)
      const formattedMessage = preserveMarkdown(welcomeMessage);
      const welcomeImageUrl = botConfig?.welcomeImageUrl;

      // Ensure we have a valid message ID to edit by checking both the callbackQuery and message
      const hasMessageId = 
        ctx.callbackQuery && 
        ctx.callbackQuery.message && 
        ('message_id' in ctx.callbackQuery.message) && 
        ctx.callbackQuery.message.message_id;

      const hasText = 
        ctx.callbackQuery?.message && 
        'text' in ctx.callbackQuery.message && 
        ctx.callbackQuery.message.text;

      // Standard message options to reuse
      const messageOptions = {
        parse_mode: "MarkdownV2" as const,
        reply_markup: { inline_keyboard: keyboard }
      };
      
      try {
        // Only try to edit if we have both a message ID and text content
        if (hasMessageId && hasText && ctx.callbackQuery) {
          try {
            // Try to edit the existing message
            await ctx.editMessageText(formattedMessage, messageOptions);
            
            // Answer the callback query to stop loading indicator
            await ctx.answerCbQuery();
          } catch (error) {
            // If editing fails, send a new message
            if (welcomeImageUrl) {
              await ctx.replyWithPhoto(welcomeImageUrl, {
                caption: formattedMessage,
                ...messageOptions
              });
            } else {
              await ctx.reply(formattedMessage, messageOptions);
            }
            
            // Answer the callback query
            if (ctx.callbackQuery) {
              await ctx.answerCbQuery();
            }
          }
        } else {
          // Cannot edit, so send a new message
          if (welcomeImageUrl) {
            await ctx.replyWithPhoto(welcomeImageUrl, {
              caption: formattedMessage,
              ...messageOptions
            });
          } else {
            await ctx.reply(formattedMessage, messageOptions);
          }
          
          // Answer the callback query if applicable
          if (ctx.callbackQuery) {
            await ctx.answerCbQuery();
          }
        }
      } catch (error) {
        // Handle any errors and provide a basic fallback
        await ctx.reply(formattedMessage, messageOptions);
        
        // Always answer callback query if present
        if (ctx.callbackQuery) {
          await ctx.answerCbQuery("Error loading menu").catch(() => {});
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log(`Error in handleCategoryMenu: ${errorMsg}`, "error");
      await ctx.reply("❌ There was an error displaying the menu. Please try again.");
      
      // Always answer callback query if present
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery().catch(() => {});
      }
    }
  }

  private async handleCategorySelection(ctx: Context, categoryId: number) {
    try {
      const userId = ctx.from?.id;
      if (!userId) return;

      if (!this.checkRateLimit(userId, 'command', 'category')) {
        await ctx.reply("⚠️ Please wait before selecting another category.");
        return;
      }

      const category = await storage.getCategory(categoryId);
      if (!category) {
        await ctx.reply("❌ Category not found.");
        return;
      }
      
      // Check if the service is closed
      if (category.isClosed) {
        await ctx.reply("⛔ This service is currently closed. Please try another service or contact an administrator.");
        return;
      }
      
      // Get the user record
      const user = await storage.getUserByTelegramId(userId.toString());
      if (!user) {
        await ctx.reply("❌ Error: User record not found. Please use /start to begin again.");
        return;
      }
      
      // Get all active tickets for this user
      const activeTickets = await storage.getActiveTicketsByUserId(user.id);
      
      // Check if there's already a ticket in the same category
      const existingTicketInCategory = activeTickets.find(ticket => ticket.categoryId === categoryId);
      
      if (existingTicketInCategory) {
        log(`User ${user.id} already has ticket ${existingTicketInCategory.id} in category ${categoryId}`);
        
        // Create a state pointing to the existing ticket
        const state: UserState = {
          categoryId,
          currentQuestion: 0,
          answers: [],
          inQuestionnaire: false,
          activeTicketId: existingTicketInCategory.id,
          lastUpdated: Date.now()
        };
        
        await this.setState(userId, state);
        
        // Notify the user they already have a ticket in this category, with specific category name
        const categoryName = category ? category.name : "this category";
        await ctx.reply(`ℹ️ You already have an active ${categoryName} ticket (#${existingTicketInCategory.id}).

You have two options:
1️⃣ Type /close to close your existing ${categoryName} ticket, then try again
2️⃣ Select a different service instead to keep your ${categoryName} ticket active

Only one active ticket per service is allowed.`);
        
        // Provide context about using /switch
        await ctx.reply("Use /switch to see all your active tickets and choose which one to continue.");
        
        return;
      }

      // Display service image and summary if available
      if (category.serviceImageUrl) {
        try {
          await ctx.replyWithPhoto(
            category.serviceImageUrl,
            {
              caption: category.serviceSummary ? preserveMarkdown(category.serviceSummary) : undefined,
              parse_mode: "MarkdownV2"
            }
          );
        } catch (error) {
          log(`Error sending service image: ${error}`, "error");
          // If image fails, still show the summary as text
          if (category.serviceSummary) {
            await ctx.reply(preserveMarkdown(category.serviceSummary), {
              parse_mode: "MarkdownV2"
            });
          }
        }
      } else if (category.serviceSummary) {
        // If no image but has summary, show summary as text
        await ctx.reply(preserveMarkdown(category.serviceSummary), {
          parse_mode: "MarkdownV2"
        });
      }

      // Get the questions for this category
      const questions = category.questions || [];
      if (questions.length === 0) {
        await ctx.reply("❌ No questions configured for this category.");
        return;
      }

      // Initialize questionnaire state
      const state: UserState = {
        categoryId,
        currentQuestion: 0,
        answers: [],
        inQuestionnaire: true,
        activeTicketId: undefined
      };
      this.setState(userId, state);

      // Ask first question with clear context
      // Show progress indication and separator
      const questionProgress = `*Question 1/${questions.length}*`;
      const questionText = preserveMarkdown(`━━━━━━━━━━━━━━━━━━━━━━\n${questionProgress}\n\n${questions[0]}\n\n⚠️ *Please answer each question to complete your ticket*\n━━━━━━━━━━━━━━━━━━━━━━`);
        
      await ctx.reply(questionText, {
        parse_mode: "MarkdownV2"
      });

    } catch (error) {
      log(`Error in handleCategorySelection: ${error}`, "error");
      await ctx.reply("❌ There was an error processing your selection. Please try again.");
    }
  }

  private async handleSubmenuClick(ctx: Context, submenuId: number) {
    try {
      const submenu = await storage.getCategory(submenuId);
      if (!submenu) {
        await ctx.reply("❌ Submenu not found.");
        return;
      }

      const categories = await storage.getCategories();
      const submenuCategories = categories.filter(cat => cat.parentId === submenuId);

      const keyboard: { text: string; callback_data: string; }[][] = [];
      let currentRow: { text: string; callback_data: string; }[] = [];

      for (const category of submenuCategories) {
        const button = {
          text: category.isClosed ? `🔴 ${category.name}` : category.name,
          callback_data: `category_${category.id}`
        };

        if (category.newRow && currentRow.length > 0) {
          keyboard.push([...currentRow]);
          currentRow = [button];
        } else {
          currentRow.push(button);
          if (currentRow.length >= 2) {
            keyboard.push([...currentRow]);
            currentRow = [];
          }
        }
      }

      if (currentRow.length > 0) {
        keyboard.push(currentRow);
      }

      // Add a "Back" button
      keyboard.push([{
        text: "↩️ Back",
        callback_data: "back_to_main"
      }]);

      // Add clear instructions with the submenu selection
      const message = `━━━━━━━━━━━━━━━━━━━━━━\n🎫 *Create a new support ticket*\n\nPlease select a service from *${submenu.name}*:\n\n⚠️ *This will start a new ticket creation process.*\n━━━━━━━━━━━━━━━━━━━━━━`;
      
      // Preserve markdown in the message
      const formattedMessage = preserveMarkdown(message);

      // Ensure we have a valid message ID to edit by checking both the callbackQuery and message
      const hasMessageId = 
        ctx.callbackQuery && 
        ctx.callbackQuery.message && 
        ('message_id' in ctx.callbackQuery.message) && 
        ctx.callbackQuery.message.message_id;

      const hasText = 
        ctx.callbackQuery?.message && 
        'text' in ctx.callbackQuery.message && 
        ctx.callbackQuery.message.text;

      // Only try to edit if we have both a message ID and text content
      if (hasMessageId && hasText) {
        try {
          await ctx.editMessageText(formattedMessage, {
            parse_mode: "MarkdownV2",
            reply_markup: { inline_keyboard: keyboard }
          });
          
          // Answer the callback query to stop loading indicator
          if (ctx.callbackQuery) {
            await ctx.answerCbQuery();
          }
        } catch (error) {
          log(`Error editing message: ${error}`, "warn");
          
          // If editing fails, send a new message, but include a debug log to understand why
          log(`Message details: id=${ctx.callbackQuery?.message?.message_id}, hasText=${!!hasText}`, "debug");

          await ctx.reply(formattedMessage, {
            parse_mode: "MarkdownV2",
            reply_markup: { inline_keyboard: keyboard }
          });
          
          if (ctx.callbackQuery) {
            await ctx.answerCbQuery();
          }
        }
      } else {
        // Cannot edit, so send a new message
        log(`Cannot edit message - missing message ID or text content. hasMessageId=${!!hasMessageId}, hasText=${!!hasText}`, "debug");
        
        await ctx.reply(formattedMessage, {
          parse_mode: "MarkdownV2",
          reply_markup: { inline_keyboard: keyboard }
        });
        
        if (ctx.callbackQuery) {
          await ctx.answerCbQuery();
        }
      }

      log(`Successfully displayed submenu options for submenu ${submenuId}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log(`Error in handleSubmenuClick: ${errorMsg}`, "error");
      
      // Don't send a reply if it's a query timeout error, as it will just fail again
      if (!errorMsg.includes("query is too old") && !errorMsg.includes("query ID is invalid")) {
        try {
          await ctx.reply("❌ There was an error displaying the menu. Please try /start again.");
        } catch (replyError) {
          log(`Error sending error reply: ${replyError}`, "error");
        }
      }
      
      // Make sure we always answer the callback query to stop the loading indicator
      if (ctx.callbackQuery) {
        try {
          await ctx.answerCbQuery("Menu loading error").catch(() => {});
        } catch (ackError) {
          // Silent catch - likely a query timeout error
          log(`Failed to answer callback query: ${ackError}`, "debug");
        }
      }
    }
  }

  private async handleQuestionnaireResponse(ctx: Context, state: UserState) {
    if (!ctx.from?.id || !ctx.message || !('text' in ctx.message)) return;
    
    try {
      const userId = ctx.from.id;
      const user = await storage.getUserByTelegramId(userId.toString());
      if (!user) {
        await ctx.reply("❌ Error: User not found. Please use /start to begin again.");
        return;
      }
      
      const category = await storage.getCategory(state.categoryId);
      if (!category) {
        await ctx.reply("❌ Error: Category not found. Please use /start to begin again.");
        return;
      }
      
      // Check if the service is closed
      if (category.isClosed) {
        await ctx.reply("⛔ This service is currently closed. Please try another service or contact an administrator.");
        // Clear the questionnaire state
        this.userStates.delete(userId);
        if (this.stateCleanups.has(userId)) {
          clearTimeout(this.stateCleanups.get(userId)!.timeout);
          this.stateCleanups.delete(userId);
        }
        return;
      }
      
      // Get the questions for this category
      const questions = category.questions || [];
      if (questions.length === 0) {
        await ctx.reply("❌ Error: No questions found for this category. Please contact an admin.");
        this.userStates.delete(userId);
        return;
      }
      
      // Store the answer
      state.answers[state.currentQuestion] = ctx.message.text;
      
      // Move to the next question or create ticket if all questions answered
      if (state.currentQuestion + 1 < questions.length) {
        // Move to next question
        state.currentQuestion++;
        this.setState(userId, state);
        
        // Ask the next question with clear context
        // Show progress indication
        const questionProgress = `*Question ${state.currentQuestion + 1}/${questions.length}*`;
        const questionText = preserveMarkdown(`━━━━━━━━━━━━━━━━━━━━━━\n${questionProgress}\n\n${questions[state.currentQuestion]}\n\n⚠️ *Please answer each question to complete your ticket*\n━━━━━━━━━━━━━━━━━━━━━━`);
        
        await ctx.reply(questionText, {
          parse_mode: "MarkdownV2"
        });
      } else {
        // All questions answered, create the ticket
        await this.createTicket(ctx);
      }
    } catch (error) {
      log(`Error in handleQuestionnaireResponse: ${error}`, "error");
      await ctx.reply("❌ There was an error processing your response. Please try again or use /cancel to start over.");
    }
  }

  private async createTicket(ctx: Context) {
    if (!ctx.from?.id) return;
    
    try {
      const userId = ctx.from.id;
      const state = this.userStates.get(userId);
      if (!state) {
        await ctx.reply("❌ Error: Session expired. Please use /start to begin again.");
        return;
      }
      
      // Get the user
      const user = await storage.getUserByTelegramId(userId.toString());
      if (!user) {
        await ctx.reply("❌ Error: User not found. Please use /start to begin again.");
        return;
      }
      
      // Get the category
      const category = await storage.getCategory(state.categoryId);
      if (!category) {
        await ctx.reply("❌ Error: Category not found. Please use /start to begin again.");
        return;
      }
      
      // Check if the service is closed
      if (category.isClosed) {
        await ctx.reply("⛔ This service is currently closed. Please try another service or contact an administrator.");
        return;
      }
      
      // Check for existing active tickets (open, in-progress, pending, etc.)
      // Get all active tickets for this user
      const activeTickets = await storage.getActiveTicketsByUserId(user.id);
      
      // Check if there's already a ticket in the same category
      const existingTicketInCategory = activeTickets.find(ticket => ticket.categoryId === state.categoryId);
      
      if (existingTicketInCategory) {
        console.log(`User ${user.id} already has ticket ${existingTicketInCategory.id} in category ${state.categoryId}`);
        
        // Update state to reference this existing ticket
        state.inQuestionnaire = false;
        state.activeTicketId = existingTicketInCategory.id;
        this.setState(userId, state);
        
        // Notify the user they already have a ticket in this category with specific category name
        const categoryName = category ? category.name : "this category";
        await ctx.reply(`ℹ️ You already have an active ${categoryName} ticket (#${existingTicketInCategory.id}).

You have two options:
1️⃣ Type /close to close your existing ${categoryName} ticket, then try again
2️⃣ Select a different service instead to keep your ${categoryName} ticket active

Only one active ticket per service is allowed.`);
        
        // Provide context about using /switch and check if user has other tickets
        const otherActiveTickets = activeTickets.filter(t => t.id !== existingTicketInCategory.id);
        if (otherActiveTickets.length > 0) {
          // User has other active tickets besides this one
          await ctx.reply("You have multiple active tickets. Use /switch to see all your active tickets and choose which one to continue.");
        } else {
          await ctx.reply("Use /switch if you need to see your active ticket details.");
        }
        
        return;
      }
      
      // If we're here, there's no ticket in this category (though the user may have tickets in other categories)
      
      // Create the ticket
      const ticket = await storage.createTicket({
        userId: user.id,
        categoryId: state.categoryId,
        status: "pending",
        answers: state.answers
      });
      
      log(`Created ticket ${ticket.id} for user ${user.id} in category ${state.categoryId}`);
      
      // Update user state
      state.inQuestionnaire = false;
      state.activeTicketId = ticket.id;
      this.setState(userId, state);
      
      // Check if user has other active tickets and notify in those channels
      try {
        const otherTickets = await storage.getActiveTicketsByUserId(user.id);
        for (const otherTicket of otherTickets) {
          if (otherTicket.id !== ticket.id && otherTicket.discordChannelId) {
            // Send notification to other active ticket channels
            await this.bridge.sendSystemMessageToDiscord(
              otherTicket.discordChannelId, 
              `**Note:** User has created a new ticket #${ticket.id} in the ${(await storage.getCategory(state.categoryId))?.name || "unknown"} category.`,
              {
                showForceButton: true,
                telegramId: user.telegramId || 0, // Using 0 as fallback for numeric type
                ticketId: otherTicket.id, // Button to force back to THIS ticket
                username: user.telegramName || user.username
              }
            );
          }
        }
      } catch (error) {
        log(`Failed to send notifications to other tickets: ${error}`, "error");
        // Continue even if notifications fail
      }
      
      // Try to create Discord channel
      try {
        await this.bridge.createTicketChannel(ticket);
        
        // Only send confirmation message, no ticket summary
        await ctx.reply(`━━━━━━━━━━━━━━━━━━━━━━\n✅ *Ticket created successfully!*\n\n*You are now in:* ${category.name} (#${ticket.id})\n\n⚠️ *All your messages will be sent to our staff in this ticket. They will respond here.*\n━━━━━━━━━━━━━━━━━━━━━━`, {
          parse_mode: 'Markdown'
        });
      } catch (error) {
        log(`Error creating Discord channel: ${error}`, "error");
        
        // Still mark ticket as created, just without channel
        await ctx.reply("✅ Your ticket has been created, but there was an issue setting up the support channel. A staff member will assist you shortly.");
      }
    } catch (error) {
      log(`Error in createTicket: ${error}`, "error");
      await ctx.reply("❌ There was an error creating your ticket. Please try again or contact an administrator.");
    }
  }

  /**
   * Just verify database connection without loading all states
   * This is much faster than the full restoreUserStates method
   */
  private async checkDatabaseConnection(): Promise<void> {
    try {
      // Simple query to verify DB connection is working
      const users = await storage.getUsers();
      log(`Database connection verified, found ${users.length} users`, "info");
      
      // Check if any users have active tickets that need handling
      log(`Using lazy loading for user states - will load states on demand when users interact with the bot`, "info");
    } catch (dbError) {
      log(`Critical error: Cannot connect to database: ${dbError}`, "error");
      throw new Error(`Database connection failed: ${dbError}`);
    }
  }

  private async restoreUserStates(): Promise<void> {
    try {
      log("Starting user state restoration process...", "info");
      
      // Step 1: Track metrics for debugging
      let restoredCount = 0;
      let failedCount = 0;
      let recoveredFromTicketCount = 0;
      let recoveredFromStateCount = 0;
      
      // Step 2: First check if the database is accessible
      try {
        // Simple query to verify DB connection
        const users = await storage.getUsers();
        log(`Database connection verified, found ${users.length} users`, "info");
      } catch (dbError) {
        log(`Critical error: Cannot connect to database during state restoration: ${dbError}`, "error");
        log("Will retry state restoration in 10 seconds...", "warn");
        
        // Schedule a retry
        setTimeout(() => {
          this.restoreUserStates().catch(e => {
            log(`Retry of state restoration also failed: ${e}`, "error");
          });
        }, 10000);
        return;
      }
      
      // Step 3: Query all users with active state to minimize database queries
      log("Querying all active states from the database", "debug");
      
      // First collect all active states by telegramId
      const activeStates = new Map<string, { user: any, stateString: string }>();
      const users = await storage.getUsers();
      
      if (!users || users.length === 0) {
        log(`No users found to restore states for`, "info");
        return;
      }
      
      // Step 4: Process all users with active tickets or states
      log(`Processing ${users.length} users for state restoration`, "debug");
      
      for (const user of users) {
        if (!user.telegramId) {
          log(`Skipping user ${user.id} with no telegramId`, "debug");
          continue;
        }
        
        try {
          // Step 4a: Get persisted state and check for active tickets in a single step
          log(`[DB] Checking for active tickets for user ${user.id}`);
          
          // Track restore status for this user
          let stateRestored = false;
          
          // Get the last persisted state from the database
          const stateString = await storage.getUserStateByTelegramId(user.telegramId);
          
          // Initialize empty state
          let state: UserState | null = null;
          
          // Step 4b: First priority - restore from saved database state if available
          if (stateString) {
            try {
              // Parse the state
              state = JSON.parse(stateString) as UserState;
              
              // Check if the state is still valid
              const lastUpdateTime = state.lastUpdated || 0;
              const stateAgeMinutes = (Date.now() - lastUpdateTime) / (1000 * 60);
              const maxStateAgeMinutes = state.inQuestionnaire ? 30 : 120; // 30 mins for questionnaire, 2 hours for active tickets
              
              // Validate state freshness
              if (stateAgeMinutes < maxStateAgeMinutes) {
                // Check if the referenced ticket still exists/is active
                if (state.activeTicketId) {
                  const ticketExists = await storage.getTicket(state.activeTicketId);
                  
                  if (ticketExists) {
                    // Check if status is still active
                    const validStatuses = ['pending', 'open', 'in-progress'];
                    const isPaidTicket = ticketExists.amount && ticketExists.amount > 0;
                    
                    if (validStatuses.includes(ticketExists.status) || isPaidTicket) {
                      log(`[DB] Validated active ticket #${state.activeTicketId} (${ticketExists.status}) for user ${user.id}`, "debug");
                      stateRestored = true;
                      recoveredFromStateCount++;
                    } else {
                      log(`[DB] Found ticket #${state.activeTicketId} but status '${ticketExists.status}' is not active`, "debug");
                      // Only reset activeTicketId but keep other state info in case user was in questionnaire
                      if (!state.inQuestionnaire) {
                        state.activeTicketId = undefined;
                      }
                    }
                  } else {
                    log(`[DB] Referenced ticket #${state.activeTicketId} no longer exists`, "debug");
                    // Only reset activeTicketId but keep other state info
                    state.activeTicketId = undefined;
                  }
                }
                
                // If in questionnaire and recent enough, restore state
                if (state.inQuestionnaire) {
                  log(`[DB] Restoring questionnaire state for user ${user.id} (age: ${stateAgeMinutes.toFixed(1)} minutes)`, "debug");
                  stateRestored = true;
                  recoveredFromStateCount++;
                }
              } else {
                log(`[DB] Found expired state for telegramId: ${user.telegramId} (${stateAgeMinutes.toFixed(1)} minutes old, max ${maxStateAgeMinutes})`, "debug");
                state = null;
              }
            } catch (parseError) {
              log(`Error parsing state for telegramId: ${user.telegramId}: ${parseError}`, "error");
              state = null;
            }
          } else {
            log(`[DB] No active user state found for telegramId: ${user.telegramId}`);
          }
          
          // Step 4c: Second priority - check for active tickets in database if we couldn't restore state
          if (!stateRestored) {
            // Find active tickets for this user even if state wasn't restored
            log(`[DB] Checking for active tickets for user ${user.id}`);
            
            const activeTickets = await storage.getActiveTicketsByUserId(user.id);
            log(`[DB] Found ${activeTickets.length} potential active tickets for user ${user.id}`);
            
            // Filter tickets that are truly active
            const validTickets = activeTickets.filter(ticket => {
              const validStatuses = ['pending', 'open', 'in-progress'];
              const isPaidTicket = ticket.amount && ticket.amount > 0;
              return validStatuses.includes(ticket.status) || isPaidTicket;
            });
            
            if (validTickets.length > 0) {
              // Sort by latest activity first - use completedAt as fallback for timing
              validTickets.sort((a, b) => {
                const aDate = a.completedAt || new Date(0);
                const bDate = b.completedAt || new Date(0);
                return bDate.getTime() - aDate.getTime();
              });
              
              // Pick the most recent active ticket
              const mostRecentTicket = validTickets[0];
              log(`[DB] Found active ticket ${mostRecentTicket.id} for user ${user.id}, reconstructing state`, "info");
              
              // Recreate state from the active ticket
              state = {
                activeTicketId: mostRecentTicket.id,
                categoryId: mostRecentTicket.categoryId || 1, // Default to category 1 if not set
                currentQuestion: 0,
                answers: [],
                inQuestionnaire: false,
                lastUpdated: Date.now()
                // No transactionId needed, handled internally
              };
              
              stateRestored = true;
              recoveredFromTicketCount++;
            } else {
              log(`[DB] No active tickets found for user ${user.id}`);
            }
          }
          
          // Step 4d: Register state in memory if restored
          if (stateRestored && state) {
            try {
              // Use BigInt for proper ID handling
              const telegramUserIdBig = BigInt(user.telegramId);
              let telegramUserId: number;
              
              // Handle large Telegram IDs safely
              if (telegramUserIdBig > BigInt(Number.MAX_SAFE_INTEGER)) {
                const hash = require('crypto')
                  .createHash('md5')
                  .update(user.telegramId)
                  .digest('hex');
                telegramUserId = parseInt(hash.substring(0, 8), 16);
                log(`Using hash representation for large Telegram ID ${user.telegramId}: ${telegramUserId}`, "debug");
              } else {
                telegramUserId = Number(telegramUserIdBig);
              }
              
              // Set state in memory
              this.userStates.set(telegramUserId, state);
              
              // Also setup cleanup with verification of DB state
              const timeout = setTimeout(() => {
                (async () => {
                  try {
                    // Before expiring, check if still active in DB
                    if (state?.activeTicketId) {
                      const ticket = await storage.getTicket(state.activeTicketId);
                      const validStatuses = ['pending', 'open', 'in-progress'];
                      const isPaidTicket = ticket?.amount && ticket.amount > 0;
                      
                      if (ticket && (validStatuses.includes(ticket.status) || isPaidTicket)) {
                        // Still active, extend timeout
                        log(`Not clearing state for user ${telegramUserId} - ticket ${state.activeTicketId} is still active`, "debug");
                        
                        // Refresh the timeout by recreating the state
                        this.setState(telegramUserId, state);
                        return;
                      }
                    }
                    
                    // Otherwise clear as normal
                    this.userStates.delete(telegramUserId);
                    this.stateCleanups.delete(telegramUserId);
                    this.activeUsers.delete(telegramUserId);
                    log(`Auto-cleared state for inactive user ${telegramUserId} (Telegram ID: ${user.telegramId})`, "debug");
                  } catch (error) {
                    log(`Error in state cleanup: ${error}`, "error");
                  }
                })();
              }, this.STATE_TIMEOUT);
              
              this.stateCleanups.set(telegramUserId, {
                timeout,
                createdAt: Date.now()
              });
              
              this.activeUsers.add(telegramUserId);
              restoredCount++;
              
              // Persist the updated state to ensure consistency
              await storage.saveUserState(user.id, user.telegramId, JSON.stringify(state));
              
              log(`Restored state for user ${user.id} (Telegram ID: ${user.telegramId})`, "info");
            } catch (idError) {
              failedCount++;
              log(`Error processing Telegram ID ${user.telegramId}: ${idError}`, "error");
            }
          }
        } catch (error) {
          failedCount++;
          log(`Error restoring state for user ${user.id} (Telegram ID: ${user.telegramId}): ${error}`, "error");
        }
      }
      
      // Step 5: Summarize results
      log(`Restored ${restoredCount} user states, ${failedCount} failed`, "info");
      log(`Recovery sources: ${recoveredFromStateCount} from saved states, ${recoveredFromTicketCount} from active tickets`, "info");
    } catch (error) {
      log(`Error in restoreUserStates: ${error}`, "error");
    }
  }

  private setupHandlers() {
    if (!this.bot) return;
    
    // Set up command handlers
    this.bot.command('ping', async (ctx) => {
      if (!ctx.from?.id) return;
      
      if (!this.checkRateLimit(ctx.from.id, 'command', 'ping')) {
        await ctx.reply("⚠️ You're sending commands too quickly. Please wait a moment.");
        return;
      }
      
      try {
        console.log(`[PING CMD] Received ping command from user ${ctx.from.id}`);
        
        // Get user and check active ticket
        const user = await storage.getUserByTelegramId(ctx.from.id.toString());
        console.log(`[PING CMD] User lookup result: ${JSON.stringify(user || {})}`);
        
        if (!user) {
          await ctx.reply("❌ You need to use /start first to create a user account.");
          return;
        }
        
        // Check if user has an active ticket in memory
        const userState = this.userStates.get(ctx.from.id);
        console.log(`[PING CMD] Current user state: ${JSON.stringify(userState || {})}`);
        
        // Debug - check all active tickets for this user
        const allActiveTickets = await storage.getActiveTicketsByUserId(user.id);
        console.log(`[PING CMD] All active tickets: ${JSON.stringify(allActiveTickets.map(t => ({id: t.id, status: t.status, amount: t.amount})))}`);
        
        if (!userState?.activeTicketId) {
          console.log(`[PING CMD] No active ticket ID in user state`);
          
          // Check if we can find their active ticket in the database
          const activeTicket = await storage.getActiveTicketByUserId(user.id);
          console.log(`[PING CMD] Active ticket from database: ${JSON.stringify(activeTicket || {})}`);
          
          if (!activeTicket) {
            await ctx.reply("❌ You don't have an active ticket. Use /start to create one first.");
            return;
          }
          
          // Use the active ticket from database
          await ctx.reply("🔔 Pinging staff in your active ticket...");
          await this.bridge.pingRoleForCategory(activeTicket.categoryId!, activeTicket.discordChannelId!);
          return;
        }
        
        // Get the ticket
        const ticket = await storage.getTicket(userState.activeTicketId);
        console.log(`[PING CMD] Ticket from user state activeTicketId: ${JSON.stringify(ticket || {})}`);
        
        // Check if ticket exists and is in an active state (pending, open, in-progress, paid)
        // Also allow tickets with amount > 0 to be pinged (even if status field doesn't say 'paid')
        const validStatuses = ['pending', 'open', 'in-progress', 'paid'];
        const isPaidTicket = ticket?.amount && ticket.amount > 0;
        
        console.log(`[PING CMD] Valid statuses: ${JSON.stringify(validStatuses)}`);
        console.log(`[PING CMD] Current ticket status: ${ticket?.status}`);
        console.log(`[PING CMD] Is status valid: ${ticket && validStatuses.includes(ticket.status)}`);
        console.log(`[PING CMD] Is paid ticket: ${isPaidTicket}`);
        console.log(`[PING CMD] Status check result: ${ticket && (validStatuses.includes(ticket.status) || isPaidTicket)}`);
        
        if (!ticket || (!validStatuses.includes(ticket.status) && !isPaidTicket)) {
          console.log(`[PING CMD] Ticket check failed, returning error message`);
          
          // Get all other active tickets for this user to provide better guidance
          if (user && user.id) {
            const activeTickets = await storage.getActiveTicketsByUserId(user.id);
            
            if (activeTickets.length > 0) {
              // User has other active tickets they can switch to
              await ctx.reply(
                "❌ The current ticket is not available for pinging.\n\n" +
                "You have other active tickets though. Use /switch to select a different ticket, " +
                "or /start to create a new one."
              );
            } else {
              // No active tickets at all
              await ctx.reply("❌ You don't have any active tickets. Use /start to create a new one.");
            }
          } else {
            await ctx.reply("❌ Your active ticket was not found or is closed. Use /start to create a new one.");
          }
          return;
        }
        
        // Check if the ticket has a Discord channel
        if (!ticket.discordChannelId) {
          await ctx.reply("❌ This ticket doesn't have a Discord channel yet. Please wait a moment and try again.");
          return;
        }
        
        // Get category for role pinging
        if (!ticket.categoryId) {
          await ctx.reply("❌ This ticket doesn't have a valid category. Please contact support.");
          return;
        }
        
        const category = await storage.getCategory(ticket.categoryId);
        if (!category) {
          await ctx.reply("❌ Service category not found. Please contact support.");
          return;
        }
        
        // Ping the Discord role or staff
        if (ticket.claimedBy) {
          // If ticket is claimed, notify the user
          await ctx.reply("🔔 This ticket is being handled by a dedicated staff member. They have been notified of your request.");
          
          // Send a message in the Discord channel to notify the staff member
          await this.bridge.sendSystemMessageToDiscord(
            ticket.discordChannelId,
            `🔔 **Attention:** The user has pinged staff for assistance in this ticket.`
          );
        } else if (category.discordRoleId) {
          // If not claimed but has a role ID, ping the role
          await ctx.reply("🔔 Pinging staff in your ticket... Someone will respond shortly.");
          await this.bridge.pingRoleForCategory(ticket.categoryId, ticket.discordChannelId);
        } else {
          // Fallback message if no role ID is set
          await ctx.reply("🔔 Staff has been notified. Someone will respond shortly.");
          await this.bridge.sendSystemMessageToDiscord(
            ticket.discordChannelId,
            `🔔 **Attention:** The user has requested assistance in this ticket.`
          );
        }
      } catch (error) {
        log(`Error in ping command: ${error}`, "error");
        await ctx.reply("❌ An error occurred while trying to ping staff. Please try again later.");
      }
    });
    
    this.bot.command('help', async (ctx) => {
      if (!ctx.from?.id) return;
      
      if (!this.checkRateLimit(ctx.from.id, 'command', 'help')) {
        await ctx.reply("⚠️ You're sending commands too quickly. Please wait a moment.");
        return;
      }
      
      try {
        const helpMessage = `
*Available Commands:*

/start - Start a new ticket
/switch - Switch between active tickets or create a new one
/close - Close your current ticket
/cancel - Cancel the current questionnaire without creating a ticket
/ping - Notify staff in your active ticket

To message support staff, simply send a message after creating a ticket.
Images/photos are also supported.
`;
        await ctx.reply(helpMessage, { parse_mode: 'Markdown' });
      } catch (error) {
        log(`Error in help command: ${error}`, "error");
      }
    });
    
    this.bot.command('start', async (ctx) => {
      if (!ctx.from?.id) {
        log("Start command received but ctx.from.id is missing!", "error");
        return;
      }
      
      // Acknowledge the command immediately to improve user experience
      try {
        await ctx.reply("🚀 Processing your request... Please wait a moment.");
      } catch (ackError) {
        log(`Error sending initial acknowledgment: ${ackError}`, "error");
        // Continue processing even if ack fails
      }
      
      if (!this.checkRateLimit(ctx.from.id, 'command', 'start')) {
        try {
          await ctx.reply("⚠️ You're sending commands too quickly. Please wait a moment.");
        } catch (e) {
          log(`Error in rate limit message: ${e}`, "error");
        }
        return;
      }
      
      try {
        const userId = ctx.from.id;
        log(`Processing /start command for user ${userId}`, "info");
        
        // Skip capacity check in production to prevent blocking users
        let canAdd = true;
        
        // Only apply capacity check in development
        if (process.env.NODE_ENV !== 'production') {
          canAdd = await this.checkActiveUsers(userId);
          if (!canAdd) {
            await ctx.reply("⚠️ Bot is currently at maximum capacity. Please try again in a few minutes.");
            return;
          }
        }
        
        // Check if user is banned
        let existingUser;
        try {
          existingUser = await storage.getUserByTelegramId(userId.toString());
          log(`User lookup result for ${userId}: ${existingUser ? 'Found' : 'Not found'}`, "debug");
        } catch (userLookupError) {
          log(`Error looking up user ${userId}: ${userLookupError}`, "error");
          // Continue anyway and try to create the user
        }
        
        if (existingUser && existingUser.isBanned) {
          await ctx.reply(`⛔ You have been banned from using this bot${existingUser.banReason ? ` for: ${existingUser.banReason}` : ""}.`);
          return;
        }
        
        // Create user if doesn't exist
        if (!existingUser) {
          try {
            // Since database is now using bigint for telegramId, pass it directly as a number
            const newUser = await storage.createUser({
              telegramId: userId, // Pass as number directly
              username: ctx.from.username || `user_${userId}`,
              telegramUsername: ctx.from.username,
              telegramName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ')
            });
            log(`Created new user with telegramId ${userId} and ID ${newUser.id}`, "info");
            existingUser = newUser; // Use the newly created user
          } catch (createError) {
            log(`Error creating user ${userId}: ${createError}`, "error");
            
            // If there's a duplicate key error, try to fetch the user again
            if (String(createError).includes('duplicate key')) {
              try {
                existingUser = await storage.getUserByTelegramId(userId.toString());
                log(`Retrieved user after duplicate key error: ${existingUser?.id}`, "info");
              } catch (retryError) {
                log(`Error on retry lookup: ${retryError}`, "error");
                // Continue anyway with undefined existingUser
              }
            }
          }
        }
        
        // Check if the user already has active tickets and is in one currently
        if (existingUser) {
          // Get all active tickets
          // Explicitly type as any[] initially to avoid type issues
          let activeTickets: any[] = [];
          try {
            activeTickets = await storage.getActiveTicketsByUserId(existingUser.id);
            log(`User ${userId} has ${activeTickets.length} active tickets`, "debug");
          } catch (ticketError) {
            log(`Error getting active tickets for user ${existingUser.id}: ${ticketError}`, "error");
            // Continue with empty array
          }
          
          if (activeTickets.length > 0) {
            log(`User ${userId} attempted to start and has ${activeTickets.length} active tickets`);
            
            // Now always show the switch menu with create new ticket option
            // Get ticket categories for better display
            try {
              const categories = await storage.getCategories();
              const categoriesMap = new Map(categories.map(c => [c.id, c]));
              
              // Build ticket list with better formatting
              const ticketList = activeTickets.map((ticket, i) => {
                const categoryId = ticket.categoryId || 0;
                const category = categoriesMap.get(categoryId);
                const categoryName = category ? category.name : `Category #${categoryId}`;
                const statusEmoji = ticket.status === 'open' ? '🔵' : 
                                    ticket.status === 'in-progress' ? '🟡' : 
                                    ticket.status === 'pending' ? '🟠' : 
                                    ticket.status === 'paid' ? '💲' : '⚪';
                return `${i + 1}. ${statusEmoji} Ticket #${ticket.id} (${categoryName}) - ${ticket.status}`;
              }).join('\n');
              
              // Create inline keyboard buttons for each ticket plus New Ticket option
              const buttons = activeTickets.map(ticket => {
                const categoryId = ticket.categoryId || 0;
                const category = categoriesMap.get(categoryId);
                const categoryName = category ? category.name : `Category #${categoryId}`;
                return [{
                  text: `#${ticket.id}: ${categoryName}`,
                  callback_data: `switch_${ticket.id}`
                }];
              });
              
              // Add the "Create New Ticket" button
              buttons.push([{
                text: "➕ Create New Ticket",
                callback_data: "switch_new"
              }]);
              
              await ctx.reply(
                `🎫 *Your active tickets*\n\nYou have ${activeTickets.length} active ticket(s):\n\n${ticketList}\n\n*Please select a ticket to continue working with, or create a new one:*\n\n_Note: You can also use /switch command to switch between tickets anytime._`,
                {
                  parse_mode: 'Markdown',
                  reply_markup: {
                    inline_keyboard: buttons
                  }
                }
              );
              
              // Register a state to handle the switch callback
              await this.setState(userId, {
                activeTicketId: undefined, // No active ticket selected yet
                categoryId: 0,
                currentQuestion: 0,
                answers: [],
                inQuestionnaire: false,
                lastUpdated: Date.now()
              });
              
              return; // Exit early since we're showing the menu instead
            } catch (error) {
              log(`Error preparing ticket menu: ${error}`, "error");
              // Fall back to default behavior if we can't show the menu
            }
          }
        }
        
        // If we got here, no active tickets, so display category menu
        try {
          await this.handleCategoryMenu(ctx);
          log(`Successfully displayed category menu for user ${userId}`, "info");
        } catch (menuError) {
          log(`Error displaying category menu: ${menuError}`, "error");
          await ctx.reply("❌ Sorry, there was an error displaying the menu. Please try /start again.");
        }
      } catch (error) {
        log(`Error in start command: ${error}`, "error");
        try {
          await ctx.reply("❌ Sorry, there was an error starting the bot. Please try again later.");
        } catch (replyError) {
          log(`Error sending error message: ${replyError}`, "error");
        }
      }
    });
    
    this.bot.command('cancel', async (ctx) => {
      if (!ctx.from?.id) return;
      
      if (!this.checkRateLimit(ctx.from.id, 'command', 'cancel')) {
        await ctx.reply("⚠️ You're sending commands too quickly. Please wait a moment.");
        return;
      }
      
      try {
        const userId = ctx.from.id;
        const userState = this.userStates.get(userId);
        
        // Case 1: If user has an active ticket and not in questionnaire
        if (userState?.activeTicketId && !userState.inQuestionnaire) {
          await ctx.reply("❌ You have an active ticket. The /cancel command is only for canceling ticket creation. Use /close to close your active ticket.");
          return;
        }
        
        // Case 2: If user is in a questionnaire (ticket creation process)
        if (userState?.inQuestionnaire) {
          // Clear user state
          this.userStates.delete(userId);
          if (this.stateCleanups.has(userId)) {
            clearTimeout(this.stateCleanups.get(userId)!.timeout);
            this.stateCleanups.delete(userId);
          }
          
          await ctx.reply("✅ Ticket creation canceled. Use /start to create a new order.");
          return;
        }
        
        // Case 3: User is not in ticket creation or active ticket
        await ctx.reply("ℹ️ You are not currently creating a ticket. Use /start to begin a new order.");
        
      } catch (error) {
        log(`Error in cancel command: ${error}`, "error");
      }
    });
    
    // Switch command to change between tickets
    this.bot.command('switch', async (ctx) => {
      if (!ctx.from?.id) return;
      const userId = ctx.from.id;
      
      // Send immediate acknowledgment to improve user experience
      try {
        await ctx.reply("🔄 Loading your tickets...");
      } catch (ackError) {
        log(`Error sending initial acknowledgment for switch command: ${ackError}`, "error");
        // Continue even if ack fails
      }
      
      console.log(`[SWITCH CMD] User ${userId} executed /switch command`);
      
      if (!this.checkRateLimit(userId, 'command', 'switch')) {
        await ctx.reply("⚠️ You're sending commands too quickly. Please wait a moment.");
        return;
      }
      
      try {
        const userState = this.userStates.get(userId);
        
        // Check if user is in a questionnaire
        if (userState?.inQuestionnaire) {
          await ctx.reply("❌ You are currently filling out a questionnaire. Please cancel it first by typing 'cancel' before switching tickets.");
          return;
        }
        
        // Get user from database and fetch categories in parallel to improve performance
        const [user, switchCategories] = await Promise.all([
          storage.getUserByTelegramId(userId),
          storage.getCategories() // Fetch all categories at once
        ]);
        
        if (!user) {
          await ctx.reply("❌ Error: User not found. Please use /start to begin again.");
          return;
        }
        
        // We don't need to re-fetch categories since we already have them
        
        // Get all active tickets for this user
        const userTickets = await storage.getActiveTicketsByUserId(user.id);
        
        if (!userTickets || userTickets.length === 0) {
          // No active tickets, inform user
          await ctx.reply("❌ You don't have any active tickets. Use /start to create a new ticket.");
          return;
        }
        
        // Create buttons for each ticket
        const buttons = [];
        const currentTicketId = userState?.activeTicketId;
        
        // Use the categories we already fetched instead of making another database call
        const categoriesMap = new Map(switchCategories.map(c => [c.id, c]));
        
        // Create a button for each ticket
        for (const ticket of userTickets) {
          // Handle potential null categoryId safely
          const category = ticket.categoryId ? categoriesMap.get(ticket.categoryId) : undefined;
          const categoryName = category ? category.name : "Unknown category";
          
          // Get status emoji for ticket status
          const statusEmoji = ticket.status === 'open' ? '🔵' : 
                              ticket.status === 'in-progress' ? '🟡' : 
                              ticket.status === 'pending' ? '🟠' : 
                              ticket.status === 'paid' ? '💲' : '⚪';
          
          // Mark currently active ticket
          const isActive = currentTicketId === ticket.id;
          const buttonLabel = isActive 
            ? `✅ ${statusEmoji} #${ticket.id}: ${categoryName} (current)` 
            : `${statusEmoji} #${ticket.id}: ${categoryName}`;
          
          buttons.push([{
            text: buttonLabel,
            callback_data: `switch_${ticket.id}`
          }]);
        }
        
        // Add button for creating a new ticket
        buttons.push([{
          text: "➕ Create New Ticket",
          callback_data: "switch_new"
        }]);
        
        // Format ticket list with visual dividers and clear instructions
        let ticketList = "━━━━━━━━━━━━━━━━━━━━━━\n";
        ticketList += "🎫 *Your active tickets:*\n\n";
        
        // Include current active ticket info if applicable
        if (currentTicketId) {
          // Get the active ticket category name
          const activeTicket = userTickets.find(t => t.id === currentTicketId);
          if (activeTicket && activeTicket.categoryId) {
            const category = categoriesMap.get(activeTicket.categoryId);
            const categoryName = category ? category.name : "Unknown service";
            ticketList += `⚠️ *Your messages are currently sent to:*\n✅ ${categoryName} (#${currentTicketId})\n\n`;
          }
        } else {
          ticketList += `⚠️ *You don't have an active ticket selected.*\n\n`;
        }
        
        ticketList += "Please select a ticket to switch to, or create a new one:\n\n_Note: You can use /start anytime to show this menu again._\n━━━━━━━━━━━━━━━━━━━━━━";
        
        // Send list with inline keyboard buttons
        await ctx.reply(ticketList, { 
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: buttons
          }
        });
        
        // Store expectation of ticket selection in user state
        if (userState) {
          userState.inQuestionnaire = false;  // Make sure not in questionnaire mode
          await this.setState(userId, userState);
        }
      } catch (error) {
        log(`Error in /switch command: ${error}`, "error");
        await ctx.reply("❌ An error occurred while retrieving your tickets. Please try again later.");
      }
    });
    
    // New proper close command to close tickets
    this.bot.command('close', async (ctx) => {
      console.log("===== /CLOSE COMMAND RECEIVED =====");
      
      if (!ctx.from?.id) {
        console.log("No user ID in close command");
        return;
      }
      
      const userId = ctx.from.id;
      console.log(`Processing /close command for user ${userId}`);
      
      if (!this.checkRateLimit(userId, 'command', 'close')) {
        await ctx.reply("⚠️ You're sending commands too quickly. Please wait a moment.");
        return;
      }
      
      try {
        // Check if the user is in a questionnaire
        const userMemoryState = this.userStates.get(userId);
        
        // Handle /close as /cancel if user is in a questionnaire
        if (userMemoryState?.inQuestionnaire) {
          console.log(`User ${userId} is in a questionnaire, handling /close as /cancel`);
          
          // Clear user state, just like /cancel does
          this.userStates.delete(userId);
          if (this.stateCleanups.has(userId)) {
            clearTimeout(this.stateCleanups.get(userId)!.timeout);
            this.stateCleanups.delete(userId);
          }
          
          // Delete state from database as well
          try {
            await storage.deactivateUserState(userId); // Pass directly as number
          } catch (stateError) {
            console.log(`Error clearing persisted state: ${stateError}`);
          }
          
          await ctx.reply("✅ Ticket creation canceled. Use /start to create a new order.");
          return;
        }
        
        // If not in questionnaire, process as normal close command
        // Find the user - use numeric ID directly
        const user = await storage.getUserByTelegramId(userId);
        if (!user) {
          console.log(`User with telegram ID ${userId} not found in database`);
          await ctx.reply("❌ You haven't created any tickets yet. Use /start to create a ticket.");
          return;
        }
        console.log(`Found user in database: ${JSON.stringify(user)}`);
        
        // Get all active tickets for this user
        const activeTickets = await storage.getActiveTicketsByUserId(user.id);
        
        if (activeTickets.length === 0) {
          console.log(`No active tickets found for user ${user.id}`);
          
          // Check if there are any tickets with Discord channels that might be miscategorized
          console.log(`Checking for any tickets with Discord channels for user ${user.id}`);
          const allUserTickets = await storage.getTicketsByUserId(user.id);
          const ticketsWithDiscordChannels = allUserTickets.filter(t => 
            t.discordChannelId && 
            ['closed', 'deleted', 'transcript', 'completed'].indexOf(t.status) === -1
          );
          
          if (ticketsWithDiscordChannels.length > 0) {
            console.log(`Found ${ticketsWithDiscordChannels.length} tickets with Discord channels: ${JSON.stringify(ticketsWithDiscordChannels)}`);
            const mostRecentTicket = ticketsWithDiscordChannels[0]; // Already sorted by ID desc
            
            await ctx.reply(`🔎 No active tickets found in the database, but I found a Discord channel that may be associated with your account. Attempting to close ticket #${mostRecentTicket.id}...`);
            
            // Update the ticket status to closed
            await storage.updateTicketStatus(mostRecentTicket.id, "closed");
            console.log(`Updated ticket ${mostRecentTicket.id} status to closed`);
            
            // Try to move to transcripts if applicable
            if (mostRecentTicket.discordChannelId) {
              try {
                await this.bridge.moveToTranscripts(mostRecentTicket.id);
                await ctx.reply("✅ The Discord channel has been moved to transcripts. Use /start to create a new ticket if needed.");
              } catch (error) {
                console.error(`Error moving channel to transcripts: ${error}`);
                await ctx.reply("✅ The ticket has been marked as closed, but there was an error moving the Discord channel. Use /start to create a new ticket if needed.");
              }
            } else {
              await ctx.reply("✅ The ticket has been marked as closed. Use /start to create a new ticket if needed.");
            }
            return;
          }
          
          // If no tickets with Discord channels found, show the standard message
          await ctx.reply("❌ You don't have any active tickets. Use /start to create one.");
          return;
        }
        
        // Get the active ticket ID from user's memory state
        let currentTicketId = userMemoryState?.activeTicketId;
        
        console.log(`Memory state activeTicketId: ${currentTicketId}`);
        console.log(`User has ${activeTickets.length} active tickets`);
        
        // If there's only one active ticket and no selected ticket in memory, 
        // automatically select that ticket for closing
        if (activeTickets.length === 1 && !currentTicketId) {
          currentTicketId = activeTickets[0].id;
          console.log(`Automatically selected the only active ticket: ${currentTicketId}`);
          
          // Update user state for future use
          if (userMemoryState) {
            userMemoryState.activeTicketId = currentTicketId;
            await this.setState(userId, userMemoryState);
            console.log(`Updated user state with active ticket ID: ${currentTicketId}`);
          }
        }
        
        // If user has multiple active tickets and none is selected in state, ask them which one to close
        if (activeTickets.length > 1 && !currentTicketId) {
          // Create buttons for each ticket
          const buttons = [];
          
          // Get the categories for all tickets upfront to avoid multiple DB calls
          const categoryIds = [...new Set(activeTickets.map(t => t.categoryId).filter(id => id !== null))];
          const categoriesMap = new Map();
          
          for (const categoryId of categoryIds) {
            if (categoryId !== null) {
              const category = await storage.getCategory(categoryId);
              if (category) {
                categoriesMap.set(categoryId, category);
              }
            }
          }
          
          // Create a button for each ticket
          for (const ticket of activeTickets) {
            const category = categoriesMap.get(ticket.categoryId);
            const categoryName = category ? category.name : "Unknown category";
            
            // Get status emoji for ticket status
            const statusEmoji = ticket.status === 'open' ? '🔵' : 
                                ticket.status === 'in-progress' ? '🟡' : 
                                ticket.status === 'pending' ? '🟠' : 
                                ticket.status === 'paid' ? '💲' : '⚪';
                                
            const buttonLabel = `${statusEmoji} #${ticket.id}: ${categoryName}`;
            
            buttons.push([{
              text: buttonLabel,
              callback_data: `close_${ticket.id}`
            }]);
          }
          
          // Format ticket list
          let ticketList = "🎫 *You have multiple active tickets. Which one would you like to close?*\n\n";
          ticketList += "Please select a ticket to close:";
          
          // Send list with inline keyboard buttons
          await ctx.reply(ticketList, {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: buttons
            }
          });
          
          return;
        }
        
        // If user has a selected ticket in memory state or just one active ticket, close that one
        const ticketToClose = currentTicketId 
          ? activeTickets.find(t => t.id === currentTicketId) 
          : activeTickets[0];
        
        if (!ticketToClose) {
          console.log(`Current ticket ID ${currentTicketId} not found in active tickets`);
          await ctx.reply("❌ Could not find your selected ticket. Use /switch to select an active ticket first.");
          return;
        }
        
        console.log(`Found active ticket to close: ${JSON.stringify(ticketToClose)}`);
        
        // First, send a notification to Discord that the user is closing the ticket
        if (ticketToClose.discordChannelId) {
          try {
            console.log(`Sending notification to Discord channel ${ticketToClose.discordChannelId} about ticket being closed by user`);
            await this.bridge.sendSystemMessageToDiscord(
              ticketToClose.discordChannelId,
              "**Note:** The user has closed this ticket."
            );
          } catch (notifyError) {
            // Don't block the main flow if notification fails
            console.error(`Error sending close notification to Discord: ${notifyError}`);
          }
        }
        
        // Close the ticket
        console.log(`Attempting to update ticket status to 'closed' for ticket ID ${ticketToClose.id}`);
        await storage.updateTicketStatus(ticketToClose.id, "closed");
        console.log(`Database update completed for ticket ${ticketToClose.id}`);
        
        // Clear the user's active ticket from memory state if it matches
        if (userMemoryState && userMemoryState.activeTicketId === ticketToClose.id) {
          console.log(`Clearing active ticket ${ticketToClose.id} from user ${userId} memory state`);
          userMemoryState.activeTicketId = undefined;
          await this.setState(userId, userMemoryState);
        }
        
        // Verify the ticket was actually closed
        const verifyTicket = await storage.getTicket(ticketToClose.id);
        console.log(`Verification after update: Ticket ${ticketToClose.id} status is now ${verifyTicket?.status}`);
        
        // Move to transcripts if possible
        if (ticketToClose.discordChannelId) {
          try {
            console.log(`Ticket has Discord channel ID: ${ticketToClose.discordChannelId}, attempting to move to transcripts`);
            
            // Get category for transcript category ID
            const category = await storage.getCategory(ticketToClose.categoryId!);
            console.log(`Category for ticket: ${JSON.stringify(category)}`);
            
            if (category && category.transcriptCategoryId) {
              await this.bridge.moveToTranscripts(ticketToClose.id);
              console.log(`Successfully moved ticket ${ticketToClose.id} to transcripts category ${category.transcriptCategoryId}`);
              await ctx.reply("✅ Your ticket has been closed. Use /start when you're ready to create a new ticket.");
            } else {
              console.warn(`No transcript category found for category ${ticketToClose.categoryId}`);
              await ctx.reply("✅ Your ticket has been closed. Use /start when you're ready to create a new ticket.");
            }
          } catch (moveError) {
            console.error(`Error moving ticket to transcripts: ${moveError}`);
            await ctx.reply("✅ Your ticket has been closed. Use /start when you're ready to create a new ticket.");
          }
        } else {
          console.log(`Ticket ${ticketToClose.id} has no Discord channel associated, skipping transcript move`);
          await ctx.reply("✅ Your ticket has been closed. Use /start when you're ready to create a new ticket.");
        }
        
        // Check if user has other active tickets after closing this one
        const remainingActiveTickets = await storage.getActiveTicketsByUserId(user.id);
        console.log(`After closing ticket #${ticketToClose.id}, found ${remainingActiveTickets.length} remaining active tickets for user ${user.id}`);
        
        if (remainingActiveTickets.length > 0) {
          // Sort tickets by ID in descending order to get the most recent one first
          // Since IDs are auto-incrementing, higher ID = more recent ticket
          remainingActiveTickets.sort((a, b) => b.id - a.id);
          
          // User has other active tickets, automatically switch to the most recent one
          const mostRecentTicket = remainingActiveTickets[0];
          console.log(`User has ${remainingActiveTickets.length} active tickets remaining, switching to most recent ticket #${mostRecentTicket.id}`);
          
          // Log the current user memory state for debugging
          console.log(`User memory state before switching: ${JSON.stringify(userMemoryState || {})}`);
          console.log(`Most recent ticket: ${JSON.stringify(mostRecentTicket)}`);
          const existingTickets = await storage.getTicketsByUserId(user.id);
          console.log(`All user tickets: ${existingTickets.length}, Active tickets: ${remainingActiveTickets.length}`);
          
          // Get category for the most recent active ticket to display name
          let categoryName = "Unknown service";
          if (mostRecentTicket.categoryId) {
            const nextCategory = await storage.getCategory(mostRecentTicket.categoryId);
            if (nextCategory) {
              categoryName = nextCategory.name;
            }
          }
          
          // Update the user's state with the new active ticket
          if (userMemoryState) {
            userMemoryState.activeTicketId = mostRecentTicket.id;
            userMemoryState.categoryId = mostRecentTicket.categoryId || 0;
            await this.setState(userId, userMemoryState);
          }
          
          // Send a message to let the user know which ticket they were switched to with visual separator
          await ctx.reply(`━━━━━━━━━━━━━━━━━━━━━━\n🔄 *You've been automatically switched to:*\n*${categoryName}* (#${remainingActiveTickets[0].id})\n\n⚠️ *Your messages will be sent to this ticket unless you select another option below.*\n━━━━━━━━━━━━━━━━━━━━━━`, {
            parse_mode: 'Markdown'
          });
          
          // Show the menu of remaining tickets
          const buttons = [];
          const categoriesMap = new Map();
          
          // Get all categories for the active tickets
          const categoryIds = [...new Set(remainingActiveTickets.map(t => t.categoryId).filter(id => id !== null))];
          for (const categoryId of categoryIds) {
            const ticket_category = await storage.getCategory(categoryId!);
            if (ticket_category) {
              categoriesMap.set(categoryId, ticket_category);
            }
          }
          
          // Create a button for each remaining ticket
          for (const ticket of remainingActiveTickets) {
            const ticket_category = categoriesMap.get(ticket.categoryId);
            const ticket_categoryName = ticket_category ? ticket_category.name : "Unknown category";
            
            // Get status emoji for ticket status
            const statusEmoji = ticket.status === 'open' ? '🔵' : 
                              ticket.status === 'in-progress' ? '🟡' : 
                              ticket.status === 'pending' ? '🟠' : 
                              ticket.status === 'paid' ? '💲' : '⚪';
            
            const buttonLabel = `${statusEmoji} #${ticket.id}: ${ticket_categoryName}`;
            
            // Highlight the current active ticket
            const isActive = ticket.id === remainingActiveTickets[0].id;
            
            buttons.push([{
              text: isActive ? `✅ ${buttonLabel} (current)` : buttonLabel,
              callback_data: `switch_${ticket.id}`
            }]);
          }
          
          // Add a button to create a new ticket
          buttons.push([{
            text: "➕ Create a new ticket",
            callback_data: "switch_new"
          }]);
          
          // Send the remaining tickets menu with better header
          await ctx.reply(`🎫 *Your active tickets:*\nPlease select a ticket or create a new one:`, {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: buttons
            }
          });
        }
      } catch (error) {
        console.error(`Error in close command: ${error}`);
        await ctx.reply("❌ There was an error closing your ticket. Please try again later.");
      }
    });
    
    // Emergency close command for admins
    this.bot.command('emergency_close', async (ctx) => {
      if (!ctx.from?.id) return;
      
      try {
        // Check if user is admin
        const isAdmin = await storage.isAdmin(ctx.from.id.toString());
        if (!isAdmin) {
          await ctx.reply("⛔ You don't have permission to use this command.");
          return;
        }
        
        const args = ctx.message.text.split(' ').slice(1);
        if (args.length === 0) {
          await ctx.reply("Usage: /emergency_close [discord_channel_id]");
          return;
        }
        
        const channelId = args[0];
        
        await ctx.reply(`🔄 Attempting emergency close for Discord channel ID: ${channelId}...`);
        
        // Get the ticket with this Discord channel ID
        const ticket = await storage.getTicketByDiscordChannel(channelId);
        
        if (!ticket) {
          await ctx.reply(`❌ No ticket found with Discord channel ID: ${channelId}`);
          return;
        }
        
        await ctx.reply(`🔍 Found ticket #${ticket.id} with status '${ticket.status}' for user ID: ${ticket.userId}`);
        
        // Send notification to Discord if possible
        if (ticket.discordChannelId) {
          try {
            await this.bridge.sendSystemMessageToDiscord(
              ticket.discordChannelId,
              "**❗ EMERGENCY NOTICE:** This ticket has been forcibly closed by an administrator."
            );
          } catch (notifyError) {
            log(`Error sending emergency close notification to Discord: ${notifyError}`, "warn");
          }
        }
        
        // Close the ticket
        await storage.updateTicketStatus(ticket.id, "closed");
        
        // If the user who created this ticket has an active state with this ticket,
        // clear it from their state 
        try {
          if (ticket.userId) { // Make sure we have a valid userId
            // Get the user who created this ticket
            const ticketUser = await storage.getUser(ticket.userId);
            if (ticketUser && ticketUser.telegramId) {
              // telegramId is already a number from the database
              const telegramId = ticketUser.telegramId;
              const userState = this.userStates.get(telegramId);
              
              if (userState && userState.activeTicketId === ticket.id) {
                console.log(`Clearing active ticket ${ticket.id} from user ${telegramId} memory state during emergency close`);
                userState.activeTicketId = undefined;
                await this.setState(telegramId, userState);
              }
            }
          }
        } catch (stateError) {
          console.error(`Error clearing user state during emergency close: ${stateError}`);
          // Don't interrupt the main command flow for state cleanup errors
        }
        
        await ctx.reply(`✅ Successfully closed ticket #${ticket.id}`);
        
        // Try to move to transcripts
        if (ticket.categoryId) {
          try {
            // Get category for transcript category ID
            const category = await storage.getCategory(ticket.categoryId);
            
            if (category && category.transcriptCategoryId) {
              await this.bridge.moveToTranscripts(ticket.id);
              await ctx.reply(`✅ Successfully moved ticket to transcripts category: ${category.transcriptCategoryId}`);
            } else {
              await ctx.reply("⚠️ No transcript category found for this ticket's category.");
            }
          } catch (error) {
            await ctx.reply(`⚠️ Error moving ticket to transcripts: ${error}`);
          }
        }
      } catch (error) {
        log(`Error in emergency_close command: ${error}`, "error");
        await ctx.reply(`❌ Error processing emergency close command: ${error}`);
      }
    });
    
    // Admin commands
    this.bot.command('ban', async (ctx) => {
      if (!ctx.from?.id) return;
      
      try {
        // Check if user is admin
        const isAdmin = await storage.isAdmin(ctx.from.id.toString());
        if (!isAdmin) {
          await ctx.reply("⛔ You don't have permission to use this command.");
          return;
        }
        
        const args = ctx.message.text.split(' ').slice(1);
        if (args.length === 0) {
          await ctx.reply("Usage: /ban [user_id] [reason]");
          return;
        }
        
        const targetId = args[0];
        const reason = args.slice(1).join(' ') || "No reason provided";
        
        const targetUser = await storage.getUserByTelegramId(targetId);
        if (!targetUser) {
          await ctx.reply(`❌ User with ID ${targetId} not found.`);
          return;
        }
        
        await storage.banUser(targetUser.id, reason, ctx.from.id.toString());
        
        await ctx.reply(`✅ User ${targetUser.username} (ID: ${targetId}) has been banned for: ${reason}`);
        
        // Notify the banned user
        try {
          if (targetUser.telegramId) {
            await this.sendMessage(
              targetUser.telegramId,
              `⛔ You have been banned from using this bot for: ${reason}.`
            );
          }
        } catch (error) {
          log(`Error notifying banned user: ${error}`, "error");
        }
      } catch (error) {
        log(`Error in ban command: ${error}`, "error");
        await ctx.reply("❌ Error processing ban command.");
      }
    });
    
    this.bot.command('unban', async (ctx) => {
      if (!ctx.from?.id) return;
      
      try {
        // Check if user is admin
        const isAdmin = await storage.isAdmin(ctx.from.id.toString());
        if (!isAdmin) {
          await ctx.reply("⛔ You don't have permission to use this command.");
          return;
        }
        
        const args = ctx.message.text.split(' ').slice(1);
        if (args.length === 0) {
          await ctx.reply("Usage: /unban [user_id]");
          return;
        }
        
        const targetId = args[0];
        
        const targetUser = await storage.getUserByTelegramId(targetId);
        if (!targetUser) {
          await ctx.reply(`❌ User with ID ${targetId} not found.`);
          return;
        }
        
        if (!targetUser.isBanned) {
          await ctx.reply(`✅ User ${targetUser.username} is not banned.`);
          return;
        }
        
        await storage.unbanUser(targetUser.id);
        
        await ctx.reply(`✅ User ${targetUser.username} (ID: ${targetId}) has been unbanned.`);
        
        // Notify the unbanned user
        try {
          if (targetUser.telegramId) {
            await this.sendMessage(
              targetUser.telegramId,
              "✅ You have been unbanned and can now use the bot again."
            );
          }
        } catch (error) {
          log(`Error notifying unbanned user: ${error}`, "error");
        }
      } catch (error) {
        log(`Error in unban command: ${error}`, "error");
        await ctx.reply("❌ Error processing unban command.");
      }
    });
    
    // Handle callback queries (button clicks)
    this.bot.on('callback_query', async (ctx) => {
      if (!ctx.from?.id || !ctx.callbackQuery) return;
      
      // Access data safely through the callbackQuery object
      const data = 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
      if (!data) return;
      
      if (!this.checkRateLimit(ctx.from.id, 'command')) {
        await ctx.answerCbQuery("You're clicking buttons too quickly. Please wait a moment.");
        return;
      }
      
      log(`Received callback query: ${data} from user ${ctx.from.id}`);
      
      try {
        if (data === 'back_to_main') {
          await this.handleCategoryMenu(ctx);
        } else if (data.startsWith('submenu_')) {
          const submenuId = parseInt(data.substring(8));
          await this.handleSubmenuClick(ctx, submenuId);
        } else if (data.startsWith('category_')) {
          const categoryId = parseInt(data.substring(9));
          await this.handleCategorySelection(ctx, categoryId);
        } else if (data.startsWith('close_')) {
          // Handle ticket closing from buttons
          const ticketId = parseInt(data.substring(6));
          const userId = ctx.from.id;
          
          // Get user from database
          const user = await storage.getUserByTelegramId(userId.toString());
          if (!user) {
            await ctx.answerCbQuery("Error: User not found");
            return;
          }
          
          try {
            // Check if the ticket exists and belongs to this user
            const ticket = await storage.getTicket(ticketId);
            
            if (!ticket) {
              await ctx.answerCbQuery(`Ticket #${ticketId} not found`);
              return;
            }
            
            // Check if the ticket belongs to this user
            if (ticket.userId !== user.id) {
              await ctx.answerCbQuery(`Ticket #${ticketId} does not belong to you`);
              return;
            }
            
            // Send notification to Discord about user closing the ticket
            if (ticket.discordChannelId) {
              try {
                await this.bridge.sendSystemMessageToDiscord(
                  ticket.discordChannelId,
                  "**Note:** The user has closed this ticket."
                );
              } catch (notifyError) {
                // Don't block the main flow if notification fails
                log(`Error sending close notification to Discord: ${notifyError}`, "warn");
              }
            }
            
            // Close the ticket
            await storage.updateTicketStatus(ticket.id, "closed");
            await ctx.answerCbQuery(`Closed ticket #${ticketId}`);
            
            // Clear the user's active ticket from memory state if it matches
            const userState = this.userStates.get(userId);
            if (userState && userState.activeTicketId === ticket.id) {
              userState.activeTicketId = undefined;
              await this.setState(userId, userState);
            }
            
            // Move to transcripts if possible
            if (ticket.discordChannelId && ticket.categoryId) {
              try {
                const category = await storage.getCategory(ticket.categoryId);
                
                if (category && category.transcriptCategoryId) {
                  await this.bridge.moveToTranscripts(ticket.id);
                  await ctx.reply(`✅ Ticket #${ticket.id} has been closed. Use /switch to select another active ticket or /start to create a new one (both commands do the same thing).`);
                } else {
                  await ctx.reply(`✅ Ticket #${ticket.id} has been closed. Use /switch to select another active ticket or /start to create a new one (both commands do the same thing).`);
                }
              } catch (error) {
                await ctx.reply(`✅ Ticket #${ticket.id} has been closed. Use /switch to select another active ticket or /start to create a new one (both commands do the same thing).`);
              }
            } else {
              await ctx.reply(`✅ Ticket #${ticket.id} has been closed. Use /switch to select another active ticket or /start to create a new one (both commands do the same thing).`);
            }
          } catch (error) {
            log(`Error closing ticket: ${error}`, "error");
            await ctx.answerCbQuery("Error closing ticket");
            await ctx.reply("❌ Error closing ticket. Please try again later.");
          }
        } else if (data.startsWith('switch_')) {
          // Handle ticket switching buttons
          const switchOption = data.substring(7);
          const userId = ctx.from.id;
          
          console.log(`[SWITCH_CALLBACK] User ${userId} clicked switch menu option: ${switchOption}`);
          
          // Get user from database
          const user = await storage.getUserByTelegramId(userId.toString());
          if (!user) {
            log(`User with telegram ID ${userId} not found in database for switch operation`, "error");
            await ctx.answerCbQuery("Error: User not found");
            return;
          }
          
          console.log(`[SWITCH_CALLBACK] Found user ${user.id} (telegramId: ${user.telegramId})`);
          
          // Get all active tickets for debugging
          const activeTickets = await storage.getActiveTicketsByUserId(user.id);
          console.log(`[SWITCH_CALLBACK] User has ${activeTickets.length} active tickets: ${JSON.stringify(activeTickets.map(t => ({id: t.id, status: t.status})))}`);
          
          
          // Get current user state
          let userState = this.userStates.get(userId);
          if (!userState) {
            // If no state in memory, create a basic one
            log(`Creating new user state for user ${userId} as none was found`, "debug");
            userState = {
              activeTicketId: undefined, // Use undefined instead of null
              categoryId: 0,
              currentQuestion: 0,
              answers: [],
              inQuestionnaire: false,
              lastUpdated: Date.now()
            };
            this.userStates.set(userId, userState);
          }
          
          if (switchOption === 'new' || data === 'start_new' || data === 'switch_new') {
            // User wants to create a new ticket, either from switch menu or from start menu
            await ctx.answerCbQuery("Creating a new ticket");
            
            // Important: We no longer bypass the duplicate ticket check
            // Store current state before starting new ticket creation
            await this.setState(userId, userState);
            
            await ctx.reply("✅ Let's create your new support ticket. Please select a category from the options displayed.");
            await this.handleCategoryMenu(ctx);
          } else {
            // User wants to switch to an existing ticket
            const ticketId = parseInt(switchOption);
            
            // Add comprehensive debug logging
            console.log(`[SWITCH DEBUG] User ${userId} attempting to switch to ticket #${ticketId}`);
            console.log(`[SWITCH DEBUG] Current user state: ${JSON.stringify(userState)}`);
            
            try {
              // Check if the ticket exists and belongs to this user
              const ticket = await storage.getTicket(ticketId);
              console.log(`[SWITCH DEBUG] Retrieved ticket: ${JSON.stringify(ticket)}`);
              
              if (!ticket) {
                await ctx.answerCbQuery(`Ticket #${ticketId} not found`);
                return;
              }
              
              // Check if the ticket belongs to this user
              if (ticket.userId !== user.id) {
                await ctx.answerCbQuery(`Ticket #${ticketId} does not belong to you`);
                return;
              }
              
              // Check if the ticket is active
              const validStatuses = ["open", "in-progress", "pending", "paid"];
              
              console.log(`[SWITCH DEBUG] Checking ticket #${ticketId} status: "${ticket.status}"`);
              console.log(`[SWITCH DEBUG] Valid statuses: ${JSON.stringify(validStatuses)}`);
              console.log(`[SWITCH DEBUG] Status check result: ${validStatuses.includes(ticket.status)}`);
              
              // Special handling for paid tickets (amount > 0)
              // This ensures 'paid' tickets are always recognized regardless of status field
              const isPaidTicket = ticket.amount && ticket.amount > 0;
              console.log(`[SWITCH DEBUG] Ticket amount: ${ticket.amount}, isPaidTicket: ${isPaidTicket}`);
              
              // Consider a ticket active if:
              // 1. It has a valid status OR
              // 2. It's a paid ticket (amount > 0)
              if (!validStatuses.includes(ticket.status) && !isPaidTicket) {
                console.log(`[SWITCH DEBUG] Ticket #${ticketId} has invalid status "${ticket.status}" and is not paid`);
                await ctx.answerCbQuery(`Ticket #${ticketId} is not active (status: ${ticket.status})`);
                await ctx.reply(`❌ Cannot switch to ticket #${ticketId} because it has status "${ticket.status}". Only tickets with status "open", "in-progress", "pending", or "paid" are accessible.`);
                return;
              }
              
              // If this is a paid ticket, log that we're allowing access despite status
              if (isPaidTicket && !validStatuses.includes(ticket.status)) {
                console.log(`[SWITCH DEBUG] Allowing access to paid ticket #${ticketId} despite status "${ticket.status}"`);
              }
              
              // Check if user is already viewing this ticket
              if (userState.activeTicketId === ticketId) {
                // User is already in this ticket, no need to switch
                await ctx.answerCbQuery(`You are already viewing ticket #${ticketId}`);
                await ctx.reply(`ℹ️ You're already viewing ticket #${ticketId}, no need to switch.`);
                return;
              }
              
              // Switch to this ticket
              const previousTicketId = userState.activeTicketId;
              userState.activeTicketId = ticketId;
              userState.categoryId = ticket.categoryId || 0;
              await this.setState(userId, userState);
              
              // Get category name for confirmation message
              const category = await storage.getCategory(ticket.categoryId || 0);
              const categoryName = category ? category.name : "Unknown category";
              
              await ctx.answerCbQuery(`Switched to ticket #${ticketId}`);
              
              // Send a clear confirmation message with visual separator
              await ctx.reply(`━━━━━━━━━━━━━━━━━━━━━━\n✅ *You are now in:* *${categoryName}* (#${ticketId})\n\n⚠️ *All your messages will be sent to this ticket.*\n━━━━━━━━━━━━━━━━━━━━━━`, {
                parse_mode: 'Markdown'
              });
              
              // Get all active tickets again to display the updated menu
              const userTickets = await storage.getActiveTicketsByUserId(user.id);
              
              // Create updated buttons list with the new selected ticket
              const updatedButtons = [];
              
              // Get categories info for updating the menu
              const categoryIds = [...new Set(userTickets.map(t => t.categoryId).filter(id => id !== null))];
              const categoriesMap = new Map();
              
              for (const catId of categoryIds) {
                const cat = await storage.getCategory(catId!);
                if (cat) {
                  categoriesMap.set(catId, cat);
                }
              }
              
              // Create a button for each ticket with updated status
              for (const t of userTickets) {
                const cat = categoriesMap.get(t.categoryId);
                const catName = cat ? cat.name : "Unknown category";
                
                // Mark currently active ticket
                const isActive = ticketId === t.id;
                const buttonLabel = isActive 
                  ? `✅ #${t.id}: ${catName} (current)` 
                  : `#${t.id}: ${catName}`;
                
                updatedButtons.push([{
                  text: buttonLabel,
                  callback_data: `switch_${t.id}`
                }]);
              }
              
              // Add button for creating a new ticket
              updatedButtons.push([{
                text: "➕ Create New Ticket",
                callback_data: "switch_new"
              }]);
              
              // Try to edit the original message with updated buttons
              // First need to check if we can get the original message ID
              const messageId = ctx.callbackQuery?.message?.message_id;
              if (messageId) {
                try {
                  // Update the inline keyboard with the new active ticket
                  await ctx.editMessageReplyMarkup({
                    inline_keyboard: updatedButtons
                  });
                } catch (editError) {
                  log(`Could not update switch menu: ${editError}`, "warn");
                  // Continue even if we couldn't update the menu
                }
              }
              
              // No need for a second confirmation message, already showing the formatted one above
              
              // Send notification to Discord
              try {
                // Check if we have all the data needed for this ticket
                if (!ticket.discordChannelId) {
                  log(`Cannot send Discord notification: ticket #${ticketId} has no Discord channel ID`, "warn");
                  return;
                }

                // Get user display name
                const firstName = ctx.from?.first_name || "";
                const lastName = ctx.from?.last_name || "";
                const displayName = [firstName, lastName].filter(Boolean).join(' ') || "Telegram User";
                
                // Get all active tickets for this user
                const userTickets = await storage.getActiveTicketsByUserId(user.id);
                log(`User has ${userTickets.length} active tickets for Discord notification`, "debug");
                
                // Get the ticket we're switching FROM if available
                // Get it from state first, then try to find other active tickets if none is in state
                let previousTicketId = userState.activeTicketId;
                const isPreviousSameAsCurrent = previousTicketId === ticketId;
                
                // Get all OTHER active tickets (that are not the current one)
                const otherTickets = userTickets.filter(t => t.id !== ticketId);
                log(`Found ${otherTickets.length} other active tickets`, "debug");
                
                // Always send a notification to the current channel
                const message = `**Note:** User switched to this ticket`;
                
                log(`Sending Discord notification to current channel: ${ticket.discordChannelId}`, "debug");
                await this.bridge.sendSystemMessageToDiscord(
                  ticket.discordChannelId,
                  message
                );
                
                // Now notify all OTHER tickets that the user is no longer viewing them
                for (const otherTicket of otherTickets) {
                  if (otherTicket.discordChannelId) {
                    log(`Sending Discord notification to other channel: ${otherTicket.discordChannelId}`, "debug");
                    
                    // Create message content without the command instruction
                    const messageContent = `**Note:** The user has switched to ticket #${ticketId} (${categoryName}) and may not see messages here anymore.`;
                    
                    // Only include the force button on successful switch, not when attempting to switch
                    // Use our updated system message method with Force Back button
                    await this.bridge.sendSystemMessageToDiscord(
                      otherTicket.discordChannelId,
                      messageContent,
                      {
                        // We include force button here because this is after a SUCCESSFUL switch
                        showForceButton: true,
                        telegramId: user.telegramId || "",
                        ticketId: otherTicket.id, // Button to force back to THIS ticket
                        username: displayName
                      }
                    );
                  }
                }
              } catch (error) {
                log(`Error sending Discord notification for ticket switch: ${error}`, "warn");
                // Don't block the main flow if Discord notification fails
              }
            } catch (error) {
              log(`Error switching tickets: ${error}`, "error");
              await ctx.answerCbQuery("Error switching tickets");
              await ctx.reply("❌ Error switching tickets. Please try again later.");
            }
          }
        } else {
          await ctx.answerCbQuery("Unknown button action");
        }
      } catch (error) {
        log(`Error processing button click: ${error}`, "error");
        await ctx.answerCbQuery("Error processing your request");
      }
    });
    
    // Handle text messages
    this.bot.on('text', async (ctx) => {
      if (!ctx.from?.id || !ctx.message?.text) return;
      
      const userId = ctx.from.id;
      console.log(`[TEXT_MESSAGE] Received text message from user ${userId}: "${ctx.message.text.substring(0, 30)}${ctx.message.text.length > 30 ? '...' : ''}"`);
      
      
      // First check if this is a critical command using the raw processor
      // This is a fallback mechanism for commands like /close that might fail
      try {
        const handled = await processRawMessage(ctx.message, ctx, this.bridge);
        if (handled) {
          log(`Message processed by raw handler: ${ctx.message.text}`, "debug");
          return;
        }
      } catch (error) {
        log(`Error in raw message processor: ${error}`, "error");
      }
      
      // Get current state if it exists
      const initialState = this.userStates.get(userId);
      let userState = initialState ? { ...initialState } : undefined;
      log(`Initial user state check: ${JSON.stringify(userState)}`);
      
      try {
        // Get the user from DB
        const user = await storage.getUserByTelegramId(userId.toString());
        if (!user) {
          log(`No user found for telegramId: ${userId}, ignoring message`, "warn");
          return;
        }
        
        // If no state, check if the user has an active ticket in the database
        // This handles cases after bot restart where states aren't fully loaded
        if (!userState) {
          log(`No user state found for ${userId}, but user exists in DB. Checking for active tickets...`);
          
          // Check if user has an active ticket
          const activeTicket = await storage.getActiveTicketByUserId(user.id);
          if (activeTicket) {
            log(`Found active ticket ${activeTicket.id} for user ${userId} without loaded state, reconstructing state`);
            
            // Recreate state
            const newState = {
              activeTicketId: activeTicket.id,
              categoryId: activeTicket.categoryId!,
              currentQuestion: 0,
              answers: [],
              inQuestionnaire: false,
              lastUpdated: Date.now()
            };
            
            // Update our local copy and store in the global state
            userState = newState;
            await this.setState(userId, newState);
          } else {
            log(`No active tickets found for user ${userId}, ignoring message`, "info");
            await ctx.reply("You don't have an active ticket. Use /start to create a new one.");
            return;
          }
        }
        
        // Check if banned
        if (user.isBanned) {
          await ctx.reply(`⛔ You are banned from using this bot${user.banReason ? ` for: ${user.banReason}` : ""}.`);
          return;
        }
        
        // If in questionnaire, handle that
        if (userState.inQuestionnaire) {
          // Check if category is closed
          const category = await storage.getCategory(userState.categoryId);
          if (category && category.isClosed) {
            await ctx.reply("⛔ This service is currently closed. Please try another service or contact an administrator.");
            // Clear the questionnaire state
            userState.inQuestionnaire = false;
            this.setState(userId, userState);
            return;
          }
          
          await this.handleQuestionnaireResponse(ctx, userState);
          return;
        }
        
        // Handle ticket switching after /switch command
        // Check if user has just requested the switch command and is now selecting a ticket
        const lastCommand = ctx.message.text.trim().toLowerCase();
        
        // Check if the input is a ticket ID number or "new"
        if (lastCommand === "new") {
          // User wants to create a new ticket, reset state and redirect to /start
          await ctx.reply("✅ Let's create your new support ticket. Please select a category from the options displayed.");
          await this.handleCategoryMenu(ctx);
          return;
        } else if (/^\d+$/.test(lastCommand)) {
          // User is trying to switch to a specific ticket ID
          const ticketId = parseInt(lastCommand);
          
          try {
            // Check if the ticket belongs to this user
            const ticket = await storage.getTicket(ticketId);
            
            if (!ticket) {
              await ctx.reply(`❌ Ticket #${ticketId} not found.`);
              return;
            }
            
            // Check if the ticket belongs to this user
            if (ticket.userId !== user.id) {
              await ctx.reply(`❌ Ticket #${ticketId} does not belong to you.`);
              return;
            }
            
            // Check if the ticket is active - support all valid active statuses
            const validStatuses = ["open", "in-progress", "pending", "paid"];
            
            console.log(`[TEXT_SWITCH] Checking ticket #${ticketId} status: "${ticket.status}"`);
            
            // Special handling for paid tickets (amount > 0)
            // This ensures 'paid' tickets are always recognized regardless of status field
            const isPaidTicket = ticket.amount && ticket.amount > 0;
            console.log(`[TEXT_SWITCH] Ticket amount: ${ticket.amount}, isPaidTicket: ${isPaidTicket}`);
            
            // Consider a ticket active if:
            // 1. It has a valid status OR
            // 2. It's a paid ticket (amount > 0)
            if (!validStatuses.includes(ticket.status) && !isPaidTicket) {
              console.log(`[TEXT_SWITCH] Ticket #${ticketId} has invalid status "${ticket.status}" and is not paid`);
              await ctx.reply(`❌ Cannot switch to ticket #${ticketId} because it has status "${ticket.status}". Only tickets with status "open", "in-progress", "pending", or "paid" are accessible.`);
              return;
            }
            
            // If this is a paid ticket, log that we're allowing access despite status
            if (isPaidTicket && !validStatuses.includes(ticket.status)) {
              console.log(`[TEXT_SWITCH] Allowing access to paid ticket #${ticketId} despite status "${ticket.status}"`);
            }
            
            // Check if user is already viewing this ticket
            if (userState.activeTicketId === ticketId) {
              // User is already in this ticket, no need to switch
              await ctx.reply(`ℹ️ You're already viewing ticket #${ticketId}, no need to switch.`);
              return;
            }
            
            // Get current active ticket ID before switching
            const previousTicketId = userState.activeTicketId;
            
            // Switch to this ticket
            userState.activeTicketId = ticketId;
            userState.categoryId = ticket.categoryId!;
            await this.setState(userId, userState);
            
            // Get category name for confirmation message
            const category = await storage.getCategory(ticket.categoryId!);
            const categoryName = category ? category.name : "Unknown category";
            
            // Send a formatted confirmation message with visual separator
            await ctx.reply(`━━━━━━━━━━━━━━━━━━━━━━\n✅ *You are now in:* *${categoryName}* (#${ticketId})\n\n⚠️ *All your messages will be sent to this ticket.*\n━━━━━━━━━━━━━━━━━━━━━━`, {
              parse_mode: 'Markdown'
            });
            
            // Send notification to Discord channels
            try {
              // Send system message to the channel they switched to
              if (ticket.discordChannelId) {
                await this.bridge.sendSystemMessageToDiscord(
                  ticket.discordChannelId,
                  `**Note:** The user has switched back to this ticket.`
                );
              }
              
              // If they had a previous ticket, notify that channel too
              if (previousTicketId && previousTicketId !== ticketId) {
                const previousTicket = await storage.getTicket(previousTicketId);
                if (previousTicket?.discordChannelId) {
                  const displayName = user.telegramName || user.username || 'User';
                  
                  // Send notification with Force Back button to previous channel
                  await this.bridge.sendSystemMessageToDiscord(
                    previousTicket.discordChannelId,
                    `**Note:** The user has switched to ticket #${ticketId} (${categoryName}) and may not see messages here anymore.`,
                    {
                      showForceButton: true,
                      telegramId: user.telegramId || "",
                      ticketId: previousTicketId, // Button to force back to previous ticket
                      username: displayName
                    }
                  );
                }
              }
            } catch (error) {
              log(`Error sending Discord notification for manual ticket switch: ${error}`, "warn");
              // Don't block the main flow if Discord notification fails
            }
            
            return;
          } catch (error) {
            log(`Error switching tickets: ${error}`, "error");
            await ctx.reply("❌ Error switching tickets. Please try again later.");
            return;
          }
        }
        
        // If active ticket, handle that
        if (userState.activeTicketId) {
          console.log(`[MESSAGE HANDLER] User ${userId} has active ticket ID ${userState.activeTicketId} in state`);
          
          const ticket = await storage.getTicket(userState.activeTicketId);
          console.log(`[MESSAGE HANDLER] Retrieved ticket details: ${JSON.stringify(ticket || {})}`);
          
          // Define valid active statuses explicitly - this should match the statuses used in ticket switching
          const validStatuses = ["open", "in-progress", "pending", "paid"];
          
          if (ticket) {
            console.log(`[MESSAGE HANDLER] Checking ticket #${ticket.id} status: "${ticket.status}"`);
            
            // Special handling for paid tickets (amount > 0)
            // This ensures 'paid' tickets are always recognized regardless of status field
            const isPaidTicket = ticket.amount && ticket.amount > 0;
            console.log(`[MESSAGE HANDLER] Ticket amount: ${ticket.amount}, isPaidTicket: ${isPaidTicket}`);
            
            // Check if ticket exists and has a valid active status OR is a paid ticket
            if (validStatuses.includes(ticket.status) || isPaidTicket) {
              // If this is a paid ticket, log that we're allowing access despite status
              if (isPaidTicket && !validStatuses.includes(ticket.status)) {
                console.log(`[MESSAGE HANDLER] Allowing access to paid ticket #${ticket.id} despite status "${ticket.status}"`);
              }
              
              console.log(`[MESSAGE HANDLER] Processing message for active ticket #${ticket.id} with status "${ticket.status}"`);
              await this.handleTicketMessage(ctx, user, ticket);
              return;
            } else {
              console.log(`[MESSAGE HANDLER] Ticket #${ticket.id} has inactive status "${ticket.status}" and is not paid, rejecting message`);
              await ctx.reply(`❌ Your ticket #${ticket.id} has status "${ticket.status}" and is no longer active. Use /start to create a new ticket or /switch to view your active tickets.`);
              return;
            }
          } else {
            console.log(`[MESSAGE HANDLER] Active ticket #${userState.activeTicketId} not found in database`);
          }
        }
      } catch (error) {
        log(`Error processing text message: ${error}`, "error");
      }
    });
    
    // Handle photos
    this.bot.on('photo', async (ctx) => {
      if (!ctx.from?.id || !ctx.message?.photo) return;
      
      const userId = ctx.from.id;
      // Get current state if it exists
      const originalState = this.userStates.get(userId);
      let userState = originalState ? { ...originalState } : undefined;
      log(`Photo received - Initial user state check: ${JSON.stringify(userState)}`);
      
      try {
        // Get the user from DB
        const user = await storage.getUserByTelegramId(userId.toString());
        if (!user) {
          log(`No user found for telegramId: ${userId}, ignoring photo`, "warn");
          return;
        }
        
        // If no state, check if the user has an active ticket in the database
        // This handles cases after bot restart where states aren't fully loaded
        if (!userState || !userState.activeTicketId) {
          log(`No valid user state found for ${userId}, but user exists in DB. Checking for active tickets...`);
          
          // Check if user has an active ticket
          const activeTicket = await storage.getActiveTicketByUserId(user.id);
          if (activeTicket) {
            log(`Found active ticket ${activeTicket.id} for user ${userId} without loaded state, reconstructing state`);
            
            // Recreate state
            const newState = {
              activeTicketId: activeTicket.id,
              categoryId: activeTicket.categoryId!,
              currentQuestion: 0,
              answers: [],
              inQuestionnaire: false,
              lastUpdated: Date.now()
            };
            
            // Update our local copy and store in the global state
            userState = newState;
            await this.setState(userId, newState);
          } else {
            log(`No active tickets found for user ${userId}, ignoring photo`, "info");
            await ctx.reply("You don't have an active ticket. Use /start to create a new one.");
            return;
          }
        }
        
        // Check if banned
        if (user.isBanned) {
          await ctx.reply(`⛔ You are banned from using this bot${user.banReason ? ` for: ${user.banReason}` : ""}.`);
          return;
        }
        
        // Use the already defined userState
        let activeTicketId = userState?.activeTicketId;
        
        // Get all active tickets
        const activeTickets = await storage.getActiveTicketsByUserId(user.id);
        if (activeTickets.length === 0) {
          await ctx.reply("❌ You don't have any active tickets. Use /start to create one.");
          return;
        }
        
        // If the user isn't currently in a ticket but has active tickets, ask them to select one
        if (!activeTicketId) {
          if (activeTickets.length === 1) {
            // If there's only one active ticket, use that one
            activeTicketId = activeTickets[0].id;
          } else {
            await ctx.reply("ℹ️ You have multiple active tickets. Please use /switch to select a ticket before sending photos.");
            return;
          }
        }
        
        // Get the specific ticket
        const ticket = activeTickets.find(t => t.id === activeTicketId);
        if (!ticket) {
          console.log(`[PHOTO HANDLER] Selected ticket #${activeTicketId} not found in active tickets list`);
          await ctx.reply("❌ The selected ticket is no longer active. Use /start to create a new one or /switch to select another.");
          return;
        }
        
        // Double-check the ticket status - define valid active statuses explicitly
        // This should match the statuses used in ticket switching
        const validStatuses = ["open", "in-progress", "pending", "paid"];
        
        console.log(`[PHOTO HANDLER] Checking ticket #${ticket.id} status: "${ticket.status}"`);
        
        // Special handling for paid tickets (amount > 0)
        // This ensures 'paid' tickets are always recognized regardless of status field
        const isPaidTicket = ticket.amount && ticket.amount > 0;
        console.log(`[PHOTO HANDLER] Ticket amount: ${ticket.amount}, isPaidTicket: ${isPaidTicket}`);
        
        // Consider a ticket active if:
        // 1. It has a valid status OR
        // 2. It's a paid ticket (amount > 0)
        if (!validStatuses.includes(ticket.status) && !isPaidTicket) {
          console.log(`[PHOTO HANDLER] Ticket #${ticket.id} has invalid status "${ticket.status}" and is not paid`);
          await ctx.reply(`❌ Your ticket #${ticket.id} has status "${ticket.status}" and is no longer active. Use /start to create a new ticket or /switch to view your active tickets.`);
          return;
        }
        
        // If this is a paid ticket, log that we're allowing access despite status
        if (isPaidTicket && !validStatuses.includes(ticket.status)) {
          console.log(`[PHOTO HANDLER] Allowing access to paid ticket #${ticket.id} despite status "${ticket.status}"`);
        }
        
        console.log(`[PHOTO HANDLER] Processing photo for active ticket #${ticket.id} with status "${ticket.status}"`);
        
        
        // Get largest photo
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        if (!photo) return;
        
        // Process caption as a message
        // Only use "Image sent" as a database placeholder, not as the actual caption for Discord
        const databaseCaption = ctx.message.caption || "Image sent";
        // For Discord, either use the actual caption or an empty string (not "Image sent")
        const discordCaption = ctx.message.caption || "";
        
        // Store the message in the database
        // Get user display name for the transcript
        const senderName = user.telegramName || user.telegramUsername || user.username || 'Telegram User';
        
        await storage.createMessage({
          ticketId: ticket.id,
          content: databaseCaption,
          authorId: user.id,
          platform: "telegram",
          timestamp: new Date(),
          senderName: senderName
        });
        
        // Get photo file
        const file = await this.getFile(photo.file_id);
        if (!file?.file_path) {
          await ctx.reply("❌ Error processing your image. Please try again.");
          return;
        }
        
        // Get URL for the file
        const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        
        // Forward to Discord with image
        const firstName = ctx.from?.first_name || "";
        const lastName = ctx.from?.last_name || "";
        const displayName = [firstName, lastName].filter(Boolean).join(' ') || "Telegram User";
        
        // Get avatar URL
        let avatarUrl: string | undefined;
        try {
          const photos = await this.telegram.getUserProfilePhotos(ctx.from.id, 0, 1);
          if (photos && photos.total_count > 0) {
            const fileId = photos.photos[0][0].file_id;
            const avatarFile = await this.getFile(fileId);
            if (avatarFile?.file_path) {
              avatarUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${avatarFile.file_path}`;
            }
          }
        } catch (error) {
          log(`Error getting avatar: ${error}`, "error");
        }
        
        // Use the variable we defined earlier for Discord caption
        await this.bridge.forwardToDiscord(
          discordCaption, // Use empty string instead of "Image sent" when there's no caption
          ticket.id,
          displayName,
          avatarUrl,
          fileUrl,
          firstName,
          lastName,
          ctx.from.id
        );
        
        log(`Photo forwarded from Telegram to Discord for ticket ${ticket.id}`);
      } catch (error) {
        log(`Error processing photo: ${error}`, "error");
        await ctx.reply("❌ Error processing your image. Please try again.");
      }
    });
  }
}