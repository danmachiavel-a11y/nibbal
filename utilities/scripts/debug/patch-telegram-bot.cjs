/**
 * TELEGRAM BOT PATCHER
 * 
 * This script modifies the running Telegram bot by adding special middleware
 * that captures ALL updates at the very beginning of the middleware chain.
 * 
 * This will show us if the /close command is being received but getting lost
 * somewhere in the middleware or handlers.
 */

const fs = require('fs');
const path = require('path');

// The patch to insert
const PATCH = `
// [DIAGNOSTIC PATCH]: Add raw event logging to detect command issues
bot.use((ctx, next) => {
  try {
    console.log('\\n==== [DIAGNOSTIC] RAW TELEGRAM UPDATE ====');
    console.log(\`Update ID: \${ctx.update.update_id}\`);
    console.log(\`Update type: \${Object.keys(ctx.update)[0]}\`);
    
    // Log the entire update for debugging
    console.log(\`Raw update: \${JSON.stringify(ctx.update, null, 2)}\`);
    
    // Check for close command
    if (ctx.update.message?.text?.toLowerCase().startsWith('/close')) {
      console.log('\\n🚨🚨🚨 /CLOSE COMMAND DETECTED! 🚨🚨🚨');
      console.log(\`From user: \${ctx.update.message.from.id} (\${ctx.update.message.from.first_name})\`);
      console.log(\`Chat: \${ctx.update.message.chat.id}\`);
      console.log(\`Text: "\${ctx.update.message.text}"\`);
      
      // Check for entities (which indicate command recognition)
      if (ctx.update.message.entities && ctx.update.message.entities.length > 0) {
        console.log(\`Entities: \${JSON.stringify(ctx.update.message.entities)}\`);
        const commandEntity = ctx.update.message.entities.find(e => e.type === 'bot_command');
        if (commandEntity) {
          console.log('✅ This is recognized as a valid bot command');
        } else {
          console.log('⚠️ No bot_command entity even though text starts with /close');
        }
      } else {
        console.log('⚠️ No entities found - Telegram not recognizing this as a command!');
      }
    }
    
    console.log('==== END OF DIAGNOSTIC UPDATE ====\\n');
  } catch (error) {
    console.error('Error in diagnostic middleware:', error);
  }
  
  // Always proceed to next middleware
  return next();
});
`;

// Find the main Telegram bot file
const botFilePath = path.join(process.cwd(), 'server', 'bot', 'telegram.ts');

if (!fs.existsSync(botFilePath)) {
  console.error(`ERROR: Could not find the bot file at ${botFilePath}`);
  process.exit(1);
}

// Read the file
const fileContent = fs.readFileSync(botFilePath, 'utf8');

// Find the appropriate place to insert our patch
// We want to insert it after the bot is created but before handlers are set up
const setupHandlersFunc = fileContent.indexOf('private async setupHandlers()');

if (setupHandlersFunc === -1) {
  console.error('ERROR: Could not find setupHandlers method in the bot file');
  process.exit(1);
}

// Find the first line inside the method
const methodStart = fileContent.indexOf('{', setupHandlersFunc);
if (methodStart === -1) {
  console.error('ERROR: Could not find method start');
  process.exit(1);
}

// Insert our patch at the beginning of the setupHandlers method
const modifiedContent = 
  fileContent.slice(0, methodStart + 1) + 
  PATCH + 
  fileContent.slice(methodStart + 1);

// Write the modified file
fs.writeFileSync(botFilePath, modifiedContent, 'utf8');

console.log('✅ Successfully patched the Telegram bot with diagnostic middleware.');
console.log('Please restart the application to apply the changes.');
console.log('\nAfter restarting, try sending /close to the bot and check the console');
console.log('You should see detailed logs of the raw update if the bot receives the command at all.');