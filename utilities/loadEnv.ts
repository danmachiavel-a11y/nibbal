import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { log } from '../server/vite';

/**
 * Loads environment variables from .env file
 * @returns True if .env file was loaded successfully, false otherwise
 */
export function loadEnv() {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    
    // Check if .env file exists
    if (fs.existsSync(envPath)) {
      log('Loading environment variables from .env file', 'info');
      
      // Load .env file using dotenv
      const result = dotenv.config({ path: envPath });
      
      if (result.error) {
        log(`Error parsing .env file: ${result.error}`, 'error');
        return false;
      }
      
      // Log the keys being set (but not the values for security)
      const keys = Object.keys(result.parsed || {});
      log(`Loaded ${keys.length} environment variables: ${keys.join(', ')}`, 'info');
      
      // Special diagnostics for common bot tokens
      if (process.env.DISCORD_BOT_TOKEN) {
        const tokenLength = process.env.DISCORD_BOT_TOKEN.length;
        log(`Discord bot token is set (${tokenLength} characters)`, 'info');
      } else {
        log('Discord bot token is not set in .env file', 'warn');
      }
      
      if (process.env.TELEGRAM_BOT_TOKEN) {
        const tokenLength = process.env.TELEGRAM_BOT_TOKEN.length;
        log(`Telegram bot token is set (${tokenLength} characters)`, 'info');
      } else {
        log('Telegram bot token is not set in .env file', 'warn');
      }
      
      return true;
    } else {
      log('No .env file found, using existing environment variables', 'info');
      return false;
    }
  } catch (error) {
    log(`Error loading .env file: ${error}`, 'error');
    return false;
  }
}

/**
 * Create or update an .env file with the provided variables
 * @param variables Record of environment variables to set
 * @param mode 'create' to create a new file, 'update' to update existing variables
 * @returns True if file was created/updated successfully, false otherwise
 */
export function updateEnvFile(variables: Record<string, string>, mode: 'create' | 'update' = 'update') {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    let envContent = '';
    
    // If updating and file exists, read existing content
    if (mode === 'update' && fs.existsSync(envPath)) {
      const existingContent = fs.readFileSync(envPath, 'utf8');
      const existingLines = existingContent.split('\n');
      const updatedKeys = new Set(Object.keys(variables));
      
      // Process each line in the existing file
      for (const line of existingLines) {
        if (line.trim() === '' || line.startsWith('#')) {
          // Keep comments and empty lines
          envContent += line + '\n';
        } else {
          // Check if this is a variable we're updating
          const match = line.match(/^([^=]+)=/);
          if (match) {
            const key = match[1].trim();
            if (updatedKeys.has(key)) {
              // Replace with new value
              envContent += `${key}=${variables[key]}\n`;
              updatedKeys.delete(key);
            } else {
              // Keep existing line
              envContent += line + '\n';
            }
          } else {
            // Not a variable assignment, keep as is
            envContent += line + '\n';
          }
        }
      }
      
      // Add any variables that weren't in the file
      for (const key of updatedKeys) {
        envContent += `${key}=${variables[key]}\n`;
      }
    } else {
      // Creating new file or overwriting
      envContent = Object.entries(variables)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n') + '\n';
    }
    
    // Write to the file
    fs.writeFileSync(envPath, envContent);
    log(`.env file ${mode === 'create' ? 'created' : 'updated'} successfully`, 'info');
    return true;
  } catch (error) {
    log(`Error ${mode === 'create' ? 'creating' : 'updating'} .env file: ${error}`, 'error');
    return false;
  }
}

/**
 * Create a new .env file with the provided variables
 * @param variables Record of environment variables to set
 * @returns True if file was created successfully, false otherwise
 */
export function createEnvFile(variables: Record<string, string>) {
  return updateEnvFile(variables, 'create');
}