import { spawn } from 'child_process';
import readline from 'readline';

console.log("Starting both bots...");

// Start the main application
const mainApp = spawn('node', ['server/index.js']);
console.log("Main application started");

// Wait a moment to ensure the main app is running before starting the command handler
setTimeout(() => {
  console.log("Starting specialized command handler...");
  const closeHandler = spawn('node', ['close-telegram-command.js']);
  console.log("Command handler started");

  // Handle output from both processes
  mainApp.stdout.on('data', (data) => {
    console.log(`[MAIN] ${data}`);
  });

  mainApp.stderr.on('data', (data) => {
    console.error(`[MAIN ERROR] ${data}`);
  });

  closeHandler.stdout.on('data', (data) => {
    console.log(`[COMMAND] ${data}`);
  });

  closeHandler.stderr.on('data', (data) => {
    console.error(`[COMMAND ERROR] ${data}`);
  });

  // Handle process termination
  mainApp.on('close', (code) => {
    console.log(`Main application exited with code ${code}`);
    closeHandler.kill();
    process.exit(code);
  });

  closeHandler.on('close', (code) => {
    console.log(`Command handler exited with code ${code}`);
    if (code !== null && code !== 0) {
      console.error("Command handler crashed, restarting...");
      // Could implement auto-restart here if needed
    }
  });

  // Allow clean shutdown with CTRL+C
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down gracefully...');
    mainApp.kill();
    closeHandler.kill();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down gracefully...');
    mainApp.kill();
    closeHandler.kill();
    process.exit(0);
  });
}, 5000);  // Wait 5 seconds before starting the second bot