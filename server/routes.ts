import type { Express } from "express";
import { createServer } from "http";
import { storage } from "./storage";
import { BridgeManager } from "./bot/bridge";
import { z } from "zod";
import { log } from "./vite";

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
        return res.json({ connected: false });
      }
      const discordBot = bridge.getDiscordBot();
      res.json({
        connected: !!discordBot?.isReady(),
      });
    } catch (error: any) {
      log(`Error checking Discord bot status: ${error}`, "error");
      res.status(500).json({ message: "Failed to check Discord bot status" });
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
          message: "Discord bot not initialized",
          error: "DISCORD_BOT_UNAVAILABLE"
        });
      }

      try {
        const categories = await discordBot.getCategories();
        res.json(categories);
      } catch (error: any) {
        if (error.message?.includes("Bot is not in any servers")) {
          return res.status(503).json({
            message: "Bot is not connected to any Discord servers. Please invite the bot to your server.",
            error: "NO_SERVER_CONNECTED",
            details: "The Discord bot token is valid but the bot hasn't been invited to any servers. Use the Discord Developer Portal to generate an invite link."
          });
        }
        throw error; // Re-throw to be caught by the outer catch
      }
    } catch (error: any) {
      log(`Error fetching Discord categories: ${error}`, "error");
      res.status(500).json({ 
        message: "Failed to fetch Discord categories", 
        error: "DISCORD_CATEGORIES_ERROR",
        details: error.message
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
          message: "Discord bot not initialized",
          error: "DISCORD_BOT_UNAVAILABLE"
        });
      }

      try {
        const roles = await discordBot.getRoles();
        res.json(roles);
      } catch (error: any) {
        if (error.message?.includes("No guild found")) {
          return res.status(503).json({
            message: "Bot is not connected to any Discord servers. Please invite the bot to your server.",
            error: "NO_SERVER_CONNECTED",
            details: "The Discord bot token is valid but the bot hasn't been invited to any servers. Use the Discord Developer Portal to generate an invite link."
          });
        }
        throw error; // Re-throw to be caught by the outer catch
      }
    } catch (error: any) {
      log(`Error fetching Discord roles: ${error}`, "error");
      res.status(500).json({ 
        message: "Failed to fetch Discord roles", 
        error: "DISCORD_ROLES_ERROR",
        details: error.message
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

  return httpServer;
}