import type { Express } from "express";
import { createServer } from "http";
import { storage } from "./storage";
import { BridgeManager } from "./bot/bridge";
import { z } from "zod";
import { log } from "./vite";

export async function registerRoutes(app: Express) {
  log("Setting up HTTP server...");
  const httpServer = createServer(app);

  // Create default test category if none exist
  const categories = await storage.getCategories();
  if (categories.length === 0) {
    log("Creating default test category...");
    await storage.createCategory({
      name: "Test Service",
      discordRoleId: "123456789",  // Default test role ID
      discordCategoryId: "987654321", // Default test category ID
      questions: [
        "What is your issue?",
        "When did this start?",
        "Have you tried any solutions?"
      ]
    });
    log("Default test category created");
  }

  // Initialize bot bridge asynchronously
  log("Initializing bot bridge...");
  const bridge = new BridgeManager();
  bridge.start().catch(error => {
    log(`Error initializing bots: ${error.message}`, "error");
    // Don't throw here, allow server to continue starting
  });

  // API Routes
  app.get("/api/categories", async (req, res) => {
    const categories = await storage.getCategories();
    res.json(categories);
  });

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

  app.post("/api/categories", async (req, res) => {
    const schema = z.object({
      name: z.string(),
      discordRoleId: z.string(),
      discordCategoryId: z.string(),
      questions: z.array(z.string())
    });

    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ message: "Invalid request body" });
    }

    const category = await storage.createCategory(result.data);
    res.json(category);
  });

  log("Routes registered successfully");
  return httpServer;
}