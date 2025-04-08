// Direct webhook handler for /close command
import express from 'express';
import { Pool } from 'pg';
import 'dotenv/config';

const app = express();
app.use(express.json());

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Simple webhook endpoint for the /close command
app.post('/webhook/close', async (req, res) => {
  console.log('Received webhook:', req.body);
  
  try {
    const update = req.body;
    
    // Check if this is a message with text
    if (!update.message?.text || !update.message?.from?.id) {
      return res.status(200).send('Not a text message or missing user ID');
    }
    
    const text = update.message.text.trim().toLowerCase();
    const userId = update.message.from.id;
    
    // Only process /close commands
    if (text !== '/close' && !text.startsWith('/close ')) {
      return res.status(200).send('Not a close command');
    }
    
    console.log(`Processing /close command from user ${userId}`);
    
    // Find the user
    const userResult = await pool.query(
      'SELECT * FROM users WHERE telegram_id = $1',
      [userId.toString()]
    );
    
    if (!userResult.rows || userResult.rows.length === 0) {
      console.log(`User ${userId} not found`);
      
      // Try to reply
      try {
        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: update.message.chat.id,
            text: "You haven't created any tickets yet."
          })
        });
      } catch (err) {
        console.error('Error sending reply:', err);
      }
      
      return res.status(200).send('User not found');
    }
    
    const user = userResult.rows[0];
    console.log(`Found user: ${user.id}`);
    
    // Find active tickets
    const ticketsResult = await pool.query(
      `SELECT * FROM tickets 
       WHERE user_id = $1 
       AND status NOT IN ('closed', 'completed', 'transcript')
       ORDER BY id DESC`,
      [user.id]
    );
    
    if (!ticketsResult.rows || ticketsResult.rows.length === 0) {
      console.log(`No active tickets for user ${user.id}`);
      
      // Try to reply
      try {
        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: update.message.chat.id,
            text: "You don't have any active tickets to close."
          })
        });
      } catch (err) {
        console.error('Error sending reply:', err);
      }
      
      return res.status(200).send('No active tickets');
    }
    
    // Get the most recent active ticket
    const ticket = ticketsResult.rows[0];
    console.log(`Found ticket: ${ticket.id} with status ${ticket.status}`);
    
    // Close the ticket
    await pool.query(
      'UPDATE tickets SET status = $1 WHERE id = $2',
      ['closed', ticket.id]
    );
    
    console.log(`Closed ticket ${ticket.id}`);
    
    // Try to reply
    try {
      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: update.message.chat.id,
          text: `✅ Your ticket #${ticket.id} has been closed.`
        })
      });
    } catch (err) {
      console.error('Error sending reply:', err);
    }
    
    return res.status(200).send('Ticket closed');
  } catch (error) {
    console.error('Error processing webhook:', error);
    return res.status(500).send('Internal server error');
  }
});

// Start the server
const PORT = process.env.CLOSE_WEBHOOK_PORT || 3333;
app.listen(PORT, () => {
  console.log(`Close webhook server running on port ${PORT}`);
});