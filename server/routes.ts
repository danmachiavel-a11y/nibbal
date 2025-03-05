import type { Express } from "express";
import { createServer } from "http";
import { storage } from "./storage";
import { BridgeManager } from "./bot/bridge";
import { z } from "zod";
import { log } from "./vite";

export async function registerRoutes(app: Express) {
  log("Setting up HTTP server...");
  const httpServer = createServer(app);

  // Initialize bot bridge asynchronously
  log("Initializing bot bridge...");
  const bridge = new BridgeManager();
  bridge.start().catch(error => {
    log(`Error initializing bots: ${error.message}`, "error");
  });

  // Add new route to fetch Discord categories
  app.get("/api/discord/categories", async (req, res) => {
    try {
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

  // Add new route to fetch Discord roles
  app.get("/api/discord/roles", async (req, res) => {
    try {
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

  // Bot Config Routes
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
      questions: z.array(z.string()).optional(),
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

  // Ticket Routes
  app.get("/api/tickets", async (req, res) => {
    const categoryId = parseInt(req.query.categoryId as string);
    if (isNaN(categoryId)) {
      return res.status(400).json({ message: "Invalid category ID" });
    }

    const tickets = await storage.getTicketsByCategory(categoryId);
    res.json(tickets);
  });

  app.get("/api/tickets/:id/messages", async (req, res) => {
    const ticketId = parseInt(req.params.id);
    if (isNaN(ticketId)) {
      return res.status(400).json({ message: "Invalid ticket ID" });
    }

    const messages = await storage.getTicketMessages(ticketId);
    res.json(messages);
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
  return httpServer;
}