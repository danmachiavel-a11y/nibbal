import * as fs from 'fs';
import * as path from 'path';

// Simple function to load environment variables from .env file
export function loadEnv() {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    
    // Check if .env file exists
    if (fs.existsSync(envPath)) {
      console.log('Loading environment variables from .env file');
      
      // Read the .env file
      const envFile = fs.readFileSync(envPath, 'utf8');
      
      // Parse each line and set environment variables
      envFile.split('\n').forEach(line => {
        // Skip empty lines and comments
        if (!line || line.startsWith('#')) {
          return;
        }
        
        // Split by first equals sign
        const equalSignPos = line.indexOf('=');
        if (equalSignPos > 0) {
          const key = line.substring(0, equalSignPos).trim();
          let value = line.substring(equalSignPos + 1).trim();
          
          // Remove quotes if present
          if ((value.startsWith('"') && value.endsWith('"')) || 
              (value.startsWith("'") && value.endsWith("'"))) {
            value = value.substring(1, value.length - 1);
          }
          
          // Only set if not already defined
          if (!process.env[key]) {
            process.env[key] = value;
            console.log(`Set environment variable: ${key}`);
          }
        }
      });
      
      console.log('Environment variables loaded successfully');
      return true;
    } else {
      console.log('No .env file found, using existing environment variables');
      return false;
    }
  } catch (error) {
    console.error('Error loading .env file:', error);
    return false;
  }
}

// Export a function to create a new .env file with the provided variables
export function createEnvFile(variables: Record<string, string>) {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    
    // Generate the content
    const content = Object.entries(variables)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    
    // Write to the file
    fs.writeFileSync(envPath, content);
    console.log('.env file created successfully');
    return true;
  } catch (error) {
    console.error('Error creating .env file:', error);
    return false;
  }
}