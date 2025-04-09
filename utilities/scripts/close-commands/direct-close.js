#!/usr/bin/env node
// Direct Close Tool - ESM Version
// This tool directly closes a ticket for the given Telegram user ID
import 'dotenv/config';
import { Pool } from 'pg';
import { Telegraf } from 'telegraf';

/**
 * Direct command line tool to close a ticket
 * Usage: node direct-close.js [telegramId]
 */
async function directClose(telegramId) {
  // Create database connection
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });
  
  try {
    // Verify that telegramId is provided
    if (!telegramId) {
      console.error('❌ Telegram ID is required');
      console.log('Usage: node direct-close.js [telegramId]');
      return;
    }
    
    console.log(`🚨 DIRECT CLOSE TOOL: Attempting to close ticket for Telegram ID ${telegramId}`);
    
    // Get user from database
    const userResult = await pool.query(`
      SELECT * FROM users WHERE telegram_id = $1
    `, [telegramId]);
    
    if (!userResult.rows || userResult.rows.length === 0) {
      console.error(`❌ No user found with Telegram ID: ${telegramId}`);
      return;
    }
    
    const user = userResult.rows[0];
    console.log(`✅ Found user: ${user.id}`);
    
    // Find active tickets
    const ticketsResult = await pool.query(`
      SELECT * FROM tickets 
      WHERE user_id = $1 
      AND status NOT IN ('closed', 'completed', 'transcript')
      ORDER BY id DESC
    `, [user.id]);
    
    if (!ticketsResult.rows || ticketsResult.rows.length === 0) {
      console.error(`❌ No active tickets found for user ${user.id}`);
      return;
    }
    
    // Get the most recent active ticket
    const ticket = ticketsResult.rows[0];
    console.log(`✅ Found ticket #${ticket.id} with status "${ticket.status}"`);
    
    // Update ticket status directly
    const updateResult = await pool.query(`
      UPDATE tickets SET status = 'closed' WHERE id = $1 RETURNING *
    `, [ticket.id]);
    
    if (!updateResult.rows || updateResult.rows.length === 0) {
      console.error(`❌ Failed to update ticket status for ticket #${ticket.id}`);
      return;
    }
    
    console.log(`✅ Successfully closed ticket #${ticket.id}`);
    
    // Send notification to user
    try {
      console.log(`Sending notification to user ${telegramId}...`);
      const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
      await bot.telegram.sendMessage(
        telegramId,
        `✅ Your ticket #${ticket.id} has been closed using the direct close tool.`
      );
      console.log(`✅ Notification sent to user ${telegramId}`);
      await bot.stop();
    } catch (error) {
      console.error(`❌ Failed to send notification: ${error.message}`);
    }
    
    console.log('✅ Operation completed successfully');
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
  } finally {
    await pool.end();
  }
}

// Get Telegram ID from command line argument
const telegramId = process.argv[2];
directClose(telegramId).catch(console.error);