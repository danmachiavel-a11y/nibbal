// Direct token test script
import { Client, GatewayIntentBits } from 'discord.js';
import fs from 'fs';

// Read token directly from .env file
const envContent = fs.readFileSync('.env', 'utf8');
const lines = envContent.split('\n');
const tokenLine = lines.find(l => l.startsWith('DISCORD_BOT_TOKEN='));
const token = tokenLine ? tokenLine.split('=')[1].trim() : null;

console.log(`Token from file: ${token ? 'found (length: ' + token.length + ')' : 'not found'}`);

if (!token) {
  console.error('No token found in .env file');
  process.exit(1);
}

// Test token format
const tokenFormat = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const isValidFormat = tokenFormat.test(token);
console.log(`Token format valid: ${isValidFormat}`);

if (!isValidFormat) {
  console.error('Token format is invalid');
  process.exit(1);
}

// Add a global exception handler
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

// Create a simple client with minimal intents
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

console.log('Attempting to connect to Discord...');

// Set timeout for connection
const timeout = setTimeout(() => {
  console.error('Connection timed out after 15 seconds');
  process.exit(1);
}, 15000);

// Try to connect
client.login(token)
  .then(() => {
    clearTimeout(timeout);
    console.log('✅ Successfully connected to Discord!');
    console.log(`Connected as: ${client.user.tag}`);
    console.log(`Connected to ${client.guilds.cache.size} servers`);
    
    setTimeout(() => {
      client.destroy();
      process.exit(0);
    }, 2000);
  })
  .catch(err => {
    clearTimeout(timeout);
    console.error('❌ Failed to connect:', err.message);
    
    if (err.message.includes('invalid token')) {
      console.log('\nPossible reasons:');
      console.log('1. The token may have been reset or revoked');
      console.log('2. The bot application may have been deleted');
      console.log('3. The token may have extra spaces or characters');
      console.log('\nTry creating a new Discord application and bot at:');
      console.log('https://discord.com/developers/applications');
    }
    
    process.exit(1);
  });