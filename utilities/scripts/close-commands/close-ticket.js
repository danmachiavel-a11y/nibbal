import { execSync } from 'child_process';

// Get the Telegram ID from command line argument
const telegramId = process.argv[2];

if (!telegramId) {
  console.error('Usage: node close-ticket.js <telegramId>');
  process.exit(1);
}

console.log(`Attempting to close active ticket for Telegram ID: ${telegramId}`);

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
  
  // Find active tickets
  const ticketQuery = `SELECT * FROM tickets WHERE user_id = ${userId} AND status NOT IN ('closed', 'completed', 'transcript') ORDER BY id DESC LIMIT 1`;
  const ticketOutput = execSync(`psql "$DATABASE_URL" -c "${ticketQuery}" -t`).toString();
  
  if (!ticketOutput.trim()) {
    console.log('No active tickets found');
    process.exit(1);
  }
  
  const ticketParts = ticketOutput.trim().split('|');
  const ticketId = ticketParts[0].trim();
  console.log(`Found active ticket with ID: ${ticketId}`);
  
  // Close the ticket
  const closeQuery = `UPDATE tickets SET status = 'closed' WHERE id = ${ticketId}`;
  execSync(`psql "$DATABASE_URL" -c "${closeQuery}"`);
  
  console.log(`Successfully closed ticket ${ticketId}`);
  
  // Print ticket details
  console.log(`Ticket details: ${ticketOutput}`);
  
} catch (error) {
  console.error('Error:', error.message);
  process.exit(1);
}