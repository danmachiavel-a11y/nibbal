// Test Discord Token Script
import { Client, GatewayIntentBits } from 'discord.js';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// ANSI colors for better output formatting
const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
};

// Test a Discord token by attempting to connect
async function testToken(token) {
  console.log(`${colors.cyan}Testing Discord token connection...${colors.reset}`);
  console.log(`${colors.yellow}Token length: ${token ? token.length : 'undefined'}${colors.reset}`);
  
  if (!token) {
    console.error(`${colors.red}No token provided!${colors.reset}`);
    return false;
  }
  
  // Check token format - Discord bot tokens follow a specific pattern
  const tokenFormat = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
  const isValidFormat = tokenFormat.test(token);
  
  if (!isValidFormat) {
    console.error(`${colors.red}Token format is invalid! Expected format: XXXX.YYYY.ZZZZ${colors.reset}`);
    return false;
  }
  
  // Test with minimal permissions to avoid any side effects
  const client = new Client({
    intents: [GatewayIntentBits.Guilds]
  });
  
  try {
    // Set a timeout in case the connection hangs
    const connectPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout after 15 seconds'));
      }, 15000);
      
      client.once('ready', () => {
        clearTimeout(timeout);
        resolve();
      });
      
      client.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      
      // Attempt to log in
      client.login(token).catch(err => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    
    await connectPromise;
    
    // If we got here, the connection was successful
    console.log(`${colors.green}✓ Successfully connected to Discord!${colors.reset}`);
    console.log(`${colors.green}✓ Bot is logged in as: ${client.user.tag}${colors.reset}`);
    console.log(`${colors.green}✓ Connected to ${client.guilds.cache.size} servers${colors.reset}`);
    
    // Clean up
    await client.destroy();
    return true;
  } catch (error) {
    console.error(`${colors.red}✗ Connection failed: ${error.message}${colors.reset}`);
    
    if (error.message.includes('An invalid token was provided')) {
      console.log(`
${colors.yellow}Possible reasons for token failure:${colors.reset}
1. The token may have been reset or revoked
2. The bot application may have been deleted
3. The token may have been compromised and disabled by Discord
4. The token may have extra spaces, quotes or invisible characters

${colors.yellow}Suggested actions:${colors.reset}
1. Go to Discord Developer Portal: https://discord.com/developers/applications
2. Check if your application still exists
3. Reset your token and try again
4. Make sure to copy the token without any surrounding quotes or spaces
`);
    }
    
    // Ensure client is destroyed even after error
    try {
      await client.destroy();
    } catch (e) {
      // Ignore errors during cleanup
    }
    
    return false;
  }
}

// Main function
async function main() {
  console.log(`${colors.cyan}========================================${colors.reset}`);
  console.log(`${colors.cyan}Discord Bot Token Verification Utility${colors.reset}`);
  console.log(`${colors.cyan}========================================${colors.reset}`);
  
  const token = process.env.DISCORD_BOT_TOKEN;
  
  console.log(`${colors.yellow}Testing token from environment variables...${colors.reset}`);
  const success = await testToken(token);
  
  if (success) {
    console.log(`${colors.green}✓ Token verification successful${colors.reset}`);
    process.exit(0);
  } else {
    console.log(`${colors.red}✗ Token verification failed${colors.reset}`);
    console.log(`
${colors.yellow}Next steps:${colors.reset}
1. Get a new token from the Discord Developer Portal
2. Update your .env file with the new token
3. Run this test again to verify the connection
`);
    process.exit(1);
  }
}

// Run the main function
main().catch(error => {
  console.error(`${colors.red}Unexpected error: ${error.message}${colors.reset}`);
  process.exit(1);
});