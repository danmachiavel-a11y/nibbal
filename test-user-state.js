/**
 * Test user state persistence functionality
 * 
 * This script checks if a user state can be saved and retrieved with large Telegram IDs
 * 
 * Usage: node test-user-state.js [telegramId]
 */

import pg from 'pg';
import dotenv from 'dotenv';

const { Client } = pg;
dotenv.config();

async function testUserStatePersistence(telegramId) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });
  
  try {
    await client.connect();
    console.log(`Connected to database`);
    
    // Create a test state to save
    const testState = JSON.stringify({
      activeTicketId: 999,
      inQuestionnaire: true,
      questionIndex: 0,
      categoryId: 3,
      answers: []
    });
    
    // Get user ID from telegram ID
    const userQuery = `SELECT id FROM users WHERE telegram_id = $1`;
    const userResult = await client.query(userQuery, [telegramId]);
    
    if (userResult.rows.length === 0) {
      console.error(`No user found with Telegram ID: ${telegramId}`);
      return;
    }
    
    const userId = userResult.rows[0].id;
    console.log(`Found user ID: ${userId} for Telegram ID: ${telegramId}`);
    
    // Deactivate existing states
    const deactivateQuery = `
      UPDATE user_states 
      SET is_active = false 
      WHERE telegram_id = $1 AND is_active = true
    `;
    await client.query(deactivateQuery, [telegramId]);
    console.log(`Deactivated existing user states`);
    
    // Insert new state
    const insertQuery = `
      INSERT INTO user_states (user_id, telegram_id, state, timestamp, is_active)
      VALUES ($1, $2, $3, NOW(), true)
      RETURNING id
    `;
    const insertResult = await client.query(insertQuery, [userId, telegramId, testState]);
    console.log(`Inserted new user state with ID: ${insertResult.rows[0].id}`);
    
    // Retrieve the state
    const retrieveQuery = `
      SELECT state FROM user_states
      WHERE telegram_id = $1 AND is_active = true
      ORDER BY timestamp DESC
      LIMIT 1
    `;
    const retrieveResult = await client.query(retrieveQuery, [telegramId]);
    
    if (retrieveResult.rows.length === 0) {
      console.error(`Failed to retrieve state for Telegram ID: ${telegramId}`);
      return;
    }
    
    console.log(`Retrieved state: ${retrieveResult.rows[0].state}`);
    console.log(`Test completed successfully!`);
    
  } catch (error) {
    console.error(`Error testing user state persistence: ${error}`);
  } finally {
    await client.end();
  }
}

// Get telegramId from command line arguments or use a test ID
const telegramId = process.argv[2] || '5424304111';
testUserStatePersistence(telegramId);