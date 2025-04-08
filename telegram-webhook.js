// FINAL SOLUTION: Telegram webhook listener
// This creates a completely separate service that listens for message updates using a webhook

import express from 'express';
import bodyParser from 'body-parser';
import pg from 'pg';
import dotenv from 'dotenv';
import axios from 'axios';

// Configure environment variables
dotenv.config();

const { Pool } = pg;

// Create database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Create Express app
const app = express();
app.use(bodyParser.json());

// Telegram bot token
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is missing from the environment');
  process.exit(1);
}

// Set up the webhook URL - THIS MUST BE SET MANUALLY ONCE
const WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL || 'https://your-replit-app.replit.app/telegram-webhook';

// Endpoint for Telegram webhook
app.post('/telegram-webhook', async (req, res) => {
  console.log('Received webhook update:', JSON.stringify(req.body, null, 2));
  
  try {
    // Process update
    const update = req.body;
    if (update.message && update.message.text === '/close') {
      await handleCloseCommand(update.message);
    }
    
    // Always respond with 200 to acknowledge receipt
    res.status(200).send('OK');
  } catch (error) {
    console.error('Error processing webhook:', error);
    // Still send 200 to avoid Telegram retrying
    res.status(200).send('Error processing, but acknowledged');
  }
});

// Function to handle /close command
async function handleCloseCommand(message) {
  const userId = message.from.id;
  const chatId = message.chat.id;
  
  console.log(`[WEBHOOK] Received /close command from user ${userId}`);
  
  try {
    // Find the user by Telegram ID
    const userResult = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [userId.toString()]);
    
    if (userResult.rows.length === 0) {
      console.log(`[WEBHOOK] User not found for Telegram ID: ${userId}`);
      await sendTelegramMessage(chatId, "❌ You haven't created any tickets yet. Use /start to create a ticket.");
      return;
    }
    
    const user = userResult.rows[0];
    console.log(`[WEBHOOK] Found user with ID: ${user.id}`);
    
    // Find ALL tickets by this user, regardless of status
    const ticketsResult = await pool.query('SELECT * FROM tickets WHERE user_id = $1 ORDER BY id DESC', [user.id]);
    
    if (ticketsResult.rows.length === 0) {
      console.log(`[WEBHOOK] No tickets found for user ID: ${user.id}`);
      await sendTelegramMessage(chatId, "❌ You don't have any tickets to close.");
      return;
    }
    
    // Force close ALL tickets that aren't already closed
    let closedCount = 0;
    for (const ticket of ticketsResult.rows) {
      if (ticket.status !== 'closed' && ticket.status !== 'completed' && ticket.status !== 'transcript') {
        console.log(`[WEBHOOK] Force closing ticket ID: ${ticket.id}, current status: ${ticket.status}`);
        
        // Update ticket status to closed
        await pool.query('UPDATE tickets SET status = $1 WHERE id = $2', ['closed', ticket.id]);
        closedCount++;
        
        // If the ticket has a Discord channel, log it for reference
        if (ticket.discord_channel_id) {
          console.log(`[WEBHOOK] Ticket ${ticket.id} has Discord channel: ${ticket.discord_channel_id}`);
        }
      }
    }
    
    if (closedCount > 0) {
      console.log(`[WEBHOOK] Successfully closed ${closedCount} tickets for user ID: ${user.id}`);
      await sendTelegramMessage(chatId, `✅ Successfully closed ${closedCount} ticket(s). Discord channels will be moved to archives soon.`);
    } else {
      console.log(`[WEBHOOK] No active tickets found to close for user ID: ${user.id}`);
      await sendTelegramMessage(chatId, "ℹ️ You don't have any active tickets to close.");
    }
  } catch (error) {
    console.error(`[WEBHOOK] Error: ${error.message}`);
    await sendTelegramMessage(chatId, "❌ An error occurred while processing your request. Please try again later.");
  }
}

// Function to send message to Telegram
async function sendTelegramMessage(chatId, text) {
  try {
    await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: text
    });
    console.log(`[WEBHOOK] Sent message to chat ${chatId}: ${text}`);
  } catch (error) {
    console.error(`[WEBHOOK] Failed to send message to chat ${chatId}:`, error.message);
  }
}

// Function to set up webhook
async function setupWebhook() {
  try {
    const response = await axios.post(`https://api.telegram.org/bot${TOKEN}/setWebhook`, {
      url: WEBHOOK_URL,
      allowed_updates: ['message']
    });
    
    if (response.data.ok) {
      console.log(`[WEBHOOK] Successfully set webhook to: ${WEBHOOK_URL}`);
    } else {
      console.error(`[WEBHOOK] Failed to set webhook: ${response.data.description}`);
    }
  } catch (error) {
    console.error('[WEBHOOK] Error setting webhook:', error.message);
  }
}

// Function to get webhook info
async function getWebhookInfo() {
  try {
    const response = await axios.get(`https://api.telegram.org/bot${TOKEN}/getWebhookInfo`);
    console.log('[WEBHOOK] Current webhook info:', response.data);
  } catch (error) {
    console.error('[WEBHOOK] Error getting webhook info:', error.message);
  }
}

// Start the server
const PORT = process.env.WEBHOOK_PORT || 4000;
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[WEBHOOK] Server running on port ${PORT}`);
  
  // On startup, check webhook status
  await getWebhookInfo();
  
  // You can uncomment this to set up the webhook
  // await setupWebhook();
});

// Also have a test endpoint to manually check if the service is running
app.get('/test', (req, res) => {
  res.send('Telegram webhook service is running');
});

// Handle GET requests to the webhook URL (for testing)
app.get('/telegram-webhook', (req, res) => {
  res.send('Telegram webhook endpoint is operational');
});

// Provide a way to manually trigger the webhook setup
app.get('/setup-webhook', async (req, res) => {
  await setupWebhook();
  res.send('Webhook setup attempted. Check logs for details.');
});

// Provide an endpoint to get webhook info
app.get('/webhook-info', async (req, res) => {
  try {
    const response = await axios.get(`https://api.telegram.org/bot${TOKEN}/getWebhookInfo`);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Provide an endpoint to test force closing tickets
app.get('/force-close/:telegramId', async (req, res) => {
  const telegramId = req.params.telegramId;
  try {
    // Find the user by Telegram ID
    const userResult = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = userResult.rows[0];
    
    // Find ALL tickets by this user, regardless of status
    const ticketsResult = await pool.query('SELECT * FROM tickets WHERE user_id = $1 ORDER BY id DESC', [user.id]);
    
    if (ticketsResult.rows.length === 0) {
      return res.json({ message: 'No tickets found for this user' });
    }
    
    // Force close ALL tickets that aren't already closed
    let closedTickets = [];
    for (const ticket of ticketsResult.rows) {
      if (ticket.status !== 'closed' && ticket.status !== 'completed' && ticket.status !== 'transcript') {
        await pool.query('UPDATE tickets SET status = $1 WHERE id = $2', ['closed', ticket.id]);
        closedTickets.push({
          id: ticket.id,
          status: 'closed',
          hadDiscordChannel: !!ticket.discord_channel_id
        });
      }
    }
    
    res.json({
      message: `Closed ${closedTickets.length} tickets`,
      closedTickets
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});