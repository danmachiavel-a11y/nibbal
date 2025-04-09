// Script to fetch the bot configuration
const fetchBotConfig = async () => {
  try {
    const response = await fetch('/api/bot-config');
    if (!response.ok) {
      throw new Error(`Failed to fetch bot configuration: ${response.statusText}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Error fetching bot config:', error);
    return null;
  }
};

// Function to update the bot configuration
const updateBotConfig = async (config) => {
  try {
    const response = await fetch('/api/bot-config', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(config),
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Failed to update bot configuration: ${errorData.message || response.statusText}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error updating bot config:', error);
    throw error;
  }
};

// Show current configuration
fetchBotConfig().then(config => {
  console.log('Current Bot Configuration:', config);
});