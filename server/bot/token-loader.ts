import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { log } from '../vite';

/**
 * Finds and reads the .env file from various possible locations
 * @returns {string|null} The content of the .env file or null if not found
 */
function findAndReadEnvFile(): { content: string | null, path: string | null } {
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
          log(`Found .env file at ${envPath}`, 'info');
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
    }
    
    return { content: envContent, path: foundPath };
  } catch (error) {
    log(`Error reading .env file: ${error}`, 'error');
    return { content: null, path: null };
  }
}

/**
 * Extract a token from the .env content
 * @param envContent The .env file content
 * @param tokenName The name of the token variable (e.g., 'DISCORD_BOT_TOKEN')
 * @returns {string|null} The token or null if not found
 */
function extractTokenFromEnv(envContent: string, tokenName: string): string | null {
  if (!envContent) return null;
  
  // Parse the .env file
  const lines = envContent.split('\n');
  const tokenLine = lines.find(l => l.trim().startsWith(`${tokenName}=`));
  
  if (!tokenLine) {
    log(`${tokenName} not found in .env file`, 'warn');
    return null;
  }
  
  // Extract the token, removing quotes and extra whitespace
  let token = tokenLine.split('=')[1]?.trim();
  if (token) {
    // Remove any quotes that might be present
    token = token.replace(/(^["']|["']$)/g, '');
    log(`Successfully loaded ${tokenName} from .env file (length: ${token.length})`, 'info');
    return token;
  }
  
  log(`${tokenName} found in .env file but appears to be empty`, 'warn');
  return null;
}

/**
 * Loads the Discord bot token directly from the .env file
 * This ensures we get the token from the same place in all environments
 */
export function loadDiscordToken(): string | null {
  try {
    const { content, path } = findAndReadEnvFile();
    if (!content) return null;
    
    const token = extractTokenFromEnv(content, 'DISCORD_BOT_TOKEN');
    
    // Validate Discord token format
    if (token && !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
      log('Warning: Discord token format appears to be invalid. Should be in the format "XXXX.YYYY.ZZZZ"', 'warn');
    }
    
    return token;
  } catch (error) {
    log(`Error loading Discord token: ${error}`, 'error');
    return null;
  }
}

/**
 * Loads the Telegram bot token directly from the .env file
 * This ensures we get the token from the same place in all environments
 */
export function loadTelegramToken(): string | null {
  try {
    const { content, path } = findAndReadEnvFile();
    if (!content) return null;
    
    const token = extractTokenFromEnv(content, 'TELEGRAM_BOT_TOKEN');
    
    // Basic validation for Telegram token format (should be numbers:letters)
    if (token && !token.includes(':')) {
      log('Warning: Telegram token format appears to be invalid. Should contain a colon ":", e.g., "123456789:AAHabcdef123456..."', 'warn');
    }
    
    return token;
  } catch (error) {
    log(`Error loading Telegram token: ${error}`, 'error');
    return null;
  }
}