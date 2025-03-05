import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { log } from "./vite";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Basic request logging
app.use((req, res, next) => {
  if (req.path.startsWith("/api")) {
    log(`${req.method} ${req.path}`);
  }
  next();
});

(async () => {
  try {
    log("Starting server initialization...");
    const server = await registerRoutes(app);

    // Basic error handler
    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
      log(`Error handler caught: ${err.message}`, "error");
      res.status(500).json({ message: err.message || "Internal Server Error" });
    });

    // Add error event listener
    server.on('error', (error: any) => {
      log(`Server error encountered: ${error.message}`, "error");
      if (error.code === 'EADDRINUSE') {
        log('Port is already in use, trying alternate port 3000');
        server.listen(3000, "0.0.0.0");
      }
    });

    log("Attempting to start server...");
    server.listen(5000, "0.0.0.0", () => {
      const addr = server.address();
      log(`Server successfully started and listening on ${typeof addr === 'object' ? addr?.port : 5000}`);
    });

  } catch (error) {
    log(`Fatal error during startup: ${error}`, "error");
    process.exit(1);
  }
})();