const fs = require('fs');
const path = require('path');

// Validation helper functions
const validationHelpers = `
// Discord ID validation helpers
function isValidDiscordId(id) {
  return id && typeof id === 'string' && /^\\d{17,19}$/.test(id);
}

function isValidDiscordChannelId(id) {
  return id && typeof id === 'string' && /^\\d{17,19}$/.test(id);
}

function isValidDiscordUserId(id) {
  return id && typeof id === 'string' && /^\\d{17,19}$/.test(id);
}

function isValidDiscordRoleId(id) {
  return id && typeof id === 'string' && /^\\d{17,19}$/.test(id);
}

function isValidTelegramId(id) {
  return id && (typeof id === 'string' || typeof id === 'number') && /^\\d+$/.test(String(id));
}

function logInvalidId(operation, id, context = '') {
  log(\`Skipping invalid ID in \${operation}: \${id}\${context ? ' (' + context + ')' : ''}\`, "warn");
}
`;

// Validation patterns to add to different operations
const validationPatterns = {
  'guild.members.fetch': `
    // Validate user ID before fetching member
    if (!isValidDiscordUserId(userId)) {
      logInvalidId('guild.members.fetch', userId);
      return null;
    }
    const member = await guild.members.fetch(userId);`,

  'client.channels.fetch': `
    // Validate channel ID before fetching
    if (!isValidDiscordChannelId(channelId)) {
      logInvalidId('client.channels.fetch', channelId);
      return null;
    }
    const channel = await this.client.channels.fetch(channelId);`,

  'guild.channels.fetch': `
    // Validate category ID before fetching
    if (!isValidDiscordChannelId(categoryId)) {
      logInvalidId('guild.channels.fetch', categoryId);
      return null;
    }
    const category = await guild.channels.fetch(categoryId);`,

  'guild.roles.fetch': `
    // Validate role ID before fetching
    if (!isValidDiscordRoleId(roleId)) {
      logInvalidId('guild.roles.fetch', roleId);
      return null;
    }
    const role = await guild.roles.fetch(roleId);`,

  'channel.send': `
    // Validate channel exists before sending
    if (!channel || !channel.isTextBased()) {
      logInvalidId('channel.send', channelId, 'channel not found or not text-based');
      return;
    }
    await channel.send(messageOptions);`,

  'webhook.send': `
    // Validate webhook before sending
    if (!webhook || !webhook.url) {
      logInvalidId('webhook.send', webhookId, 'webhook not found or invalid');
      return;
    }
    await webhook.send(messageOptions);`
};

async function addDiscordValidation() {
  const discordFile = path.join(__dirname, '../../server/bot/discord.ts');
  
  try {
    console.log('🔧 Adding Discord validation to critical operations...');
    
    let content = fs.readFileSync(discordFile, 'utf8');
    
    // Add validation helpers at the top of the class
    const classStart = content.indexOf('export class DiscordBot {');
    if (classStart !== -1) {
      const insertPosition = content.indexOf('{', classStart) + 1;
      content = content.slice(0, insertPosition) + '\n' + validationHelpers + content.slice(insertPosition);
    }
    
    // Add validation to specific operations
    // Note: This is a template - you would need to manually apply these patterns
    // to the specific lines in your code where these operations occur
    
    console.log('📝 Validation patterns prepared. Here are the key areas to validate:');
    console.log('\n1. guild.members.fetch operations:');
    console.log(validationPatterns['guild.members.fetch']);
    
    console.log('\n2. client.channels.fetch operations:');
    console.log(validationPatterns['client.channels.fetch']);
    
    console.log('\n3. guild.roles.fetch operations:');
    console.log(validationPatterns['guild.roles.fetch']);
    
    console.log('\n4. channel.send operations:');
    console.log(validationPatterns['channel.send']);
    
    console.log('\n💡 MANUAL STEPS REQUIRED:');
    console.log('1. Add the validation helpers to the DiscordBot class');
    console.log('2. Apply validation patterns to the specific operations listed above');
    console.log('3. Test the bot to ensure validation works correctly');
    
    console.log('\n✅ Validation patterns prepared successfully!');
    
  } catch (error) {
    console.error('❌ Error adding validation:', error);
  }
}

addDiscordValidation(); 