#!/usr/bin/env node

/**
 * Clear Database Script
 * Completely clears all tables and data from the database
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from .env file
const envPath = path.join(__dirname, '..', '..', '.env');
dotenv.config({ path: envPath });

console.log('🧹 Database Clear Script');
console.log('This will completely clear all data from your database.\n');

async function clearDatabase() {
  console.log('🔗 Connecting to database...');
  
  try {
    // Import database connection
    const { db } = await import('../server/db.ts');
    
    console.log('🗑️  Clearing all tables...');
    
    // Clear all tables in the correct order (respecting foreign keys)
    const clearQueries = [
      'DROP TABLE IF EXISTS user_states CASCADE',
      'DROP TABLE IF EXISTS message_queue CASCADE', 
      'DROP TABLE IF EXISTS messages CASCADE',
      'DROP TABLE IF EXISTS tickets CASCADE',
      'DROP TABLE IF EXISTS users CASCADE',
      'DROP TABLE IF EXISTS categories CASCADE',
      'DROP TABLE IF EXISTS bot_config CASCADE'
    ];
    
    for (const query of clearQueries) {
      try {
        await db.execute(query);
        console.log(`✅ ${query}`);
      } catch (error) {
        console.log(`⚠️  ${query} - ${error.message}`);
      }
    }
    
    console.log('\n✅ Database cleared successfully!');
    console.log('📋 Next steps:');
    console.log('   1. Run: npx drizzle-kit push (to create fresh tables)');
    console.log('   2. Run: npx tsx utilities/scripts/migrate-to-local-postgres.js import');
    
  } catch (error) {
    console.error('❌ Error clearing database:', error.message);
    throw error;
  }
}

// Run the script
clearDatabase().catch(error => {
  console.error('❌ Script failed:', error.message);
  process.exit(1);
}); 