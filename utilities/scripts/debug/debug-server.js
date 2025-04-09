// Simple debug server to check what's causing the main server to time out
const express = require('express');
const { Pool } = require('@neondatabase/serverless');
const { drizzle } = require('drizzle-orm/neon-serverless');
const ws = require('ws');

console.log('Starting debug server...');

// Configure Neon to use WebSockets
if (typeof neonConfig !== 'undefined') {
  neonConfig.webSocketConstructor = ws;
  try {
    neonConfig.useSecureWebSocket = true;
  } catch (error) {
    console.warn("Couldn't set secure WebSocket option");
  }
}

// Create a simple Express server
const app = express();
const port = 3000;

app.get('/', (req, res) => {
  res.send('Debug server is running');
});

// Test database connection
if (process.env.DATABASE_URL) {
  console.log('Database URL found, testing connection...');
  
  const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000, // Reduced timeout for testing
  });

  pool.on('error', (err) => {
    console.error(`Database connection error: ${err.message}`);
  });

  // Test simple query
  app.get('/db-test', async (req, res) => {
    try {
      const client = await pool.connect();
      try {
        const result = await client.query('SELECT 1 as test');
        res.json({ success: true, result: result.rows });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Database query error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });
} else {
  console.log('No DATABASE_URL found');
}

// Start the server
app.listen(port, () => {
  console.log(`Debug server listening at http://localhost:${port}`);
});