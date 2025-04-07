// Simple script to test the Telegram bot API
import fetch from 'node-fetch';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

console.log('Starting bot API tests...');

async function testTelegramBot() {
  console.log('Testing Telegram bot API...');
  try {
    if (!TELEGRAM_BOT_TOKEN) {
      console.error('No Telegram token found in environment');
      return false;
    }
    
    // Test the API with a simple getMe request
    console.log('Making request to Telegram API...');
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`);
    const data = await response.json();
    
    if (data.ok) {
      console.log('Telegram API test successful:', data.result.username);
      return true;
    } else {
      console.error('Telegram API test failed:', data.description);
      return false;
    }
  } catch (error) {
    console.error('Error testing Telegram bot:', error);
    return false;
  }
}

async function testDiscordBot() {
  console.log('Testing Discord bot API...');
  try {
    if (!DISCORD_BOT_TOKEN) {
      console.error('No Discord token found in environment');
      return false;
    }
    
    // Test the API with a simple getCurrentUser request
    console.log('Making request to Discord API...');
    const response = await fetch('https://discord.com/api/v10/users/@me', {
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`
      }
    });
    
    if (response.ok) {
      const data = await response.json();
      console.log('Discord API test successful:', data.username);
      return true;
    } else {
      console.error('Discord API test failed:', response.status, response.statusText);
      const errorText = await response.text();
      console.error('Error response:', errorText);
      return false;
    }
  } catch (error) {
    console.error('Error testing Discord bot:', error);
    return false;
  }
}

// Run the tests
async function runTests() {
  try {
    console.log('----- TELEGRAM BOT TEST -----');
    const telegramResult = await testTelegramBot();
    console.log('Telegram test result:', telegramResult);
    
    console.log('\n----- DISCORD BOT TEST -----');
    const discordResult = await testDiscordBot();
    console.log('Discord test result:', discordResult);
    
    console.log('\n----- TEST RESULTS -----');
    console.log('Telegram:', telegramResult ? 'SUCCESS' : 'FAILED');
    console.log('Discord:', discordResult ? 'SUCCESS' : 'FAILED');
  } catch (error) {
    console.error('Error running tests:', error);
  }
}

runTests();