import { spawn } from 'child_process';

console.log("Starting force-close Telegram command handler...");

// Start the force-close bot
const forceCloseBot = spawn('node', ['telegram-force-close.js']);

// Log output from the bot process
forceCloseBot.stdout.on('data', (data) => {
  console.log(`[FORCE-CLOSE] ${data}`);
});

forceCloseBot.stderr.on('data', (data) => {
  console.error(`[FORCE-CLOSE ERROR] ${data}`);
});

// Handle process termination
forceCloseBot.on('close', (code) => {
  console.log(`Force-close bot exited with code ${code}`);
  process.exit(code);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down...');
  forceCloseBot.kill();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down...');
  forceCloseBot.kill();
  process.exit(0);
});