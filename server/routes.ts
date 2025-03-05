import type { Express } from "express";
import { createServer } from "http";
import { BridgeManager } from "./bot/bridge";
import { log } from "./vite";

let bridge: BridgeManager | null = null;

export async function registerRoutes(app: Express) {
  log("Setting up HTTP server...");
  const httpServer = createServer(app);

  // Add test endpoint
  app.get("/api/status", (req, res) => {
    res.json({ status: "ok" });
  });

  log("Routes registered successfully");
  return httpServer;
}