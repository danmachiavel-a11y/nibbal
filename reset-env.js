// Script to update environment variables from .env file
import fs from 'fs';
import { execSync } from 'child_process';

console.log("Reading .env file...");
const envContent = fs.readFileSync('.env', 'utf8');
const envLines = envContent.split('\n');
const tokenLine = envLines.find(line => line.startsWith('DISCORD_BOT_TOKEN='));

if (tokenLine) {
  const token = tokenLine.replace('DISCORD_BOT_TOKEN=', '').trim();
  console.log(`Found Discord token in .env file (length: ${token.length})`);
  
  // Create a simple test script to verify token
  const testScript = `
import { Client, GatewayIntentBits } from 'discord.js';

// Skip loading from .env, use direct value
process.env.DISCORD_BOT_TOKEN = "${token}";

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

console.log("Testing Discord connection with token from .env file...");
client.login(process.env.DISCORD_BOT_TOKEN)
  .then(() => {
    console.log("✅ SUCCESS: Connected to Discord!");
    console.log(\`Connected as: \${client.user.tag}\`);
    setTimeout(() => {
      client.destroy();
      process.exit(0);
    }, 1000);
  })
  .catch(error => {
    console.error("❌ Connection failed:", error.message);
    process.exit(1);
  });
  `;
  
  fs.writeFileSync('token-test.js', testScript);
  console.log("Created test script...");
  
  try {
    console.log("Running test with token from .env file...");
    execSync('node token-test.js', { stdio: 'inherit' });
  } catch (error) {
    console.error("Test failed");
  }
} else {
  console.log("No Discord token found in .env file");
}