#!/usr/bin/env node

/**
 * Clear Tables Script
 * Clears all tables in the database
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from .env file
const envPath = path.join(__dirname, '..', '..', '.env');
dotenv.config({ path: envPath });

console.log('🗑️  Clear Tables Script');
console.log('Clearing all tables in the database...\n');

// Check environment
console.log('🔍 Environment check:');
console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'Set' : 'NOT SET');

async function clearTables() {
  try {
    console.log('\n🔗 Connecting to database...');
    
    // Import database connection
    const { db } = await import('../../server/db.ts');
    console.log('✅ Database connection successful');
    
    console.log('\n🗑️  Clearing tables...');
    
    // Clear tables in reverse dependency order
    const tables = [
      'user_states',
      'message_queue', 
      'messages',
      'tickets',
      'users',
      'categories',
      'bot_config'
    ];
    
    for (const table of tables) {
      console.log(`  Clearing ${table}...`);
      await db.execute(`TRUNCATE TABLE "${table}" CASCADE`);
      console.log(`  ✅ Cleared ${table}`);
    }
    
    console.log('\n🎉 All tables cleared successfully!');
    console.log('The database is now empty and ready for import.');
    
  } catch (error) {
    console.error('\n❌ Clear failed:');
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    
    throw error;
  }
}

// Run the script
clearTables().catch(error => {
  console.error('\n❌ Script failed:', error.message);
  process.exit(1);
}); 