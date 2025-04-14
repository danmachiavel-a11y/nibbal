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
    
    // Add a helpful startup message with deployment info
    const isProduction = app.get("env") === "production";
    const deploymentMode = isProduction ? "PRODUCTION" : "DEVELOPMENT";
    log(`Starting server in ${deploymentMode} mode (${new Date().toISOString()})`, "info");
    log(`Node version: ${process.version}`, "info");
    log(`Current working directory: ${process.cwd()}`, "info");
    
    // Set longer timeouts for production environment
    if (isProduction) {
      log("Setting longer timeouts for production environment", "info");
      // Increase default Node.js timeouts for production stability
      require('http').globalAgent.keepAlive = true;
      require('http').globalAgent.keepAliveMsecs = 60000; // 1 minute
      require('https').globalAgent.keepAlive = true;
      require('https').globalAgent.keepAliveMsecs = 60000; // 1 minute
    }
    
    // Verify essential environment variables
    const requiredEnvVars = ['DATABASE_URL', 'TELEGRAM_BOT_TOKEN', 'DISCORD_BOT_TOKEN'];
    const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
    
    if (missingVars.length > 0) {
      log(`WARNING: Missing required environment variables: ${missingVars.join(', ')}`, "warn");
      // We continue anyway - the application will handle these missing variables later
    }
    
    // First, run database migrations with retry logic for production environments
    log("Running database migrations...");
    
    // Add retry logic for migrations in production
    const maxMigrationRetries = isProduction ? 5 : 1;
    let migrationRetries = 0;
    let migrationSuccess = false;
    
    while (!migrationSuccess && migrationRetries < maxMigrationRetries) {
      try {
        await migrate(db, { migrationsFolder: './migrations' });
        migrationSuccess = true;
        log("Database migrations completed successfully");
      } catch (migrationError) {
        migrationRetries++;
        const retryDelay = 2000 * migrationRetries; // Increasing delay
        log(`Migration attempt ${migrationRetries}/${maxMigrationRetries} failed: ${migrationError}`, "error");
        
        if (migrationRetries < maxMigrationRetries) {
          log(`Retrying migrations in ${retryDelay}ms...`, "warn");
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        } else {
          throw new Error(`Failed to run migrations after ${maxMigrationRetries} attempts: ${migrationError}`);
        }
      }
    }
    
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

    // Setup Vite or serve static files based on environment
    if (app.get("env") === "development") {
      await setupVite(app, server);
    } else {
      serveStatic(app);
      log("Static files configured for production serving", "info");
    }

    // Start the server with better error handling
    await new Promise<void>((resolve, reject) => {
      try {
        // Improved error handling for server startup
        server.on('error', (error: any) => {
          log(`Server startup error: ${error}`, "error");
          if (error.code === 'EADDRINUSE') {
            log("Port 5000 is already in use. This is normal in some deployment environments.", "warn");
            // In some deployment environments, the port might already be assigned
            // We resolve anyway to continue with initialization
            resolve();
          } else {
            reject(error);
          }
        });
        
        server.listen({
          port: 5000,
          host: "0.0.0.0",
          reusePort: true,
        }, () => {
          log(`Server listening on port 5000 (${deploymentMode} mode)`, "info");
          resolve();
        });
      } catch (startupError) {
        log(`Unexpected error during server startup: ${startupError}`, "error");
        reject(startupError);
      }
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