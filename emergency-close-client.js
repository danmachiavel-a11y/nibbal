// Emergency Close API Client
// This is a fallback option when all other approaches fail
import 'dotenv/config';
import fetch from 'node-fetch';
import readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function closeTicketForTelegramUser(telegramId) {
  try {
    console.log(`🔄 Attempting to close ticket for Telegram ID: ${telegramId}`);
    
    const response = await fetch('http://localhost:5000/api/emergency/close-ticket-by-telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telegramId })
    });
    
    const data = await response.json();
    
    if (response.ok) {
      console.log('✅ Success!');
      console.log(data);
      return true;
    } else {
      console.log('❌ Error:');
      console.log(data);
      return false;
    }
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    return false;
  }
}

async function promptForTelegramId() {
  return new Promise((resolve) => {
    rl.question('Enter Telegram ID to close ticket for: ', (telegramId) => {
      resolve(telegramId);
    });
  });
}

async function main() {
  console.log('🚨 EMERGENCY TICKET CLOSE TOOL 🚨');
  console.log('Use this tool to close a ticket when the /close command fails');
  console.log('------------------------------------------------------------');
  
  let telegramId = process.argv[2];
  
  if (!telegramId) {
    telegramId = await promptForTelegramId();
  }
  
  await closeTicketForTelegramUser(telegramId);
  
  rl.close();
}

main().catch(console.error);