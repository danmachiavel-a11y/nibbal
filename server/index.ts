import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { storage } from "./storage";
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db } from './db';
import { loadEnv } from "../utilities/loadEnv";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  try {
    // Load environment variables from .env file if available
    loadEnv();
    
    // First, run database migrations
    log("Running database migrations...");
    await migrate(db, { migrationsFolder: './migrations' });
    log("Database migrations completed successfully");

    // Create HTTP server and register routes
    log("Setting up HTTP server...");
    const server = await registerRoutes(app);

    // Add error handler
    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
      const status = err.status || err.statusCode || 500;
      const message = err.message || "Internal Server Error";
      log(`Error handler caught: ${err.message}`, "error");
      res.status(status).json({ message });
    });

    // Setup Vite or serve static files
    if (app.get("env") === "development") {
      await setupVite(app, server);
    } else {
      serveStatic(app);
    }

    // Start the server first
    await new Promise<void>((resolve) => {
      server.listen({
        port: 5000,
        host: "0.0.0.0",
        reusePort: true,
      }, () => {
        log(`Server listening on port 5000`);
        resolve();
      });
    });

    // Only create default test category if no categories exist
    try {
      log("Checking for existing categories...");
      const existingCategories = await storage.getCategories();
      if (existingCategories.length === 0) {
        log("No categories found. Creating default test category...");
        const testCategory = {
          name: 'Test Service',
          discordRoleId: '1346324056244490363',
          discordCategoryId: '1345983179353362447',
          transcriptCategoryId: '1346383603365580820',
          questions: [
            'What is your issue?',
            'When did this start?',
            'Have you tried any solutions?'
          ],
          serviceSummary: 'Welcome to our Test Service! Our team specializes in handling test-related issues.',
          serviceImageUrl: null
        };
        await storage.createCategory(testCategory);
        log("Default test category created successfully");
      } else {
        log(`Found ${existingCategories.length} existing categories, skipping default category creation`);
      }
    } catch (error) {
      log(`Error checking/creating default category: ${error}`, "error");
      // Don't throw error here, let the server continue running
    }

    log("Server initialization completed successfully");
  } catch (error) {
    log(`Fatal error during startup: ${error}`, "error");
    process.exit(1);
  }

  // Add unhandled rejection handler
  process.on('unhandledRejection', (reason, promise) => {
    log(`Unhandled Rejection at: ${promise}, reason: ${reason}`, "error");
  });

  // Add uncaught exception handler
  process.on('uncaughtException', (error) => {
    log(`Uncaught Exception: ${error}`, "error");
    process.exit(1);
  });
})().catch(error => {
  log(`Fatal error during startup: ${error}`, "error");
  process.exit(1);
});