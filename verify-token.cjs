// Discord token verification script
const fs = require('fs');
const { Client, GatewayIntentBits } = require('discord.js');
require('dotenv').config();

console.log("================= TOKEN VERIFICATION =================");

// Check environment variables
const token = process.env.DISCORD_BOT_TOKEN;
console.log(`1. Token in environment: ${token ? `exists (length: ${token.length})` : 'MISSING'}`);

// Check token format with regex
const tokenRegex = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const formatValid = token && tokenRegex.test(token);
console.log(`2. Token format valid: ${formatValid}`);

// Check .env file directly (bypass dotenv cache)
try {
  const envContent = fs.readFileSync('.env', 'utf8');
  const envLines = envContent.split('\n');
  const discordTokenLine = envLines.find(line => line.startsWith('DISCORD_BOT_TOKEN='));
  
  if (discordTokenLine) {
    const fileToken = discordTokenLine.split('=')[1];
    console.log(`3. Token in .env file: ${fileToken ? `exists (length: ${fileToken.length})` : 'MISSING'}`);
    console.log(`4. Tokens match: ${token === fileToken}`);
    
    if (token !== fileToken) {
      console.log("WARNING: Token in environment doesn't match token in .env file!");
      
      // Check if .env file token is valid format
      const fileTokenFormatValid = fileToken && tokenRegex.test(fileToken);
      console.log(`5. File token format valid: ${fileTokenFormatValid}`);
      
      // Try to update .env file with token from environment
      if (token && token.length > 50) {
        const newContent = envContent.replace(
          /^DISCORD_BOT_TOKEN=.*/m,
          `DISCORD_BOT_TOKEN=${token}`
        );
        
        fs.writeFileSync('.env', newContent);
        console.log('6. Updated .env file with token from environment');
      }
    }
  } else {
    console.log('3. No Discord token line found in .env file!');
  }
} catch (err) {
  console.error('Error reading/writing .env file:', err);
}

// Try to connect to Discord
console.log("\n============ DISCORD CONNECTION TEST ============");
console.log("Attempting to connect to Discord API...");

// Create client with minimal intents
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// Set connection timeout
const timeout = setTimeout(() => {
  console.error("Connection attempt timed out after 10 seconds");
  process.exit(1);
}, 10000);

// Try to log in
client.login(token)
  .then(() => {
    clearTimeout(timeout);
    console.log("\n✅ SUCCESS: Token is valid and connection established!");
    console.log(`Connected as: ${client.user.tag} (ID: ${client.user.id})`);
    
    if (client.guilds.cache.size > 0) {
      console.log(`Connected to ${client.guilds.cache.size} guild(s):`);
      client.guilds.cache.forEach(guild => {
        console.log(`- ${guild.name} (ID: ${guild.id})`);
      });
    } else {
      console.log("Bot is not a member of any guilds/servers");
    }

    // Try to execute a basic Discord API call
    console.log("\nTesting API access...");
    client.application.fetch()
      .then(app => {
        console.log(`Application name: ${app.name}`);
        console.log("API access is working correctly");
        
        // Clean exit
        setTimeout(() => {
          client.destroy();
          process.exit(0);
        }, 1000);
      })
      .catch(err => {
        console.error("API call failed:", err.message);
        client.destroy();
        process.exit(1);
      });
  })
  .catch(error => {
    clearTimeout(timeout);
    console.error("\n❌ FAILURE: Token validation failed!");
    console.error(`Error: ${error.message}`);
    
    if (error.code) {
      console.error(`Error code: ${error.code}`);
    }
    
    if (error.message.includes("invalid token")) {
      console.log("\nTroubleshooting steps:");
      console.log("1. Make sure you've created a bot in the Discord Developer Portal");
      console.log("2. Reset the token in Discord Developer Portal if needed");
      console.log("3. Copy the new token exactly without extra spaces");
      console.log("4. Try manually editing the .env file to ensure proper formatting");
    }
    
    process.exit(1);
  });