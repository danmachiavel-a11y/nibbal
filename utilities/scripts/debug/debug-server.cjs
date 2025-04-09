// Simple debug server to check what's causing the main server to time out
const express = require('express');
const { Pool, neonConfig } = require('@neondatabase/serverless');
const ws = require('ws');

console.log('Starting debug server...');

// Configure Neon to use WebSockets
neonConfig.webSocketConstructor = ws;
try {
  neonConfig.useSecureWebSocket = true;
} catch (error) {
  console.warn("Couldn't set secure WebSocket option");
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
      console.log('Attempting database connection...');
      const client = await pool.connect();
      console.log('Connected to database');
      try {
        const result = await client.query('SELECT 1 as test');
        console.log('Query successful:', result.rows);
        res.json({ success: true, result: result.rows });
      } finally {
        client.release();
        console.log('Client released');
      }
    } catch (error) {
      console.error('Database query error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Add a simple test endpoint
  app.get('/test-connection', async (req, res) => {
    try {
      console.log('Testing database connection...');
      const client = await pool.connect();
      client.release();
      console.log('Database connection test successful');
      res.send('Database connection test successful');
    } catch (error) {
      console.error('Database connection test failed:', error);
      res.status(500).send(`Database connection test failed: ${error.message}`);
    }
  });
} else {
  console.log('No DATABASE_URL found');
}

// Start the server
app.listen(port, '0.0.0.0', () => {
  console.log(`Debug server listening at http://0.0.0.0:${port}`);
});