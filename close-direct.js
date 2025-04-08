import { execSync } from 'child_process';

const telegramId = process.argv[2];

if (!telegramId) {
  console.error('Usage: node close-direct.js <telegramId>');
  process.exit(1);
}

try {
  // Find user by telegramId
  const userQuery = `SELECT * FROM users WHERE "telegramId" = '${telegramId}'`;
  const userData = execSync(`psql "$DATABASE_URL" -c "${userQuery}" -t`).toString().trim();
  
  if (!userData) {
    console.log('User not found');
    process.exit(1);
  }
  
  const userId = userData.split('|')[0].trim();
  console.log(`Found user with ID: ${userId}`);
  
  // Find active tickets
  const ticketQuery = `SELECT * FROM tickets WHERE "userId" = ${userId} AND status NOT IN ('closed', 'completed', 'transcript') ORDER BY id DESC LIMIT 1`;
  const ticketData = execSync(`psql "$DATABASE_URL" -c "${ticketQuery}" -t`).toString().trim();
  
  if (!ticketData) {
    console.log('No active tickets found');
    process.exit(1);
  }
  
  const ticketId = ticketData.split('|')[0].trim();
  console.log(`Found active ticket with ID: ${ticketId}`);
  
  // Close the ticket
  const closeQuery = `UPDATE tickets SET status = 'closed' WHERE id = ${ticketId}`;
  execSync(`psql "$DATABASE_URL" -c "${closeQuery}"`);
  
  console.log(`Successfully closed ticket ${ticketId}`);
} catch (error) {
  console.error('Error:', error.message);
  process.exit(1);
}
