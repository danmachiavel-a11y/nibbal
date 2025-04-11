import type { Express } from "express";
import { createServer } from "http";
import { storage } from "./storage";
import { BridgeManager } from "./bot/bridge";
import { z } from "zod";
import { log } from "./vite";
import { pool } from "./db";

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
  
  // Initialize bridge after routes are registered
  process.nextTick(async () => {
    log("Initializing bot bridge...");
    bridge = new BridgeManager();
    try {
      await bridge.start();
      log("Bot bridge initialized successfully");
    } catch (error: any) {
      log(`Error initializing bots: ${error.message}`, "error");
    }
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
        return res.json({ connected: false });
      }
      const telegramBot = bridge.getTelegramBot();
      res.json({
        connected: telegramBot?.getIsConnected() || false,
      });
    } catch (error: any) {
      log(`Error checking Telegram bot status: ${error}`, "error");
      res.status(500).json({ message: "Failed to check Telegram bot status" });
    }
  });

  app.get("/api/bot/discord/status", async (req, res) => {
    try {
      if (!bridge) {
        return res.json({ 
          connected: false,
          error: "Bot bridge not initialized",
          environment: {
            token_set: Boolean(process.env.DISCORD_BOT_TOKEN),
            using_env_file: fs.existsSync(path.resolve(process.cwd(), '.env'))
          }
        });
      }
      
      const discordBot = bridge.getDiscordBot();
      const connected = !!discordBot?.isReady();
      
      // Include more detailed information if Discord is not connected
      let errorDetails = null;
      if (!connected && discordBot) {
        errorDetails = discordBot.getLastError();
      }
      
      res.json({
        connected,
        error: errorDetails,
        environment: {
          token_set: Boolean(process.env.DISCORD_BOT_TOKEN),
          using_env_file: fs.existsSync(path.resolve(process.cwd(), '.env'))
        }
      });
    } catch (error: any) {
      log(`Error checking Discord bot status: ${error}`, "error");
      res.status(500).json({ message: "Failed to check Discord bot status" });
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
      
      // Update process environment variables
      process.env.DISCORD_BOT_TOKEN = token;
      
      // Try to update .env file
      let fileUpdated = false;
      try {
        const envPath = path.resolve(process.cwd(), '.env');
        let envContent = '';
        
        // Read existing .env if it exists
        if (fs.existsSync(envPath)) {
          const existingContent = fs.readFileSync(envPath, 'utf8');
          const envLines = existingContent.split('\n');
          let tokenLineExists = false;
          
          // Process each line
          for (let i = 0; i < envLines.length; i++) {
            const line = envLines[i];
            if (line.trim() === '' || line.startsWith('#')) {
              // Keep comments and empty lines unchanged
              envContent += line + '\n';
            } else {
              // Check if this is a variable we're updating
              const match = line.match(/^([^=]+)=/);
              if (match) {
                const key = match[1].trim();
                if (key === 'DISCORD_BOT_TOKEN') {
                  envContent += `${key}=${token}\n`;
                  tokenLineExists = true;
                } else {
                  // Keep the line unchanged
                  envContent += line + '\n';
                }
              } else {
                // Keep the line unchanged
                envContent += line + '\n';
              }
            }
          }
          
          // Add token line if it doesn't exist
          if (!tokenLineExists) {
            envContent += `DISCORD_BOT_TOKEN=${token}\n`;
          }
        } else {
          // Create new .env file with the provided token
          envContent = `DISCORD_BOT_TOKEN=${token}\n`;
        }
        
        // Write the updated .env file
        fs.writeFileSync(envPath, envContent);
        fileUpdated = true;
        log("Updated .env file with new Discord token", "info");
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
      
      return res.json({
        success: true,
        message: "Discord bot configuration updated",
        env_file_updated: fileUpdated,
        bot_restarted: restartSuccess
      });
    } catch (error) {
      log(`Error updating Discord bot configuration: ${error}`, "error");
      return res.status(500).json({
        success: false,
        message: "Failed to update Discord bot configuration",
        error: String(error)
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
        const roles = await discordBot.getRoles();
        res.json(roles);
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
        const channels = await discordBot.getTextChannels();
        res.json(channels);
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
          t.status === "closed" || t.status === "deleted"
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
        stats = await storage.getUserStatsByDateRange(discordId, startDate, endDate);
      } else {
        stats = await storage.getUserStatsByPeriod(discordId, period || 'all');
      }
      res.json(stats);
    } catch (error: any) {
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
        stats = await storage.getAllWorkerStatsByDateRange(startDate, endDate);
      } else {
        stats = await storage.getAllWorkerStatsByPeriod(period || 'all');
      }
      res.json(stats);
    } catch (error: any) {
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

      if (ticket.status !== "closed") {
        return res.status(400).json({ 
          message: "Cannot delete an active ticket. Only transcripts (closed tickets) can be deleted." 
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

  return httpServer;
}