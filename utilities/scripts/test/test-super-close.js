// Ultra-direct test of the close command
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import pkg from 'pg';
const { Pool } = pkg;

// Create database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function testDirectCloseCommand() {
  console.log("🚀 Starting ultra-direct /close command test");
  
  try {
    // Find an active ticket
    const ticketsResult = await pool.query(`
      SELECT t.*, u.telegram_id
      FROM tickets t
      JOIN users u ON t.user_id = u.id
      WHERE t.status NOT IN ('closed', 'completed', 'transcript')
      ORDER BY t.id DESC
      LIMIT 1
    `);
    
    if (!ticketsResult.rows || ticketsResult.rows.length === 0) {
      console.log("❌ No active tickets found for testing");
      return;
    }
    
    const ticket = ticketsResult.rows[0];
    console.log(`✅ Found active ticket #${ticket.id} with status "${ticket.status}" for Telegram ID ${ticket.telegram_id}`);
    
    // Create bot instance
    const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
    
    try {
      // Send a direct /close message to test the handler
      await bot.telegram.sendMessage(
        ticket.telegram_id,
        "🧪 TESTING ULTRA-DIRECT CLOSE HANDLER\n\nPlease send the command /close to close your ticket. This is a direct test of the emergency handling system."
      );
      console.log(`✅ Successfully sent test message to user ${ticket.telegram_id}`);
      
      // Test the ultra-direct close method
      console.log("Testing direct SQL update...");
      const testUpdateResult = await pool.query(`
        UPDATE tickets SET status = 'updating' WHERE id = $1 RETURNING *
      `, [ticket.id]);
      
      if (testUpdateResult.rows && testUpdateResult.rows.length > 0) {
        console.log(`✅ Successfully updated ticket status to "updating"`);
        
        // Restore original status
        await pool.query(`
          UPDATE tickets SET status = $1 WHERE id = $2
        `, [ticket.status, ticket.id]);
        console.log(`✅ Restored ticket status to "${ticket.status}"`);
      } else {
        console.log("❌ Failed to update ticket status");
      }
      
    } catch (error) {
      console.error(`❌ Error in test: ${error.message}`);
    } finally {
      await bot.stop();
    }
    
  } catch (error) {
    console.error(`❌ Error in test: ${error.message}`);
  } finally {
    await pool.end();
  }
}

testDirectCloseCommand().catch(console.error);