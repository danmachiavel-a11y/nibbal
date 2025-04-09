/**
 * Cancel API Endpoint
 * 
 * This script creates a simple HTTP server that handles ticket cancellation requests.
 * It can be integrated with Telegram via webhooks or buttons.
 * 
 * Usage: node cancel-api.js
 */

import express from 'express';
import pg from 'pg';
import { Telegraf } from 'telegraf';

const { Pool } = pg;

// Pull in token and port from environment
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.CANCEL_API_PORT || 8080;

// Initialize Telegram bot
const bot = new Telegraf(BOT_TOKEN);

// Initialize PostgreSQL client
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Create Express app
const app = express();

// Middleware to parse JSON
app.use(express.json());

// Endpoint to close a ticket for a Telegram user
app.post('/api/cancel', async (req, res) => {
  const { telegramId } = req.body;
  
  if (!telegramId) {
    return res.status(400).json({ error: 'Missing telegramId parameter' });
  }
  
  console.log(`📩 Cancel request received for Telegram user ${telegramId}`);
  
  try {
    // Step 1: Find the user in the database
    console.log('🔍 Finding user in database...');
    const userResult = await pool.query(
      `SELECT * FROM users WHERE telegram_id = $1`,
      [telegramId]
    );
    
    if (userResult.rows.length === 0) {
      console.log(`❌ No user found with Telegram ID ${telegramId}`);
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = userResult.rows[0];
    console.log(`✅ Found user: ${user.id} (${user.username})`);
    
    // Step 2: Find active tickets
    console.log('🔍 Finding active tickets...');
    const ticketsResult = await pool.query(
      `SELECT * FROM tickets 
       WHERE user_id = $1 
       AND (status = 'open' OR status = 'in-progress' OR status = 'pending')
       ORDER BY id DESC`,
      [user.id]
    );
    
    if (ticketsResult.rows.length === 0) {
      console.log(`❌ No active tickets found for user ${user.id}`);
      await bot.telegram.sendMessage(telegramId, "✅ All operations cancelled. Use /start when you're ready to begin again.");
      return res.status(200).json({ status: 'no_tickets', message: 'No active tickets found' });
    }
    
    // Step 3: Close the ticket
    const ticket = ticketsResult.rows[0];
    console.log(`✅ Found active ticket: ${ticket.id} with status "${ticket.status}"`);
    
    console.log('🔒 Closing the ticket...');
    await pool.query(
      `UPDATE tickets SET status = $1 WHERE id = $2`,
      ['closed', ticket.id]
    );
    
    console.log(`✅ Successfully closed ticket ${ticket.id}`);
    
    // Step 4: Move to transcripts if it has a Discord channel
    if (ticket.discord_channel_id) {
      console.log(`💬 Ticket has Discord channel, trying to move to transcripts...`);
      
      // Get the category
      const categoryResult = await pool.query(
        `SELECT * FROM categories WHERE id = $1`,
        [ticket.category_id]
      );
      
      if (categoryResult.rows.length === 0) {
        console.log('❌ Category not found');
      } else {
        const category = categoryResult.rows[0];
        
        if (category.transcript_category_id) {
          console.log(`📁 Found transcript category: ${category.transcript_category_id}`);
          
          // In a real implementation, you would invoke the bridge service here
          // to move the Discord channel to the transcript category
          console.log(`👉 In a complete implementation, we would move the channel to transcripts here`);
        } else {
          console.log('❌ No transcript category set for this service');
        }
      }
    }
    
    // Step 5: Send confirmation message to user
    await bot.telegram.sendMessage(telegramId, "✅ Your ticket has been closed! Use /start when you're ready to begin again.");
    console.log('✅ Sent confirmation message to user');
    
    return res.status(200).json({ 
      status: 'success', 
      message: 'Ticket closed successfully',
      ticketId: ticket.id
    });
    
  } catch (error) {
    console.error('❌ Error during cancel operation:', error);
    
    try {
      await bot.telegram.sendMessage(telegramId, "❌ There was an error closing your ticket. Please try again later.");
      console.log('⚠️ Sent error message to user');
    } catch (sendError) {
      console.error('❌ Failed to send error message:', sendError);
    }
    
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Simple health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

// Root endpoint with usage information
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Ticket Cancel API</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; line-height: 1.6; }
          code { background: #f4f4f4; padding: 2px 5px; border-radius: 3px; }
          pre { background: #f4f4f4; padding: 10px; border-radius: 5px; overflow-x: auto; }
        </style>
      </head>
      <body>
        <h1>Ticket Cancel API</h1>
        <p>This API provides an alternative way to close tickets when the regular /close command isn't working.</p>
        
        <h2>Usage</h2>
        <p>To close a ticket, send a POST request to <code>/api/cancel</code> with the following JSON body:</p>
        <pre>
{
  "telegramId": "YOUR_TELEGRAM_ID"
}
        </pre>
        
        <h2>Example</h2>
        <pre>
curl -X POST http://localhost:${PORT}/api/cancel \\
  -H "Content-Type: application/json" \\
  -d '{"telegramId": "1037841458"}'
        </pre>
      </body>
    </html>
  `);
});

// Start the server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Cancel API server running on port ${PORT}`);
  console.log(`Access the documentation at http://localhost:${PORT}/`);
});