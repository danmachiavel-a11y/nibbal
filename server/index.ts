import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes, initializeBots } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { storage } from "./storage";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Request logging middleware
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
    // First, create HTTP server and register routes
    log("Setting up HTTP server...");
    const server = await registerRoutes(app);

    // Add explicit error event listener
    server.on('error', (error: any) => {
      log(`HTTP Server error: ${error.message}`, "error");
      if (error.code === 'EADDRINUSE') {
        log('Port 5000 is already in use. Please ensure no other service is using this port.', "error");
        process.exit(1);
      }
    });

    // Add error handler middleware
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

    // Start the server first with more detailed logging
    await new Promise<void>((resolve, reject) => {
      server.listen({
        port: 5000,
        host: "0.0.0.0",
        reusePort: true,
      }, () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          log(`Server successfully bound to ${address.address}:${address.port}`);
        }
        log("HTTP Server is now listening for connections");
        resolve();
      });

      // Add timeout for server startup
      setTimeout(() => {
        reject(new Error('Server failed to start within timeout period'));
      }, 10000);
    });

    log("Server is up and running, proceeding with initialization...");

    // Create default test category after server is up
    try {
      log("Creating default test category...");
      const existingCategories = await storage.getCategories();
      if (existingCategories.length === 0) {
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
      }
    } catch (error) {
      log(`Error setting up default category: ${error}`, "error");
      // Continue server operation even if category creation fails
    }

    // Initialize bots after server is fully up
    log("Server is ready, initializing bots...");
    await initializeBots();

    log("Server initialization completed successfully");
  } catch (error) {
    log(`Fatal error during startup: ${error instanceof Error ? error.message : String(error)}`, "error");
    process.exit(1);
  }
})();