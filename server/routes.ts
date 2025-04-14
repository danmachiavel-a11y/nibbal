import type { Express } from "express";
import { createServer } from "http";
import { storage } from "./storage";
import { BridgeManager } from "./bot/bridge";
import { z } from "zod";
import { log } from "./vite";
import { pool } from "./db";
import * as fs from 'fs';
import * as path from 'path';

let bridge: BridgeManager | null = null;

export async function registerRoutes(app: Express) {
  log("Setting up HTTP server...");
  const httpServer = createServer(app);

  // Health check endpoint - always register first
  app.get("/api/health", async (req, res) => {
    try {
      // Check basic server health
      const serverHealth = {
        status: "healthy",
        timestamp: new Date().toISOString()
      };

      // Check bot health if bridge exists
      if (bridge) {
        const botHealth = await bridge.healthCheck();
        
        // Get detailed status for each bot
        let telegramStatus: Record<string, any> = { connected: botHealth.telegram };
        let discordStatus: Record<string, any> = { connected: botHealth.discord };
        
        // Add detailed information for Discord
        if (botHealth.discord) {
          try {
            const discordBot = bridge.getDiscordBot();
            try {
              await discordBot.getCategories();
              discordStatus.serverConnected = true;
            } catch (err) {
              const error = err as Error;
              if (error.message?.includes("Bot is not in any servers")) {
                discordStatus.serverConnected = false;
                discordStatus.errorCode = "NO_SERVER_CONNECTED";
                discordStatus.errorMessage = "Bot is authenticated but not invited to any servers";
              }
            }
            
            // Also check for last error in Discord
            if (typeof discordBot.getLastError === 'function') {
              const lastError = discordBot.getLastError();
              if (lastError) {
                discordStatus.lastError = lastError;
              }
            }
          } catch (err) {
            // Handle Discord bot access errors
            const error = err as Error;
            discordStatus.errorMessage = error.message || String(err);
          }
        }

        // Add detailed information for Telegram
        if (!botHealth.telegram) {
          telegramStatus.errorCode = "TELEGRAM_CONNECTION_FAILED";
          // Check for common errors
          try {
            const telegramBot = bridge.getTelegramBot();
            // Use the new method that is publicly accessible
            if (typeof telegramBot.isStartingProcess === 'function') {
              telegramStatus.isStarting = telegramBot.isStartingProcess();
            }
            if (typeof telegramBot.getLastError === 'function') {
              telegramStatus.lastError = telegramBot.getLastError();
            }
          } catch (err) {
            const error = err as Error;
            telegramStatus.errorMessage = "Cannot access Telegram bot details: " + (error.message || String(err));
          }
        }
        
        res.json({
          ...serverHealth,
          bots: {
            telegram: telegramStatus,
            discord: discordStatus
          }
        });
      } else {
        res.json({
          ...serverHealth,
          bots: {
            telegram: { connected: false, errorCode: "BOT_BRIDGE_INITIALIZING" },
            discord: { connected: false, errorCode: "BOT_BRIDGE_INITIALIZING" },
            message: "Bot bridge initializing"
          }
        });
      }
    } catch (error: any) {
      log(`Health check failed: ${error}`, "error");
      res.status(503).json({
        status: "unhealthy",
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  // Emergency ticket closing page
  app.get("/emergency-close", (req, res) => {
    res.sendFile("emergency-close.html", { root: "." });
  });
  
  // Enhanced bridge initialization with retry logic for deployment scenarios
  const MAX_BRIDGE_INIT_RETRIES = 5;
  const INITIAL_RETRY_DELAY_MS = 3000; // 3 seconds
  const MAX_RETRY_DELAY_MS = 30000; // 30 seconds
  
  // Initialize bridge with automatic retry logic
  async function initializeBridge() {
    let bridgeInitAttempt = 0;
    let retryDelay = INITIAL_RETRY_DELAY_MS;
    let bridgeStarted = false;
    
    // Record start time for reporting
    const startTime = Date.now();
    
    log("Starting bridge initialization process...", "info");
    
    // Loop until bridge starts or we reach maximum attempts
    while (!bridgeStarted && bridgeInitAttempt < MAX_BRIDGE_INIT_RETRIES) {
      bridgeInitAttempt++;
      
      try {
        // Create new bridge instance if needed
        if (!bridge) {
          log(`Creating new bridge instance (attempt ${bridgeInitAttempt})`, "info");
          bridge = new BridgeManager();
        }
        
        // Attempt to start bridge
        log(`Starting bridge (attempt ${bridgeInitAttempt}/${MAX_BRIDGE_INIT_RETRIES})`, "info");
        await bridge.start();
        
        // Bridge started successfully!
        bridgeStarted = true;
        const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);
        log(`Bridge initialized successfully after ${bridgeInitAttempt} attempt(s) (${elapsedTime}s)`, "info");
        
        // In production, add additional checks after startup
        if (process.env.NODE_ENV === 'production') {
          log("Running bridge health validation in production mode...", "info");
          setTimeout(async () => {
            try {
              const health = await bridge?.healthCheck();
              log(`Bridge health check after 10s: Telegram=${health?.telegram}, Discord=${health?.discord}`, "info");
              
              // If either bot is not connected, attempt recovery
              if (!health?.telegram || !health?.discord) {
                log("Detected disconnected bot after startup, attempting recovery", "warn");
                
                if (!health?.telegram) {
                  log("Telegram bot disconnected, attempting restart", "warn");
                  await bridge?.restartTelegramBot().catch(e => 
                    log(`Failed to restart Telegram bot: ${e}`, "error")
                  );
                }
                
                if (!health?.discord) {
                  log("Discord bot disconnected, attempting restart", "warn");
                  await bridge?.restartDiscordBot().catch(e => 
                    log(`Failed to restart Discord bot: ${e}`, "error")
                  );
                }
              }
            } catch (healthError) {
              log(`Bridge health validation failed: ${healthError}`, "error");
            }
          }, 10000); // Check health after 10 seconds
        }
        
      } catch (error: any) {
        // Only run cleanup after initial attempt
        if (bridgeInitAttempt === 1) {
          try {
            // Try to fix the "409: Conflict" error by forcibly cleaning up old connections
            if (error.message?.includes("409: Conflict") || error.message?.includes("terminated by other getUpdates")) {
              log("Detected Telegram 409 Conflict error - this means another instance is running", "warn");
              log("Attempting to clean up old Telegram connections...", "info");
              
              // Try to forcibly close and restart the Telegram client
              if (bridge) {
                try {
                  await bridge.cleanupTelegramConnections();
                  log("Telegram cleanup completed, will retry after delay", "info");
                } catch (cleanupError) {
                  log(`Telegram cleanup failed: ${cleanupError}`, "error");
                }
              }
            }
          } catch (cleanupError) {
            log(`Error during cleanup: ${cleanupError}`, "error");
          }
        }
        
        // Log the error
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorDetails = {
          context: `startBridge-${bridgeInitAttempt}`,
          timestamp: new Date().toISOString(),
          attempt: bridgeInitAttempt,
          errorType: error.constructor?.name || typeof error
        };
        
        log(`Bridge initialization failed (attempt ${bridgeInitAttempt}): ${errorMessage}`, "error");
        log(`Error details: ${JSON.stringify(errorDetails)}`, "error");
        
        // If we have more attempts remaining, retry after delay
        if (bridgeInitAttempt < MAX_BRIDGE_INIT_RETRIES) {
          log(`Retrying bridge initialization in ${retryDelay}ms...`, "info");
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          
          // Calculate next retry delay with exponential backoff
          retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
          
          // Add jitter to prevent thundering herd problem
          const jitter = retryDelay * 0.1; // ±10%
          retryDelay = Math.floor(retryDelay - jitter + Math.random() * jitter * 2);
        } else {
          log(`Bridge initialization failed after ${MAX_BRIDGE_INIT_RETRIES} attempts`, "error");
          
          // Even though initialization failed, create a disabled bridge to ensure 
          // the API doesn't crash when bridge operations are attempted
          if (!bridge) {
            log("Creating disabled bridge instance for API stability", "warn");
            bridge = new BridgeManager();
            bridge.markAsDisabled(`Initialization failed: ${errorMessage}`);
          }
        }
      }
    }
    
    // Final report
    if (bridgeStarted) {
      log("Bridge is fully operational ✓", "info");
    } else {
      log("Bridge initialization failed! Some functionality will be limited.", "error");
    }
  }
  
  // Start bridge initialization using process.nextTick to ensure all routes are registered first
  process.nextTick(() => {
    initializeBridge().catch(error => {
      log(`Unexpected error during bridge initialization: ${error}`, "error");
    });
  });

  // Bot Config Routes
  app.get("/api/bot-config", async (req, res) => {
    try {
      const config = await storage.getBotConfig();
      res.json(config);
    } catch (error: any) {
      log(`Error getting bot config: ${error}`, "error");
      res.status(500).json({ message: "Failed to get bot configuration" });
    }
  });

  app.patch("/api/bot-config", async (req, res) => {
    try {
      const schema = z.object({
        welcomeMessage: z.string().optional(),
        welcomeImageUrl: z.string().nullable().optional(),
        telegramToken: z.string().optional(),
        discordToken: z.string().optional(),
        adminTelegramIds: z.array(z.string()).optional(),
        adminDiscordIds: z.array(z.string()).optional(),
      });

      const result = schema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ message: "Invalid request body" });
      }

      // Store tokens in environment variables if provided
      if (result.data.telegramToken) {
        process.env.TELEGRAM_BOT_TOKEN = result.data.telegramToken;
      }
      if (result.data.discordToken) {
        process.env.DISCORD_BOT_TOKEN = result.data.discordToken;
      }

      // Update bot config in storage
      const config = await storage.updateBotConfig(result.data);

      // If tokens were updated, restart the bridge
      if (result.data.telegramToken || result.data.discordToken) {
        if (bridge) {
          log("Restarting bots with new configuration...");
          await bridge.restart();
          log("Bots restarted successfully");
        }
      }

      res.json(config);
    } catch (error: any) {
      log(`Error updating bot config: ${error}`, "error");
      res.status(500).json({ message: "Failed to update bot configuration" });
    }
  });


  // Bot token configuration and status endpoints
  app.get("/api/bot/telegram/status", async (req, res) => {
    try {
      if (!bridge) {
        return res.json({ 
          connected: false,
          error: {
            code: "BOT_BRIDGE_UNAVAILABLE",
            message: "Bot bridge not initialized"
          },
          environment: {
            token_set: Boolean(process.env.TELEGRAM_BOT_TOKEN),
            token_length: process.env.TELEGRAM_BOT_TOKEN ? process.env.TELEGRAM_BOT_TOKEN.length : 0,
            using_env_file: fs.existsSync(path.resolve(process.cwd(), '.env'))
          }
        });
      }
      
      const telegramBot = bridge.getTelegramBot();
      const connected = telegramBot?.getIsConnected() || false;
      
      // Include more detailed information
      let errorDetails = null;
      if (!connected && telegramBot) {
        errorDetails = {
          code: "TELEGRAM_BOT_UNAVAILABLE",
          message: "Telegram bot failed to initialize or connect"
        };
      }
      
      res.json({
        connected,
        error: errorDetails,
        environment: {
          token_set: Boolean(process.env.TELEGRAM_BOT_TOKEN),
          token_length: process.env.TELEGRAM_BOT_TOKEN ? process.env.TELEGRAM_BOT_TOKEN.length : 0,
          using_env_file: fs.existsSync(path.resolve(process.cwd(), '.env'))
        }
      });
    } catch (error: any) {
      log(`Error checking Telegram bot status: ${error}`, "error");
      res.status(500).json({ 
        connected: false,
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to check Telegram bot status: ${error.message}`
        }
      });
    }
  });

  app.get("/api/bot/discord/status", async (req, res) => {
    try {
      if (!bridge) {
        return res.json({ 
          connected: false,
          error: {
            code: "BOT_BRIDGE_UNAVAILABLE",
            message: "Bot bridge not initialized"
          },
          environment: {
            token_set: Boolean(process.env.DISCORD_BOT_TOKEN),
            token_length: process.env.DISCORD_BOT_TOKEN ? process.env.DISCORD_BOT_TOKEN.length : 0,
            using_env_file: fs.existsSync(path.resolve(process.cwd(), '.env'))
          }
        });
      }
      
      const discordBot = bridge.getDiscordBot();
      const connected = !!discordBot?.isReady();
      
      // Include more detailed information if Discord is not connected
      let errorDetails = null;
      if (!connected && discordBot) {
        const lastError = discordBot.getLastError();
        
        // Initialize with a default error object
        errorDetails = {
          code: "DISCORD_BOT_UNAVAILABLE",
          message: "Discord bot failed to initialize or connect"
        };
        
        // Override with bot's specific error if available
        if (lastError) {
          if (typeof lastError === 'string') {
            // Handle string error
            errorDetails.message = lastError;
            
            // Check for specific error messages in the string
            if (lastError.includes("Unauthorized")) {
              errorDetails.code = "INVALID_TOKEN";
              errorDetails = {
                ...errorDetails,
                hint: "The Discord bot token appears to be invalid. Please check your token and try again."
              };
            } else if (lastError.includes("Connection reset")) {
              errorDetails.code = "CONNECTION_RESET";
              errorDetails = {
                ...errorDetails,
                hint: "Connection to Discord API was reset. This may be due to network issues or rate limiting."
              };
            }
          } else if (typeof lastError === 'object' && lastError !== null) {
            // Handle object error, preserving the existing properties
            errorDetails = {
              ...errorDetails,
              // Safely spread non-null object properties
              ...(lastError as Record<string, unknown>)
            };
            
            // Add hints for specific error codes - safely check for code property
            if (lastError && typeof lastError === 'object' && 'code' in lastError && (lastError as {code: string}).code === "TOKEN_INVALID") {
              errorDetails = {
                ...errorDetails,
                hint: "The Discord bot token appears to be invalid. Please check your token and try again."
              };
            }
          }
        }
      }
      
      // Try to check for server access if connected
      let serverConnected = false;
      let serverError = null;
      
      if (connected && discordBot) {
        try {
          await discordBot.getCategories();
          serverConnected = true;
        } catch (err) {
          const error = err as Error;
          if (error.message?.includes("Bot is not in any servers")) {
            serverError = {
              code: "NO_SERVER_CONNECTED",
              message: "Bot is authenticated but not invited to any servers",
              hint: "Invite the bot to your Discord server using an OAuth2 invite link"
            };
          } else if (error.message?.includes("Missing Access") || error.message?.includes("Missing Permissions")) {
            serverError = {
              code: "INSUFFICIENT_PERMISSIONS",
              message: "Bot doesn't have the required permissions in the server",
              hint: "Check the bot's role permissions in your Discord server"
            };
          } else {
            serverError = {
              code: "SERVER_ACCESS_ERROR",
              message: error.message || "Unknown error accessing server resources"
            };
          }
        }
      }
      
      res.json({
        connected,
        server_connected: serverConnected,
        error: errorDetails,
        server_error: serverError,
        environment: {
          token_set: Boolean(process.env.DISCORD_BOT_TOKEN),
          token_length: process.env.DISCORD_BOT_TOKEN ? process.env.DISCORD_BOT_TOKEN.length : 0,
          using_env_file: fs.existsSync(path.resolve(process.cwd(), '.env'))
        }
      });
    } catch (error: any) {
      log(`Error checking Discord bot status: ${error}`, "error");
      res.status(500).json({ 
        connected: false,
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to check Discord bot status: ${error.message}`
        }
      });
    }
  });
  
  // Platform switching API
  app.post("/api/bot/platform/switch", async (req, res) => {
    try {
      const { platform } = req.body;
      
      // Validate platform parameter
      if (platform !== 'discord' && platform !== 'revolt') {
        return res.status(400).json({ 
          success: false, 
          error: "Invalid platform value. Must be 'discord' or 'revolt'" 
        });
      }
      
      // Check if bridge is initialized
      if (!bridge) {
        return res.status(500).json({ 
          success: false, 
          error: "Bridge not initialized" 
        });
      }
      
      // Perform platform switch
      const result = await bridge.switchPlatform(platform);
      
      if (result) {
        res.json({ 
          success: true, 
          message: `Successfully switched to ${platform} platform` 
        });
      } else {
        res.status(500).json({ 
          success: false, 
          error: `Failed to switch to ${platform} platform` 
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Error switching platform: ${errorMessage}`);
      res.status(500).json({ success: false, error: errorMessage });
    }
  });
  
  // API endpoint to update Revolt bot token
  app.post("/api/bot/revolt/config", async (req, res) => {
    try {
      const { token } = req.body;
      
      if (!token) {
        return res.status(400).json({ 
          success: false, 
          message: "Revolt token is required"
        });
      }
      
      // Update process environment variables
      process.env.REVOLT_BOT_TOKEN = token;
      
      // Import and use the utility function from loadEnv.ts
      const { updateEnvFile } = await import('../utilities/loadEnv.js');
      
      // Try to update .env file
      const updated = await updateEnvFile({
        REVOLT_BOT_TOKEN: token
      });
      
      if (updated) {
        log("Updated .env file with new Revolt token");
      } else {
        log("Failed to update .env file, but environment variable was set", "warn");
      }
      
      // Update the configuration in the database
      const updatedConfig = await storage.updateBotConfig({
        revoltToken: token
      });
      
      // Restart the bot if needed
      if (bridge) {
        try {
          // Only restart if platform is current
          const config = await storage.getBotConfig();
          if (config?.activeProvider === 'revolt') {
            await bridge.switchPlatform('revolt');
          }
        } catch (error) {
          log(`Error restarting Revolt bot: ${error}`, "error");
        }
      }
      
      res.json({ 
        success: true, 
        message: "Revolt token updated successfully" 
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log(`Error updating Revolt token: ${errorMessage}`, "error");
      res.status(500).json({ 
        success: false, 
        error: errorMessage 
      });
    }
  });

  // API endpoint to update Discord bot token
  app.post("/api/bot/discord/config", async (req, res) => {
    try {
      const { token } = req.body;
      
      if (!token) {
        return res.status(400).json({ 
          success: false, 
          message: "Discord token is required"
        });
      }
      
      // Validate token format
      if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
        return res.status(400).json({
          success: false,
          message: "Invalid Discord token format. Token should be in the format: XXXX.YYYY.ZZZZ"
        });
      }
      
      // Update process environment variables
      process.env.DISCORD_BOT_TOKEN = token;
      
      // Import and use the utility function from loadEnv.ts
      const { updateEnvFile } = await import('../utilities/loadEnv.js');
      
      // Try to update .env file
      let fileUpdated = false;
      try {
        fileUpdated = updateEnvFile({ DISCORD_BOT_TOKEN: token });
        if (fileUpdated) {
          log("Updated .env file with new Discord token", "info");
        } else {
          log("Failed to update .env file", "warn");
        }
      } catch (error) {
        log(`Error updating .env file: ${error}`, "error");
      }
      
      // If the bridge is active, try to restart the Discord bot
      let restartSuccess = false;
      if (bridge) {
        try {
          await bridge.restartDiscordBot();
          restartSuccess = true;
          log("Discord bot restarted successfully", "info");
        } catch (error) {
          log(`Error restarting Discord bot: ${error}`, "error");
        }
      }
      
      // Return status with diagnostic information
      return res.json({
        success: true,
        message: "Discord bot configuration updated",
        token_length: token.length,
        env_file_updated: fileUpdated,
        bot_restarted: restartSuccess,
        next_steps: !restartSuccess ? [
          "The configuration was saved, but the bot could not be automatically restarted.",
          "You may need to manually restart the application for changes to take effect."
        ] : []
      });
    } catch (error) {
      log(`Error updating Discord bot configuration: ${error}`, "error");
      return res.status(500).json({
        success: false,
        message: `Error updating Discord bot configuration: ${error}`
      });
    }
  });
  
  // API endpoint to update Telegram bot token
  app.post("/api/bot/telegram/config", async (req, res) => {
    try {
      const { token } = req.body;
      
      if (!token) {
        return res.status(400).json({ 
          success: false, 
          message: "Telegram token is required"
        });
      }
      
      // Validate token format (common pattern for Telegram tokens)
      if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
        return res.status(400).json({
          success: false,
          message: "Invalid Telegram token format. Token should be in the format: 123456789:ABCDefGhIJKlmNoPQRsTUVwxyZ"
        });
      }
      
      // Update process environment variables
      process.env.TELEGRAM_BOT_TOKEN = token;
      
      // Import and use the utility function from loadEnv.ts
      const { updateEnvFile } = await import('../utilities/loadEnv.js');
      
      // Try to update .env file
      let fileUpdated = false;
      try {
        fileUpdated = updateEnvFile({ TELEGRAM_BOT_TOKEN: token });
        if (fileUpdated) {
          log("Updated .env file with new Telegram token", "info");
        } else {
          log("Failed to update .env file", "warn");
        }
      } catch (error) {
        log(`Error updating .env file: ${error}`, "error");
      }
      
      // If the bridge is active, try to restart the Telegram bot
      let restartSuccess = false;
      if (bridge) {
        try {
          await bridge.restartTelegramBot();
          restartSuccess = true;
          log("Telegram bot restarted successfully", "info");
        } catch (error) {
          log(`Error restarting Telegram bot: ${error}`, "error");
        }
      }
      
      // Return status with diagnostic information
      return res.json({
        success: true,
        message: "Telegram bot configuration updated",
        token_length: token.length,
        env_file_updated: fileUpdated,
        bot_restarted: restartSuccess,
        next_steps: !restartSuccess ? [
          "The configuration was saved, but the bot could not be automatically restarted.",
          "You may need to manually restart the application for changes to take effect."
        ] : []
      });
    } catch (error) {
      log(`Error updating Telegram bot configuration: ${error}`, "error");
      return res.status(500).json({
        success: false,
        message: `Error updating Telegram bot configuration: ${error}`
      });
    }
  });

  // Add new route to fetch Revolt server information
  app.get("/api/revolt/server", async (req, res) => {
    try {
      if (!bridge) {
        return res.status(503).json({ 
          message: "Bot bridge not initialized",
          error: "BOT_BRIDGE_UNAVAILABLE" 
        });
      }
      
      // Check if Revolt is the active platform
      const config = await storage.getBotConfig();
      if (config?.activeProvider !== 'revolt') {
        return res.status(503).json({
          message: "Revolt is not the active platform. Switch to Revolt platform first.",
          error: "REVOLT_NOT_ACTIVE",
          activeProvider: config?.activeProvider
        });
      }
      
      const revoltBot = bridge.getRevoltBot();
      if (!revoltBot) {
        return res.status(503).json({ 
          message: "Revolt bot not initialized. The bot could not be started.",
          error: "REVOLT_BOT_UNAVAILABLE"
        });
      }

      // Check if the bot is ready
      if (!revoltBot.isReady()) {
        const disconnectReason = revoltBot.getDisconnectReason();
        return res.status(503).json({
          message: "Revolt bot is not connected.",
          error: "REVOLT_BOT_NOT_READY",
          details: disconnectReason || "No additional error details available. Check that your token is valid and properly configured."
        });
      }

      try {
        const serverInfo = await revoltBot.getServerInfo();
        res.json(serverInfo);
      } catch (error: any) {
        // Special case for no servers
        if (error.message?.includes("Bot is not in any servers")) {
          return res.status(503).json({
            message: "Bot is not connected to any Revolt servers. Please invite the bot to your server.",
            error: "NO_SERVER_CONNECTED",
            details: "The Revolt bot token is valid but the bot hasn't been invited to any servers."
          });
        }
        
        // Special case for permissions issues
        if (error.message?.includes("Missing Permissions") || error.message?.includes("Missing Access")) {
          return res.status(503).json({
            message: "The bot doesn't have enough permissions in your Revolt server.",
            error: "INSUFFICIENT_PERMISSIONS",
            details: "Make sure the bot has the necessary permissions in the server."
          });
        }
        
        throw error; // Re-throw to be caught by the outer catch
      }
    } catch (error: any) {
      log(`Error fetching Revolt server info: ${error}`, "error");
      res.status(500).json({ 
        message: "Failed to fetch Revolt server info", 
        error: "REVOLT_SERVER_ERROR",
        details: error.message || String(error)
      });
    }
  });

  // Add new route to fetch Discord categories
  app.get("/api/discord/categories", async (req, res) => {
    try {
      if (!bridge) {
        return res.status(503).json({ 
          message: "Bot bridge not initialized",
          error: "BOT_BRIDGE_UNAVAILABLE" 
        });
      }
      
      const discordBot = bridge.getDiscordBot();
      if (!discordBot) {
        return res.status(503).json({ 
          message: "Discord bot not initialized. The bot could not be started.",
          error: "DISCORD_BOT_UNAVAILABLE"
        });
      }

      // Check if the bot is ready
      if (!discordBot.isReady()) {
        const lastError = discordBot.getLastError();
        return res.status(503).json({
          message: "Discord bot is not connected.",
          error: "DISCORD_BOT_NOT_READY",
          details: lastError || "No additional error details available. Check that your token is valid and properly configured."
        });
      }

      try {
        const categories = await discordBot.getCategories();
        res.json(categories);
      } catch (error: any) {
        // Special case for no servers
        if (error.message?.includes("Bot is not in any servers")) {
          return res.status(503).json({
            message: "Bot is not connected to any Discord servers. Please invite the bot to your server.",
            error: "NO_SERVER_CONNECTED",
            details: "The Discord bot token is valid but the bot hasn't been invited to any servers. Use the Discord Developer Portal to generate an invite link."
          });
        }
        
        // Special case for permissions issues
        if (error.message?.includes("Missing Permissions") || error.message?.includes("Missing Access")) {
          return res.status(503).json({
            message: "The bot doesn't have enough permissions in your Discord server.",
            error: "INSUFFICIENT_PERMISSIONS",
            details: "Make sure the bot has the 'View Channels' and 'Manage Channels' permissions at the server level or in the specific categories you want to use."
          });
        }

        // Special case for rate limits
        if (error.message?.includes("rate limit")) {
          return res.status(429).json({
            message: "Discord API rate limit reached. Please try again later.",
            error: "RATE_LIMITED",
            details: error.message
          });
        }
        
        throw error; // Re-throw to be caught by the outer catch
      }
    } catch (error: any) {
      log(`Error fetching Discord categories: ${error}`, "error");
      res.status(500).json({ 
        message: "Failed to fetch Discord categories", 
        error: "DISCORD_CATEGORIES_ERROR",
        details: error.message || String(error)
      });
    }
  });

  // Add new route to fetch Discord roles
  app.get("/api/discord/roles", async (req, res) => {
    try {
      // Track retry state
      let retryCount = 0;
      const maxRetries = 3;
      const retryDelayMs = 1500; // 1.5 seconds between retries
      const forceReconnect = req.query.reconnect === 'true';
      
      // Function to attempt getting roles with retry logic
      async function attemptGetRoles() {
        if (!bridge) {
          return res.status(503).json({ 
            message: "Bot bridge not initialized",
            error: "BOT_BRIDGE_UNAVAILABLE" 
          });
        }
        
        const discordBot = bridge.getDiscordBot();
        if (!discordBot) {
          return res.status(503).json({ 
            message: "Discord bot not initialized. The bot could not be started.",
            error: "DISCORD_BOT_UNAVAILABLE"
          });
        }

        // Check if we need to force reconnect
        if (forceReconnect && retryCount === 0) {
          console.log("Forcing Discord bot reconnection due to client request");
          try {
            await discordBot.reconnect();
            // Give it a moment to connect
            await new Promise(resolve => setTimeout(resolve, 2000));
          } catch (reconnectError) {
            console.error("Error during forced reconnection:", reconnectError);
          }
        }

        // If bot is not ready, wait for it with timeout
        if (!discordBot.isReady()) {
          console.log(`Discord bot not ready (attempt ${retryCount + 1}/${maxRetries})`);
          
          // Special handling for the case where user might not have set token
          if (!process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_BOT_TOKEN.length < 10) {
            return res.status(503).json({
              message: "Discord bot token is missing or invalid.",
              error: "INVALID_BOT_TOKEN",
              details: "Please set a valid Discord bot token in your environment variables."
            });
          }
          
          // For other cases, attempt to reconnect if not already starting
          if (!discordBot.isStartingProcess() && retryCount === 0) {
            console.log("Attempting to restart Discord bot connection...");
            try {
              // Start an async reconnect attempt 
              discordBot.reconnect().catch(e => console.error("Reconnect error:", e));
            } catch (err) {
              console.error("Error starting Discord reconnect:", err);
            }
          }
          
          // If we have more retries available
          if (retryCount < maxRetries) {
            retryCount++;
            console.log(`Waiting ${retryDelayMs}ms before retry ${retryCount}/${maxRetries}`);
            
            // Wait for specified delay before retry
            await new Promise(resolve => setTimeout(resolve, retryDelayMs));
            return attemptGetRoles(); // Recursively retry
          }
          
          // We've exhausted retries, return error with connection details
          const lastError = discordBot.getLastError();
          const statusInfo = {
            isReady: discordBot.isReady(),
            isConnecting: discordBot.isStartingProcess(),
            lastError: lastError || "Unknown",
            retryAttempts: retryCount
          };
          
          return res.status(503).json({
            message: "Discord bot is not connected after multiple attempts.",
            error: "DISCORD_BOT_NOT_READY",
            details: lastError || "No additional error details available. Check that your token is valid and properly configured.",
            status: statusInfo,
            help: "Try refreshing the page. If the problem persists, verify your Discord bot token and server permissions."
          });
        }

        try {
          // Bot is ready, try to get roles
          console.log("Fetching Discord roles...");
          const roles = await discordBot.getRoles();
          console.log(`Successfully fetched ${roles.length} Discord roles`);
          return res.json(roles);
        } catch (error: any) {
          // Special case for no servers
          if (error.message?.includes("No guild found") || error.message?.includes("Bot is not in any servers")) {
            return res.status(503).json({
              message: "Bot is not connected to any Discord servers. Please invite the bot to your server.",
              error: "NO_SERVER_CONNECTED",
              details: "The Discord bot token is valid but the bot hasn't been invited to any servers. Use the Discord Developer Portal to generate an invite link."
            });
          }
          
          // Special case for permissions issues
          if (error.message?.includes("Missing Permissions") || error.message?.includes("Missing Access")) {
            return res.status(503).json({
              message: "The bot doesn't have enough permissions in your Discord server.",
              error: "INSUFFICIENT_PERMISSIONS",
              details: "Make sure the bot has the 'View Channels' and 'Manage Roles' permissions at the server level."
            });
          }
          
          // For rate limit errors, retry after a delay
          if (error.message?.includes("rate limit") && retryCount < maxRetries) {
            retryCount++;
            console.log(`Rate limited, waiting ${retryDelayMs * 2}ms before retry ${retryCount}/${maxRetries}`);
            
            // Wait for specified delay before retry (longer for rate limits)
            await new Promise(resolve => setTimeout(resolve, retryDelayMs * 2));
            return attemptGetRoles(); // Recursively retry
          }
          
          // Special case for rate limits that we can't retry
          if (error.message?.includes("rate limit")) {
            return res.status(429).json({
              message: "Discord API rate limit reached. Please try again in a few moments.",
              error: "RATE_LIMITED",
              details: error.message
            });
          }
          
          throw error; // Re-throw to be caught by the outer catch
        }
      }
      
      // Start the process with retry logic
      return await attemptGetRoles();
    } catch (error: any) {
      log(`Error fetching Discord roles: ${error}`, "error");
      res.status(500).json({ 
        message: "Failed to fetch Discord roles", 
        error: "DISCORD_ROLES_ERROR",
        details: error.message || String(error)
      });
    }
  });

  // Add new route to fetch Discord text channels
  app.get("/api/discord/text-channels", async (req, res) => {
    try {
      // Track retry state
      let retryCount = 0;
      const maxRetries = 3;
      const retryDelayMs = 1500; // 1.5 seconds between retries
      const forceReconnect = req.query.reconnect === 'true';
      
      // Function to attempt getting channels with retry logic
      async function attemptGetChannels() {
        if (!bridge) {
          return res.status(503).json({ 
            message: "Bot bridge not initialized",
            error: "BOT_BRIDGE_UNAVAILABLE" 
          });
        }
        
        const discordBot = bridge.getDiscordBot();
        if (!discordBot) {
          return res.status(503).json({ 
            message: "Discord bot not initialized. The bot could not be started.",
            error: "DISCORD_BOT_UNAVAILABLE"
          });
        }

        // Check if we need to force reconnect
        if (forceReconnect && retryCount === 0) {
          console.log("Forcing Discord bot reconnection due to client request");
          try {
            await discordBot.reconnect();
            // Give it a moment to connect
            await new Promise(resolve => setTimeout(resolve, 2000));
          } catch (reconnectError) {
            console.error("Error during forced reconnection:", reconnectError);
          }
        }

        // If bot is not ready, wait for it with timeout
        if (!discordBot.isReady()) {
          console.log(`Discord bot not ready (attempt ${retryCount + 1}/${maxRetries})`);
          
          // Special handling for the case where user might not have set token
          if (!process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_BOT_TOKEN.length < 10) {
            return res.status(503).json({
              message: "Discord bot token is missing or invalid.",
              error: "INVALID_BOT_TOKEN",
              details: "Please set a valid Discord bot token in your environment variables."
            });
          }
          
          // For other cases, attempt to reconnect if not already starting
          if (!discordBot.isStartingProcess() && retryCount === 0) {
            console.log("Attempting to restart Discord bot connection...");
            try {
              // Start an async reconnect attempt 
              discordBot.reconnect().catch(e => console.error("Reconnect error:", e));
            } catch (err) {
              console.error("Error starting Discord reconnect:", err);
            }
          }
          
          // If we have more retries available
          if (retryCount < maxRetries) {
            retryCount++;
            console.log(`Waiting ${retryDelayMs}ms before retry ${retryCount}/${maxRetries}`);
            
            // Wait for specified delay before retry
            await new Promise(resolve => setTimeout(resolve, retryDelayMs));
            return attemptGetChannels(); // Recursively retry
          }
          
          // We've exhausted retries, return error with connection details
          const lastError = discordBot.getLastError();
          const statusInfo = {
            isReady: discordBot.isReady(),
            isConnecting: discordBot.isStartingProcess(),
            lastError: lastError || "Unknown",
            retryAttempts: retryCount
          };
          
          return res.status(503).json({
            message: "Discord bot is not connected after multiple attempts.",
            error: "DISCORD_BOT_NOT_READY",
            details: lastError || "No additional error details available. Check that your token is valid and properly configured.",
            status: statusInfo,
            help: "Try refreshing the page. If the problem persists, verify your Discord bot token and server permissions."
          });
        }

        try {
          // Bot is ready, try to get channels
          console.log("Fetching Discord text channels...");
          const channels = await discordBot.getTextChannels();
          console.log(`Successfully fetched ${channels.length} Discord text channels`);
          return res.json(channels);
        } catch (error: any) {
          // Special case for no servers
          if (error.message?.includes("No guild found") || error.message?.includes("Bot is not in any servers")) {
            return res.status(503).json({
              message: "Bot is not connected to any Discord servers. Please invite the bot to your server.",
              error: "NO_SERVER_CONNECTED",
              details: "The Discord bot token is valid but the bot hasn't been invited to any servers. Use the Discord Developer Portal to generate an invite link."
            });
          }
          
          // Special case for permissions issues
          if (error.message?.includes("Missing Permissions") || error.message?.includes("Missing Access")) {
            return res.status(503).json({
              message: "The bot doesn't have enough permissions in your Discord server.",
              error: "INSUFFICIENT_PERMISSIONS",
              details: "Make sure the bot has the 'View Channels' permission at the server level."
            });
          }
          
          // For rate limit errors, retry after a delay
          if (error.message?.includes("rate limit") && retryCount < maxRetries) {
            retryCount++;
            console.log(`Rate limited, waiting ${retryDelayMs * 2}ms before retry ${retryCount}/${maxRetries}`);
            
            // Wait for specified delay before retry (longer for rate limits)
            await new Promise(resolve => setTimeout(resolve, retryDelayMs * 2));
            return attemptGetChannels(); // Recursively retry
          }
          
          // Special case for rate limits that we can't retry
          if (error.message?.includes("rate limit")) {
            return res.status(429).json({
              message: "Discord API rate limit reached. Please try again in a few moments.",
              error: "RATE_LIMITED",
              details: error.message
            });
          }
          
          throw error; // Re-throw to be caught by the outer catch
        }
      }
      
      // Start the process with retry logic
      return await attemptGetChannels();
      
    } catch (error: any) {
      log(`Error fetching Discord text channels: ${error}`, "error");
      res.status(500).json({ 
        message: "Failed to fetch Discord text channels", 
        error: "DISCORD_CHANNELS_ERROR",
        details: error.message || String(error)
      });
    }
  });

  // Category Routes
  app.get("/api/categories", async (req, res) => {
    const categories = await storage.getCategories();
    res.json(categories);
  });

  app.get("/api/categories/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ message: "Invalid category ID" });
    }
    const category = await storage.getCategory(id);
    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }
    res.json(category);
  });

  app.post("/api/categories", async (req, res) => {
    console.log("Creating category/submenu with data:", req.body);

    const schema = z.object({
      name: z.string(),
      isSubmenu: z.boolean(),
      discordRoleId: z.string().optional().default(""),
      discordCategoryId: z.string().optional().default(""),
      questions: z.array(z.string()).optional().default([]),
      serviceSummary: z.string().optional(),
      serviceImageUrl: z.string().nullable().optional(),
      parentId: z.number().nullable().optional(),
    });

    const result = schema.safeParse(req.body);
    if (!result.success) {
      console.log("Validation failed:", result.error);
      return res.status(400).json({ message: "Invalid request body", errors: result.error.errors });
    }

    try {
      const category = await storage.createCategory(result.data);
      console.log("Category created:", category);
      
      // If both category ID and role ID are set, automatically set up permissions
      if (category.discordCategoryId && category.discordRoleId) {
        try {
          if (!bridge) {
            log("Bridge not initialized, cannot set up permissions", "warn");
          } else {
            const discordBot = bridge.getDiscordBot();
            if (!discordBot) {
              log("Discord bot not initialized, cannot set up permissions", "warn");
            } else {
              // Attempt to set up permissions for regular category
              const success = await discordBot.setupCategoryPermissions(
                category.discordCategoryId,
                category.discordRoleId,
                false // Regular category, not transcript
              );
              
              if (success) {
                log(`Successfully set up permissions for category ${category.name}`, "info");
              } else {
                log(`Failed to set up permissions for category ${category.name}`, "warn");
              }
            }
          }
        } catch (error: any) {
          log(`Error setting up category permissions: ${error}`, "error");
          // We don't fail the request if permissions setup fails
        }
      }
      
      res.json(category);
    } catch (error: any) {
      console.error("Error creating category:", error);
      res.status(500).json({ message: "Failed to create category" });
    }
  });

  app.patch("/api/categories/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ message: "Invalid category ID" });
    }

    const schema = z.object({
      name: z.string().optional(),
      discordRoleId: z.string().optional(),
      discordCategoryId: z.string().optional(),
      questions: z.array(z.string()).optional().default([]),
      serviceSummary: z.string().optional(),
      serviceImageUrl: z.string().nullable().optional(),
      displayOrder: z.number().optional(),
      newRow: z.boolean().optional(),
      parentId: z.number().nullable().optional(),
      isSubmenu: z.boolean().optional(),
      isClosed: z.boolean().optional(), // Ensure isClosed is in the schema
      transcriptCategoryId: z.string().nullable().optional()
    });

    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ message: "Invalid request body", errors: result.error.errors });
    }

    console.log(`Updating category ${id} with data:`, JSON.stringify(result.data, null, 2));

    const category = await storage.updateCategory(id, result.data);
    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    console.log(`Updated category ${id}:`, JSON.stringify(category, null, 2));
    
    // If both category ID and role ID are present, automatically set up permissions
    if (category.discordCategoryId && category.discordRoleId && 
        (result.data.discordCategoryId || result.data.discordRoleId)) {
      
      try {
        if (!bridge) {
          log("Bridge not initialized, cannot set up permissions", "warn");
        } else {
          const discordBot = bridge.getDiscordBot();
          if (!discordBot) {
            log("Discord bot not initialized, cannot set up permissions", "warn");
          } else {
            // Check if this is a transcript category
            const isTranscriptCategory = category.transcriptCategoryId === category.discordCategoryId;
            log(`Setting up permissions for category ${category.name} (transcript: ${isTranscriptCategory})`, "info");
            
            // Attempt to set up permissions for the updated category
            const success = await discordBot.setupCategoryPermissions(
              category.discordCategoryId,
              category.discordRoleId,
              isTranscriptCategory // Pass the transcript status
            );
            
            if (success) {
              log(`Successfully set up permissions for category ${category.name}`, "info");
            } else {
              log(`Failed to set up permissions for category ${category.name}`, "warn");
            }
          }
        }
      } catch (error: any) {
        log(`Error setting up category permissions: ${error}`, "error");
        // We don't fail the request if permissions setup fails
      }
    }
    
    res.json(category);
  });

  app.delete("/api/categories/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ message: "Invalid category ID" });
    }

    try {
      await storage.deleteCategory(id);
      res.json({ message: "Category deleted successfully" });
    } catch (error: any) {
      res.status(500).json({ message: "Failed to delete category" });
    }
  });

  // Ticket Routes
  // EMERGENCY ENDPOINT FOR CLOSING TICKETS DIRECTLY
  // This bypasses the bot entirely and works directly with the database
  app.post("/api/tickets/close-by-telegram-id/:telegramId", async (req, res) => {
    try {
      const telegramId = req.params.telegramId;
      if (!telegramId) {
        return res.status(400).json({ success: false, message: "Telegram ID is required" });
      }
      
      console.log(`[EMERGENCY CLOSE API] Attempting to close ticket for Telegram ID ${telegramId}`);
      log(`[EMERGENCY CLOSE API] Attempting to close ticket for Telegram ID ${telegramId}`, "info");
      
      // Step 1: Find the user by Telegram ID
      console.log(`Looking up user with Telegram ID ${telegramId}...`);
      const userResult = await pool.query(
        `SELECT * FROM users WHERE telegram_id = $1`,
        [telegramId.toString()]
      );
      
      if (userResult.rows.length === 0) {
        const errorMsg = `No user found with Telegram ID ${telegramId}`;
        console.error(`[EMERGENCY CLOSE API] ${errorMsg}`);
        return res.status(404).json({ success: false, message: errorMsg });
      }
      
      const user = userResult.rows[0];
      console.log(`[EMERGENCY CLOSE API] Found user: ID ${user.id}, Telegram ID ${user.telegram_id}`);
      
      // Step 2: Find active tickets for this user
      console.log(`[EMERGENCY CLOSE API] Looking for active tickets for user ${user.id}...`);
      const ticketsResult = await pool.query(
        `SELECT * FROM tickets 
         WHERE user_id = $1 
         AND status NOT IN ('closed', 'completed', 'transcript', 'deleted')
         ORDER BY id DESC`,
        [user.id]
      );
      
      if (ticketsResult.rows.length === 0) {
        const errorMsg = `No active tickets found for user ${user.id}`;
        console.error(`[EMERGENCY CLOSE API] ${errorMsg}`);
        return res.status(404).json({ success: false, message: errorMsg });
      }
      
      const ticket = ticketsResult.rows[0];
      console.log(`[EMERGENCY CLOSE API] Found active ticket: ID ${ticket.id}, Status ${ticket.status}`);
      
      // Step 3: Close the ticket
      console.log(`[EMERGENCY CLOSE API] Closing ticket ${ticket.id}...`);
      await pool.query(
        `UPDATE tickets SET status = 'closed' WHERE id = $1`,
        [ticket.id]
      );
      
      // Step 4: Try to move to transcripts if Discord is available
      let discordResult = "Discord channel handling skipped";
      if (ticket.discord_channel_id && bridge) {
        try {
          console.log(`[EMERGENCY CLOSE API] Ticket has Discord channel. Attempting to move to transcripts...`);
          const ticketId = parseInt(ticket.id.toString(), 10);
          await bridge.moveToTranscripts(ticketId);
          discordResult = "Discord channel moved to transcripts successfully";
          console.log(`[EMERGENCY CLOSE API] ${discordResult}`);
        } catch (error) {
          discordResult = `Error moving Discord channel: ${error instanceof Error ? error.message : String(error)}`;
          console.error(`[EMERGENCY CLOSE API] ${discordResult}`);
        }
      }
      
      console.log(`[EMERGENCY CLOSE API] Ticket ${ticket.id} closed successfully`);
      log(`[EMERGENCY CLOSE API] Ticket ${ticket.id} closed successfully`, "info");
      
      // Return success response with details
      return res.json({
        success: true,
        message: "Ticket closed successfully",
        ticket: {
          id: ticket.id,
          status: "closed",
          previousStatus: ticket.status
        },
        user: {
          id: user.id,
          telegramId: user.telegram_id
        },
        discordResult
      });
    } catch (error) {
      console.error("[EMERGENCY CLOSE API] Error:", error);
      log(`[EMERGENCY CLOSE API] Error: ${error instanceof Error ? error.message : String(error)}`, "error");
      return res.status(500).json({ 
        success: false, 
        message: "Failed to close ticket", 
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get("/api/tickets", async (req, res) => {
    try {
      // Get tickets from all categories if no specific category is provided
      const categoryId = req.query.categoryId ? parseInt(req.query.categoryId as string) : null;

      if (categoryId) {
        const tickets = await storage.getTicketsByCategory(categoryId);
        res.json(tickets);
      } else {
        // Get all categories and their tickets
        const categories = await storage.getCategories();
        const allTickets = [];

        for (const category of categories) {
          const tickets = await storage.getTicketsByCategory(category.id);
          allTickets.push(...tickets);
        }

        res.json(allTickets);
      }
    } catch (error: any) {
      log(`Error fetching tickets: ${error}`, "error");
      res.status(500).json({ message: "Failed to fetch tickets" });
    }
  });

  app.get("/api/tickets/:id/messages", async (req, res) => {
    const ticketId = parseInt(req.params.id);
    if (isNaN(ticketId)) {
      return res.status(400).json({ message: "Invalid ticket ID" });
    }

    const messages = await storage.getTicketMessages(ticketId);
    res.json(messages);
  });

  // Users/Customers route
  app.get("/api/users", async (req, res) => {
    try {
      // Get all users through the storage interface
      const users = await Promise.all(
        Array.from({ length: 100 }).map((_, i) => storage.getUser(i + 1))
      );

      // Get all categories
      const categories = await storage.getCategories();

      // Get stats for each user
      const usersWithStats = await Promise.all(
        users
          .filter(user => user !== undefined)
          .map(async user => {
            // Initialize ticket counters
            let totalTickets = 0;
            let openTickets = 0;
            let closedTickets = 0;
            let paidTickets = 0;
            let deletedTickets = 0;
            
            // Track tickets by category
            const ticketsByCategory: Record<number, { 
              categoryId: number;
              categoryName: string;
              count: number;
            }> = {};
            
            // Initialize categories
            for (const category of categories) {
              ticketsByCategory[category.id] = {
                categoryId: category.id,
                categoryName: category.name,
                count: 0
              };
            }

            // Get all tickets for this user
            const userTickets = await storage.getTicketsByUserId(user!.id);
            
            // Process ticket data
            if (userTickets && userTickets.length > 0) {
              totalTickets = userTickets.length;
              
              // Count by status
              for (const ticket of userTickets) {
                if (ticket.status === "open") openTickets++;
                else if (ticket.status === "closed") closedTickets++;
                else if (ticket.status === "paid") paidTickets++;
                else if (ticket.status === "deleted") deletedTickets++;
                
                // Count by category
                if (ticket.categoryId && ticketsByCategory[ticket.categoryId]) {
                  ticketsByCategory[ticket.categoryId].count++;
                }
              }
            }
            
            // Convert ticketsByCategory to array and filter out categories with no tickets
            const categorySummary = Object.values(ticketsByCategory)
              .filter(c => c.count > 0)
              .sort((a, b) => b.count - a.count); // Sort by count, descending
            
            // Get the user's display name (for Telegram users)
            const displayName = user!.telegramName || user!.telegramUsername || user!.username;
            
            return {
              ...user,
              displayName,
              ticketStats: {
                total: totalTickets,
                open: openTickets,
                closed: closedTickets,
                paid: paidTickets,
                deleted: deletedTickets
              },
              categorySummary
            };
          })
      );

      res.json(usersWithStats);
    } catch (error: any) {
      log(`Error fetching users: ${error}`, "error");
      res.status(500).json({ message: "Failed to fetch users" });
    }
  });

  // Closed tickets with messages route
  app.get("/api/tickets/closed", async (req, res) => {
    try {
      // Get all categories to filter tickets
      const categories = await storage.getCategories();

      // Collect all closed tickets from all categories
      const allClosedTickets = [];
      for (const category of categories) {
        const categoryTickets = await storage.getTicketsByCategory(category.id);
        const closedTickets = categoryTickets.filter(t =>
          t.status === "closed" || t.status === "deleted" || t.status === "transcript"
        );

        // Get messages for each ticket
        for (const ticket of closedTickets) {
          const messages = await storage.getTicketMessages(ticket.id);
          allClosedTickets.push({
            ...ticket,
            messages
          });
        }
      }

      res.json(allClosedTickets);
    } catch (error: any) {
      log(`Error fetching closed tickets: ${error}`, "error");
      res.status(500).json({ message: "Failed to fetch closed tickets" });
    }
  });

  // Update the stats routes to handle custom date ranges
  app.get("/api/users/:discordId/stats", async (req, res) => {
    const discordId = req.params.discordId;
    const period = req.query.period as 'week' | 'month' | 'all';
    const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
    const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;

    try {
      let stats;
      if (startDate && endDate) {
        // Get full date information for debugging
        const startInfo = `${startDate.getFullYear()}-${startDate.getMonth()+1}-${startDate.getDate()}`;
        const endInfo = `${endDate.getFullYear()}-${endDate.getMonth()+1}-${endDate.getDate()}`;
        
        // For debugging with full date details
        console.log(`Using custom date range: ${startDate.toISOString()} (${startInfo}) to ${endDate.toISOString()} (${endInfo})`);
        
        // Make sure our client side date filtering is using the current year
        if (startDate.getFullYear() !== 2025 || endDate.getFullYear() !== 2025) {
          console.log("⚠️ WARNING: Date filters are not using the current year 2025! Fixing this...");
          // Force the dates to use 2025 to match our system date
          startDate.setFullYear(2025);
          endDate.setFullYear(2025);
          console.log(`Corrected date range: ${startDate.toISOString()} to ${endDate.toISOString()}`);
        }
        
        stats = await storage.getUserStatsByDateRange(discordId, startDate, endDate);
      } else {
        // For predefined period queries
        stats = await storage.getUserStatsByPeriod(discordId, period || 'all');
      }
      
      // Log the date range we're using for debugging
      console.log(`Using stats date range: ${stats.periodStart?.toISOString()} to ${stats.periodEnd?.toISOString()}`);
      // DO NOT "fix" or modify any dates - use them exactly as they are
      
      res.json(stats);
    } catch (error: any) {
      console.error("Error fetching user stats:", error);
      res.status(500).json({ message: "Failed to fetch user stats" });
    }
  });

  app.get("/api/workers/stats", async (req, res) => {
    const period = req.query.period as 'week' | 'month' | 'all';
    const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
    const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;

    try {
      let stats;
      if (startDate && endDate) {
        // Get full date information for debugging
        const startInfo = `${startDate.getFullYear()}-${startDate.getMonth()+1}-${startDate.getDate()}`;
        const endInfo = `${endDate.getFullYear()}-${endDate.getMonth()+1}-${endDate.getDate()}`;
        
        // For debugging with full date details
        console.log(`Using workers custom date range: ${startDate.toISOString()} (${startInfo}) to ${endDate.toISOString()} (${endInfo})`);
        
        // Make sure our client side date filtering is using the current year
        if (startDate.getFullYear() !== 2025 || endDate.getFullYear() !== 2025) {
          console.log("⚠️ WARNING: Date filters are not using the current year 2025! Fixing this...");
          // Force the dates to use 2025 to match our system date
          startDate.setFullYear(2025);
          endDate.setFullYear(2025);
          console.log(`Corrected workers date range: ${startDate.toISOString()} to ${endDate.toISOString()}`);
        }
        
        stats = await storage.getAllWorkerStatsByDateRange(startDate, endDate);
      } else {
        stats = await storage.getAllWorkerStatsByPeriod(period || 'all');
      }
      
      // Log the date ranges we're using for debugging
      if (Array.isArray(stats) && stats.length > 0) {
        console.log(`Using workers stats date range: ${stats[0].periodStart?.toISOString()} to ${stats[0].periodEnd?.toISOString()}`);
      }
      // DO NOT "fix" or modify any dates - use them exactly as they are
      
      res.json(stats);
    } catch (error: any) {
      console.error("Error fetching worker stats:", error);
      res.status(500).json({ message: "Failed to fetch worker stats" });
    }
  });

  log("Routes registered successfully");
  // Banned Users Routes
  app.get("/api/banned-users", async (req, res) => {
    try {
      const bannedUsers = await storage.getBannedUsers();
      res.json(bannedUsers);
    } catch (error: any) {
      log(`Error fetching banned users: ${error}`, "error");
      res.status(500).json({ message: "Failed to fetch banned users" });
    }
  });

  app.post("/api/ban-user", async (req, res) => {
    try {
      const schema = z.object({
        userId: z.number(),
        banReason: z.string().optional(),
        bannedBy: z.string().optional()
      });

      const result = schema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ message: "Invalid request body", errors: result.error.errors });
      }

      await storage.banUser(
        result.data.userId, 
        result.data.banReason || "No reason provided", 
        result.data.bannedBy || "System"
      );
      
      res.json({ message: "User banned successfully" });
    } catch (error: any) {
      log(`Error banning user: ${error}`, "error");
      res.status(500).json({ message: "Failed to ban user" });
    }
  });

  app.post("/api/unban-user", async (req, res) => {
    try {
      const schema = z.object({
        userId: z.number()
      });

      const result = schema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ message: "Invalid request body", errors: result.error.errors });
      }

      await storage.unbanUser(result.data.userId);
      
      res.json({ message: "User unbanned successfully" });
    } catch (error: any) {
      log(`Error unbanning user: ${error}`, "error");
      res.status(500).json({ message: "Failed to unban user" });
    }
  });

  // Transcript Management Routes
  app.get("/api/transcripts", async (req, res) => {
    try {
      // Get all transcript tickets (status = closed)
      const transcripts = await storage.getTranscriptTickets();
      
      // Get messages for each transcript and build response
      const transcriptsWithMessages = await Promise.all(
        transcripts.map(async (transcript) => {
          const messages = await storage.getTicketMessages(transcript.id);
          return {
            ...transcript,
            messageCount: messages.length,
            lastMessage: messages.length > 0 ? messages[messages.length - 1] : null
          };
        })
      );
      
      res.json(transcriptsWithMessages);
    } catch (error: any) {
      log(`Error fetching transcripts: ${error}`, "error");
      res.status(500).json({ 
        message: "Failed to fetch transcripts", 
        error: error.message 
      });
    }
  });

  app.delete("/api/transcripts/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ message: "Invalid transcript ID" });
      }

      // First verify that this is indeed a transcript (closed ticket)
      const ticket = await storage.getTicket(id);
      if (!ticket) {
        return res.status(404).json({ message: "Transcript not found" });
      }

      // Allow deleting tickets with status "closed", "transcript", or "deleted"
      if (ticket.status !== "closed" && ticket.status !== "transcript" && ticket.status !== "deleted") {
        return res.status(400).json({ 
          message: "Cannot delete an active ticket. Only transcripts (closed, transcript, or deleted status) can be deleted." 
        });
      }

      // Delete the transcript and its messages
      await storage.deleteTicket(id);
      
      // We don't delete the Discord channel from here - it's managed by the bridge
      // Just log that the transcript was deleted
      log(`Transcript ${id} deleted from database`, "info");
      
      res.json({ 
        message: "Transcript deleted successfully", 
        ticketId: id 
      });
    } catch (error: any) {
      log(`Error deleting transcript: ${error}`, "error");
      res.status(500).json({ 
        message: "Failed to delete transcript", 
        error: error.message 
      });
    }
  });

  // EMERGENCY API: Close ticket by Telegram ID
  // This endpoint is a last resort to close tickets when the Telegram bot command fails
  app.post("/api/emergency/close-ticket-by-telegram", async (req, res) => {
    try {
      // Require telegramId in the request body
      const { telegramId } = req.body;
      
      if (!telegramId) {
        return res.status(400).json({ message: "telegramId is required" });
      }
      
      log(`EMERGENCY CLOSE API: Attempting to close ticket for Telegram ID ${telegramId}`, "info");
      
      // Get user by Telegram ID
      const user = await storage.getUserByTelegramId(telegramId);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      
      // Get active tickets for this user
      const userTickets = await storage.getTicketsByUserId(user.id);
      const activeTickets = userTickets.filter(t => 
        !['closed', 'completed', 'transcript'].includes(t.status)
      );
      
      if (activeTickets.length === 0) {
        return res.status(404).json({ message: "No active tickets found" });
      }
      
      // Close the most recent active ticket
      activeTickets.sort((a, b) => b.id - a.id);
      const ticket = activeTickets[0];
      
      log(`EMERGENCY CLOSE API: Closing ticket #${ticket.id} with status "${ticket.status}"`, "info");
      
      // Update ticket status
      await storage.updateTicketStatus(ticket.id, "closed");
      
      // If there's a Discord channel, try to move it to transcripts
      if (ticket.discordChannelId && bridge) {
        try {
          await bridge.moveToTranscripts(ticket.id);
          log(`EMERGENCY CLOSE API: Moved ticket #${ticket.id} to transcripts`, "info");
        } catch (error) {
          log(`EMERGENCY CLOSE API: Error moving ticket to transcripts: ${error}`, "error");
        }
      }
      
      return res.json({ 
        success: true, 
        message: "Ticket closed successfully",
        ticket: {
          id: ticket.id,
          status: "closed",
          previousStatus: ticket.status
        }
      });
    } catch (error) {
      log(`Error in emergency close API: ${error}`, "error");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // Test route for system messages in Discord channels
  app.post("/api/discord/send-system-message", async (req, res) => {
    try {
      const { message, channelId } = req.body;
      
      if (!bridge) {
        return res.status(500).json({ success: false, error: "Bridge not initialized" });
      }
      
      if (!channelId || !message) {
        return res.status(400).json({ 
          success: false, 
          error: "Both channelId and message are required"
        });
      }
      
      // First verify the channel exists
      const discordBot = bridge.getDiscordBot();
      const channel = await discordBot.getChannelById(channelId);
      
      if (!channel) {
        return res.status(404).json({
          success: false,
          error: `Discord channel not found: ${channelId}`
        });
      }
      
      await bridge.sendSystemMessageToDiscord(channelId, message);
      
      return res.status(200).json({ 
        success: true, 
        message: `System message sent to channel ${channelId}` 
      });
    } catch (error) {
      log(`Error sending system message to Discord: ${error}`, "error");
      res.status(500).json({ 
        success: false, 
        error: String(error) 
      });
    }
  });
  
  // Test route for marking tickets as paid (for testing the date fix)
  app.post("/api/test/mark-ticket-paid", async (req, res) => {
    try {
      const { ticketId, amount, claimedBy } = req.body;
      
      if (!ticketId || !amount || !claimedBy) {
        return res.status(400).json({ 
          success: false, 
          error: "ticketId, amount, and claimedBy are all required" 
        });
      }
      
      // Check if the ticket exists
      const ticket = await storage.getTicket(ticketId);
      if (!ticket) {
        return res.status(404).json({
          success: false,
          error: `Ticket not found: ${ticketId}`
        });
      }
      
      // Use our fixed function to mark the ticket as paid
      await storage.updateTicketPayment(ticketId, amount, claimedBy);
      
      // Get the updated ticket to verify the date was set correctly
      const updatedTicket = await storage.getTicket(ticketId);
      
      return res.status(200).json({ 
        success: true, 
        message: `Ticket ${ticketId} marked as paid`,
        ticket: updatedTicket
      });
    } catch (error) {
      log(`Error in test mark-ticket-paid route: ${error}`, "error");
      res.status(500).json({ 
        success: false, 
        error: String(error) 
      });
    }
  });

  return httpServer;
}