// Quick script to verify Discord token and update .env file if needed
import { config } from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client, GatewayIntentBits } from 'discord.js';

config();

const token = process.env.DISCORD_BOT_TOKEN;
console.log(`Current token in environment: ${token ? 'exists (length: ' + token.length + ')' : 'missing'}`);

// Check if token is valid format (basic check)
const isValidFormat = token && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
console.log(`Token format valid: ${isValidFormat}`);

// Get directory name for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// If token from environment variables exists, update the .env file to ensure it matches
if (token && token.length > 50) {
  try {
    const envPath = path.join(__dirname, '.env');
    let envContent = fs.readFileSync(envPath, 'utf8');
    
    // Replace existing Discord token line
    const newContent = envContent.replace(
      /^DISCORD_BOT_TOKEN=.*/m,
      `DISCORD_BOT_TOKEN=${token}`
    );
    
    // Only write if something changed
    if (newContent !== envContent) {
      fs.writeFileSync(envPath, newContent);
      console.log('Updated .env file with token from environment variables');
    } else {
      console.log('.env file already has correct token');
    }
  } catch (err) {
    console.error('Error updating .env file:', err);
  }
}

// Attempt to verify token with Discord API
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ]
});

console.log('Attempting to validate token with Discord API...');
client.login(token)
  .then(() => {
    console.log('✅ Token successfully validated with Discord API!');
    console.log(`Connected as: ${client.user.tag}`);
    console.log(`Connected to ${client.guilds.cache.size} guilds`);
    if (client.guilds.cache.size > 0) {
      console.log('Guilds:');
      client.guilds.cache.forEach(guild => {
        console.log(`- ${guild.name} (ID: ${guild.id}, Members: ${guild.memberCount})`);
      });
    }
    
    setTimeout(() => {
      client.destroy();
      process.exit(0);
    }, 1000);
  })
  .catch(error => {
    console.error('❌ Token validation failed:', error.message);
    process.exit(1);
  });