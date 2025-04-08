// Ultra simple direct close script - one file, minimal dependencies
const telegramId = process.argv[2];

if (!telegramId) {
  console.log("Usage: node ultra-close.js [telegramId]");
  process.exit(1);
}

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

console.log(`Closing ticket for Telegram ID: ${telegramId}`);

(async () => {
  try {
    // Find user
    const userResult = await pool.query(
      'SELECT * FROM users WHERE telegram_id = $1',
      [telegramId]
    );
    
    if (!userResult.rows || userResult.rows.length === 0) {
      console.log("User not found!");
      process.exit(1);
    }
    
    const user = userResult.rows[0];
    console.log(`Found user ID: ${user.id}`);
    
    // Find active tickets
    const ticketsResult = await pool.query(
      `SELECT * FROM tickets 
       WHERE user_id = $1 
       AND status NOT IN ('closed', 'completed', 'transcript')
       ORDER BY id DESC`,
      [user.id]
    );
    
    if (!ticketsResult.rows || ticketsResult.rows.length === 0) {
      console.log("No active tickets found!");
      process.exit(1);
    }
    
    const ticket = ticketsResult.rows[0];
    console.log(`Found ticket ID: ${ticket.id} with status: ${ticket.status}`);
    
    // Close ticket
    await pool.query(
      'UPDATE tickets SET status = $1 WHERE id = $2',
      ['closed', ticket.id]
    );
    
    console.log(`Ticket #${ticket.id} closed successfully!`);
  } catch (e) {
    console.error("Error:", e);
  } finally {
    await pool.end();
  }
})();