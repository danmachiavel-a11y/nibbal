import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { log } from '../vite';

/**
 * Loads the Discord bot token directly from the .env file
 * This ensures we get the token from the same place in all environments
 */
export function loadDiscordToken(): string | null {
  try {
    // Get current directory in ESM safe way
    const currentFilePath = fileURLToPath(import.meta.url);
    const currentDir = path.dirname(currentFilePath);
    
    // Try to read directly from .env file
    const possiblePaths = [
      '.env',
      './.env',
      '../.env',
      path.join(process.cwd(), '.env'),
      path.join(currentDir, '..', '..', '.env'),
      path.join(currentDir, '..', '.env'),
    ];
    
    let envContent: string | null = null;
    let foundPath: string | null = null;
    
    // Try each possible path until we find the .env file
    for (const envPath of possiblePaths) {
      try {
        if (fs.existsSync(envPath)) {
          foundPath = envPath;
          log(`Found .env file at ${envPath}`);
          envContent = fs.readFileSync(envPath, 'utf8');
          break;
        }
      } catch (err) {
        // Continue to the next path
      }
    }
    
    if (!envContent) {
      log('Could not find .env file in any of the expected locations', 'warn');
      log(`Tried paths: ${possiblePaths.join(', ')}`, 'debug');
      return null;
    }
    
    // Parse the .env file
    const lines = envContent.split('\n');
    const tokenLine = lines.find(l => l.trim().startsWith('DISCORD_BOT_TOKEN='));
    
    if (!tokenLine) {
      log(`DISCORD_BOT_TOKEN not found in .env file at ${foundPath}`, 'warn');
      return null;
    }
    
    // Extract the token, removing quotes and extra whitespace
    let token = tokenLine.split('=')[1]?.trim();
    if (token) {
      // Remove any quotes that might be present
      token = token.replace(/(^["']|["']$)/g, '');
      log(`Successfully loaded Discord token from .env file (length: ${token.length})`);
      return token;
    }
    
    log('DISCORD_BOT_TOKEN found in .env file but appears to be empty', 'warn');
    return null;
  } catch (error) {
    log(`Error loading Discord token: ${error}`, 'error');
    return null;
  }
}