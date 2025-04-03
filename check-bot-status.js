import fetch from 'node-fetch';

async function checkBotStatus() {
  try {
    // Check Telegram bot status
    console.log('Checking Telegram bot status...');
    const telegramResponse = await fetch('http://localhost:5000/api/bot/telegram/status');
    const telegramData = await telegramResponse.json();
    console.log('Telegram Bot Status:', telegramData);

    // Check Discord bot status
    console.log('\nChecking Discord bot status...');
    const discordResponse = await fetch('http://localhost:5000/api/bot/discord/status');
    const discordData = await discordResponse.json();
    console.log('Discord Bot Status:', discordData);

    // Get Discord roles if available
    if (discordData.connected) {
      console.log('\nFetching Discord roles...');
      const rolesResponse = await fetch('http://localhost:5000/api/discord/roles');
      const rolesData = await rolesResponse.json();
      console.log('Discord Roles:', rolesData);

      console.log('\nFetching Discord categories...');
      const categoriesResponse = await fetch('http://localhost:5000/api/discord/categories');
      const categoriesData = await categoriesResponse.json();
      console.log('Discord Categories:', categoriesData);
    }
  } catch (error) {
    console.error('Error checking bot status:', error);
  }
}

checkBotStatus();