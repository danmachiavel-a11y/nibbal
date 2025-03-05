import type { Express } from "express";
import { createServer } from "http";
import { storage } from "./storage";
import { BridgeManager } from "./bot/bridge";
import { z } from "zod";
import { log } from "./vite";

let bridge: BridgeManager | null = null;

export async function registerRoutes(app: Express) {
  log("Setting up HTTP server...");

  // Create HTTP server first
  const httpServer = createServer(app);

  try {
    // Initialize bridge manager - but don't start bots yet
    log("Creating bridge manager...");
    bridge = new BridgeManager();
  } catch (error) {
    log(`Error creating bridge manager: ${error}`, "error");
    // Continue server startup even if bridge fails
  }

  // Register all routes first - keep existing route handlers
  app.get("/api/bot-config", async (req, res) => {
    const config = await storage.getBotConfig();
    res.json(config);
  });

  app.patch("/api/bot-config", async (req, res) => {
    const schema = z.object({
      welcomeMessage: z.string().optional(),
      welcomeImageUrl: z.string().nullable().optional(),
    });

    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ message: "Invalid request body" });
    }

    const config = await storage.updateBotConfig(result.data);
    res.json(config);
  });

  app.get("/api/bot/telegram/status", async (req, res) => {
    try {
      if (!bridge) {
        return res.json({ connected: false });
      }
      const telegramBot = bridge.getTelegramBot();
      res.json({
        connected: telegramBot?.getIsConnected() || false,
      });
    } catch (error) {
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
    } catch (error) {
      log(`Error checking Discord bot status: ${error}`, "error");
      res.status(500).json({ message: "Failed to check Discord bot status" });
    }
  });

  app.patch("/api/bot/config", async (req, res) => {
    try {
      const schema = z.object({
        telegramToken: z.string().optional(),
        discordToken: z.string().optional(),
      });

      const result = schema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ message: "Invalid request body" });
      }

      if (result.data.telegramToken) {
        process.env.TELEGRAM_BOT_TOKEN = result.data.telegramToken;
        log("Updated Telegram bot token");
      }
      if (result.data.discordToken) {
        process.env.DISCORD_BOT_TOKEN = result.data.discordToken;
        log("Updated Discord bot token");
      }

      if (bridge) {
        log("Restarting bots with new configuration...");
        await bridge.restart();
        log("Bots restarted successfully");
      } else {
        log("Creating new bot bridge...");
        bridge = new BridgeManager();
        await bridge.start();
        log("New bot bridge started successfully");
      }

      res.json({ message: "Bot configuration updated successfully" });
    } catch (error) {
      log(`Error updating bot configuration: ${error}`, "error");
      res.status(500).json({ message: "Failed to update bot configuration" });
    }
  });

  app.get("/api/discord/categories", async (req, res) => {
    try {
      if (!bridge) {
        return res.status(503).json({ message: "Bot bridge not initialized" });
      }
      const discordBot = bridge.getDiscordBot();
      if (!discordBot) {
        throw new Error("Discord bot not initialized");
      }

      const categories = await discordBot.getCategories();
      res.json(categories);
    } catch (error) {
      log(`Error fetching Discord categories: ${error}`, "error");
      res.status(500).json({ message: "Failed to fetch Discord categories" });
    }
  });

  app.get("/api/discord/roles", async (req, res) => {
    try {
      if (!bridge) {
        return res.status(503).json({ message: "Bot bridge not initialized" });
      }
      const discordBot = bridge.getDiscordBot();
      if (!discordBot) {
        throw new Error("Discord bot not initialized");
      }

      const roles = await discordBot.getRoles();
      res.json(roles);
    } catch (error) {
      log(`Error fetching Discord roles: ${error}`, "error");
      res.status(500).json({ message: "Failed to fetch Discord roles" });
    }
  });

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
      discordRoleId: z.string().optional(),
      discordCategoryId: z.string().optional(),
      questions: z.array(z.string()).optional(),
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
      res.json(category);
    } catch (error) {
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
    });

    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ message: "Invalid request body" });
    }

    const category = await storage.updateCategory(id, result.data);
    if (!category) {
      return res.status(404).json({ message: "Category not found" });
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
    } catch (error) {
      res.status(500).json({ message: "Failed to delete category" });
    }
  });

  app.get("/api/tickets", async (req, res) => {
    try {
      const categoryId = req.query.categoryId ? parseInt(req.query.categoryId as string) : null;

      if (categoryId) {
        const tickets = await storage.getTicketsByCategory(categoryId);
        res.json(tickets);
      } else {
        const categories = await storage.getCategories();
        const allTickets = [];

        for (const category of categories) {
          const tickets = await storage.getTicketsByCategory(category.id);
          allTickets.push(...tickets);
        }

        res.json(allTickets);
      }
    } catch (error) {
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

  app.get("/api/users", async (req, res) => {
    try {
      const users = await Promise.all(
        Array.from({ length: 100 }).map((_, i) => storage.getUser(i + 1))
      );

      const usersWithStats = await Promise.all(
        users
          .filter(user => user !== undefined)
          .map(async user => {
            let paidTicketCount = 0;

            const categories = await storage.getCategories();

            for (const category of categories) {
              const tickets = await storage.getTicketsByCategory(category.id);
              paidTicketCount += tickets.filter(t =>
                t.userId === user?.id &&
                t.status === "paid"
              ).length;
            }

            return {
              ...user,
              paidTicketCount
            };
          })
      );

      res.json(usersWithStats);
    } catch (error) {
      log(`Error fetching users: ${error}`, "error");
      res.status(500).json({ message: "Failed to fetch users" });
    }
  });

  app.get("/api/tickets/closed", async (req, res) => {
    try {
      const categories = await storage.getCategories();
      const allClosedTickets = [];
      for (const category of categories) {
        const categoryTickets = await storage.getTicketsByCategory(category.id);
        const closedTickets = categoryTickets.filter(t =>
          t.status === "closed" || t.status === "deleted"
        );

        for (const ticket of closedTickets) {
          const messages = await storage.getTicketMessages(ticket.id);
          allClosedTickets.push({
            ...ticket,
            messages
          });
        }
      }

      res.json(allClosedTickets);
    } catch (error) {
      log(`Error fetching closed tickets: ${error}`, "error");
      res.status(500).json({ message: "Failed to fetch closed tickets" });
    }
  });

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
    } catch (error) {
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
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch worker stats" });
    }
  });

  log("Routes registered successfully");

  // Return server immediately so it can start listening
  return httpServer;
}

// Start bots after server is running
export async function initializeBots() {
  try {
    log("Starting bot initialization...");
    if (!bridge) {
      log("Creating new bridge manager...");
      bridge = new BridgeManager();
    }
    await bridge.start();
    log("Bot bridge initialized successfully");
  } catch (error) {
    log(`Error initializing bots: ${error instanceof Error ? error.message : String(error)}`, "error");
    // Don't throw - let server continue running even if bots fail
  }
}