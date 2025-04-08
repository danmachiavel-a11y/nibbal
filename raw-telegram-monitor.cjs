/**
 * RAW TELEGRAM API MONITOR
 * 
 * This script runs a minimal HTTP server that intercepts and logs ALL Telegram API 
 * updates at the raw HTTP level BEFORE they're processed by any framework.
 * 
 * It acts as a man-in-the-middle between Telegram's API and your bot.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// Configuration
const TELEGRAM_API_HOST = 'api.telegram.org';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const LOCAL_PORT = 3456; // Choose any free port
const LOG_FILE = path.join(process.cwd(), 'raw-telegram-traffic.log');

if (!TELEGRAM_TOKEN) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN not set.');
  process.exit(1);
}

// Prepare the log file
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

// Helper function to log to both console and file
function log(message) {
  const timestamp = new Date().toISOString();
  const formattedMessage = `[${timestamp}] ${message}`;
  console.log(formattedMessage);
  logStream.write(formattedMessage + '\n');
}

// Create HTTP server that will proxy requests
const server = http.createServer((req, res) => {
  const requestStartTime = Date.now();
  let body = [];

  req.on('data', (chunk) => {
    body.push(chunk);
  });

  req.on('end', () => {
    body = Buffer.concat(body).toString();
    
    // Log the incoming request
    log(`📥 INCOMING REQUEST ${req.method} ${req.url}`);
    log(`Headers: ${JSON.stringify(req.headers)}`);
    
    // For POST requests, also log the body
    if (req.method === 'POST') {
      // Try to parse as JSON if possible
      try {
        const parsedBody = JSON.parse(body);
        log(`Body: ${JSON.stringify(parsedBody, null, 2)}`);
        
        // Special focus on updates with messages
        if (parsedBody.message) {
          log(`📝 MESSAGE FOUND: "${parsedBody.message.text || '(no text)'}"`);
          
          if (parsedBody.message.text && parsedBody.message.text.toLowerCase().startsWith('/close')) {
            log(`🚨 /CLOSE COMMAND DETECTED! From user: ${parsedBody.message.from.id}`);
          }
        }
      } catch (e) {
        log(`Body: ${body}`); // Fallback to raw output
      }
    }
    
    // Build target URL for Telegram API
    let targetUrl;
    if (req.url.startsWith('/bot')) {
      // Forward to real Telegram API
      targetUrl = new URL(`https://${TELEGRAM_API_HOST}${req.url}`);
    } else {
      log(`⚠️ Unknown URL format: ${req.url}`);
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }
    
    log(`Forwarding to: ${targetUrl}`);
    
    // Prepare the options for the outgoing request
    const options = {
      method: req.method,
      headers: {...req.headers},
      timeout: 60000, // 1 minute timeout
    };
    
    // Remove headers that might cause issues
    delete options.headers.host;
    
    // Create and send the outgoing request
    const proxyReq = https.request(targetUrl, options, (proxyRes) => {
      // Forward the response status code and headers
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      
      let responseBody = [];
      
      proxyRes.on('data', (chunk) => {
        responseBody.push(chunk);
        res.write(chunk);
      });
      
      proxyRes.on('end', () => {
        responseBody = Buffer.concat(responseBody).toString();
        
        // Try to parse the response as JSON
        try {
          const parsedResponse = JSON.parse(responseBody);
          log(`📤 RESPONSE: ${JSON.stringify(parsedResponse, null, 2)}`);
        } catch (e) {
          log(`📤 RESPONSE: ${responseBody.substring(0, 200)}${responseBody.length > 200 ? '...' : ''}`);
        }
        
        const requestDuration = Date.now() - requestStartTime;
        log(`✅ Request completed in ${requestDuration}ms\n`);
        
        res.end();
      });
    });
    
    proxyReq.on('error', (err) => {
      log(`❌ ERROR: ${err.message}`);
      
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
      }
      
      res.end(JSON.stringify({ ok: false, error: err.message }));
    });
    
    // Write the original request body to the proxy request
    if (body) {
      proxyReq.write(body);
    }
    
    proxyReq.end();
  });
});

// Start the proxy server
server.listen(LOCAL_PORT, () => {
  log(`⭐ Raw Telegram monitor is running on http://localhost:${LOCAL_PORT}`);
  log(`Set your bot's webhook to: http://YOUR_IP:${LOCAL_PORT}/bot${TELEGRAM_TOKEN}/setWebhook`);
  log(`Or run your polling bot with TELEGRAM_API_ROOT set to: http://localhost:${LOCAL_PORT}`);
  log(`All traffic will be logged to: ${LOG_FILE}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  log('Shutting down raw monitor...');
  server.close(() => {
    log('Server closed');
    logStream.end();
    process.exit(0);
  });
});