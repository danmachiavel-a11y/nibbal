// Import required modules
import express from 'express';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';
import * as schema from './shared/schema.js';
import { fileURLToPath } from 'url';
import path from 'path';
import fetch from 'node-fetch';

// Configure current directory
const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('Starting debug application...');

// Configure Neon to use WebSockets
neonConfig.webSocketConstructor = ws;
try {
  neonConfig.useSecureWebSocket = true;
} catch (error) {
  console.warn("Couldn't set secure WebSocket option");
}

// Create Express app
const app = express();
app.use(express.json());

// Configure database
console.log('Setting up database connection...');
const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
});

// Add event listeners for better error handling
pool.on('error', (err) => {
  console.error(`Unexpected error on idle database client: ${err.message}`);
});

// Create Drizzle ORM instance
const db = drizzle({ client: pool, schema });

// Helper function to test bots
async function testTelegramBot() {
  console.log('Testing Telegram bot API...');
  try {
    // Get the token from environment or database
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      console.log('No Telegram token found in environment');
      
      // Try to get from database
      const [config] = await db.select().from(schema.botConfig).limit(1);
      if (config && config.telegramToken) {
        console.log('Found Telegram token in database');
      } else {
        console.log('No Telegram token found in database');
        return false;
      }
    }
    
    // Test the API with a simple getMe request
    console.log('Making request to Telegram API...');
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await response.json();
    
    if (data.ok) {
      console.log('Telegram API test successful:', data.result.username);
      return true;
    } else {
      console.error('Telegram API test failed:', data.description);
      return false;
    }
  } catch (error) {
    console.error('Error testing Telegram bot:', error);
    return false;
  }
}

async function testDiscordBot() {
  console.log('Testing Discord bot API...');
  try {
    // Get the token from environment or database
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
      console.log('No Discord token found in environment');
      
      // Try to get from database
      const [config] = await db.select().from(schema.botConfig).limit(1);
      if (config && config.discordToken) {
        console.log('Found Discord token in database');
      } else {
        console.log('No Discord token found in database');
        return false;
      }
    }
    
    // Test the API with a simple getCurrentUser request
    console.log('Making request to Discord API...');
    const response = await fetch('https://discord.com/api/v10/users/@me', {
      headers: {
        Authorization: `Bot ${token}`
      }
    });
    
    if (response.ok) {
      const data = await response.json();
      console.log('Discord API test successful:', data.username);
      return true;
    } else {
      console.error('Discord API test failed:', response.status, response.statusText);
      return false;
    }
  } catch (error) {
    console.error('Error testing Discord bot:', error);
    return false;
  }
}

// API routes
app.get('/', (req, res) => {
  res.send('Debug application is running');
});

app.get('/test-db', async (req, res) => {
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

app.get('/test-bots', async (req, res) => {
  try {
    const telegramResult = await testTelegramBot();
    const discordResult = await testDiscordBot();
    
    res.json({
      telegram: { success: telegramResult },
      discord: { success: discordResult }
    });
  } catch (error) {
    console.error('Bot test error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Debug application listening at http://0.0.0.0:${PORT}`);
});