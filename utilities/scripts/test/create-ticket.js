import { execSync } from 'child_process';

// Get the Telegram ID from command line argument
const telegramId = process.argv[2];
const categoryId = process.argv[3] || 7; // Default to category 7 if not specified

if (!telegramId) {
  console.error('Usage: node create-ticket.js <telegramId> [categoryId]');
  process.exit(1);
}

console.log(`Attempting to create a ticket for Telegram ID: ${telegramId} in category ${categoryId}`);

try {
  // Find user by telegram_id
  const userQuery = `SELECT * FROM users WHERE telegram_id = '${telegramId}'`;
  const userOutput = execSync(`psql "$DATABASE_URL" -c "${userQuery}" -t`).toString();
  
  if (!userOutput.trim()) {
    console.log('User not found');
    process.exit(1);
  }
  
  const userId = userOutput.trim().split('|')[0].trim();
  console.log(`Found user with ID: ${userId}`);
  
  // Create a ticket
  const createQuery = `INSERT INTO tickets (user_id, category_id, status, answers) VALUES (${userId}, ${categoryId}, 'open', '{}') RETURNING id`;
  const ticketOutput = execSync(`psql "$DATABASE_URL" -c "${createQuery}" -t`).toString();
  
  const ticketId = ticketOutput.trim();
  console.log(`Successfully created ticket with ID: ${ticketId}`);
  
} catch (error) {
  console.error('Error:', error.message);
  process.exit(1);
}