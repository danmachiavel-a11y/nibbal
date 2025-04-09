/**
 * Create a test ticket for a user to test the /cancel command
 * 
 * Usage: node create-test-ticket.js [telegramId]
 */

import pg from 'pg';
const { Pool } = pg;

// Initialize PostgreSQL client
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function createTestTicket(telegramId) {
  console.log(`👉 Creating test ticket for Telegram user ${telegramId}`);
  
  try {
    // Step 1: Find the user in the database
    console.log('🔍 Finding user in database...');
    const userResult = await pool.query(
      `SELECT * FROM users WHERE telegram_id = $1`,
      [telegramId]
    );
    
    if (userResult.rows.length === 0) {
      console.log(`❌ No user found with Telegram ID ${telegramId}`);
      return;
    }
    
    const user = userResult.rows[0];
    console.log(`✅ Found user: ${user.id} (${user.username})`);
    
    // Get a category
    const categoryResult = await pool.query(
      `SELECT * FROM categories ORDER BY id ASC LIMIT 1`
    );
    
    if (categoryResult.rows.length === 0) {
      console.log('❌ No categories found in the database');
      return;
    }
    
    const category = categoryResult.rows[0];
    console.log(`Using category: ${category.name}`);
    
    // Insert test ticket with pending status
    const testTicketResult = await pool.query(
      `INSERT INTO tickets (user_id, category_id, status, answers)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [user.id, category.id, 'pending', ['Test answer 1', 'Test answer 2']]
    );
    
    const testTicket = testTicketResult.rows[0];
    console.log(`✅ Created test ticket with ID ${testTicket.id} and status "pending"`);
    
    console.log('\n✅ Test ticket created successfully!');
    console.log('Now try using the /cancel command in Telegram.');
    console.log('The command should detect this active ticket, close it, and display the proper message.');
  } catch (error) {
    console.error('❌ Error creating test ticket:', error);
  } finally {
    // Close the database connection
    await pool.end();
  }
}

// Get telegram_id from command line arguments or use default
const telegramId = process.argv[2] || '1037841458';
createTestTicket(telegramId);