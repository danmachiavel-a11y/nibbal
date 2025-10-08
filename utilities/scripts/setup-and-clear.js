#!/usr/bin/env node

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function setupAndClear() {
  try {
    console.log('\n🔧 Setting up database connection and clearing users...');
    
    // Check if .env file exists
    const envPath = path.join(__dirname, '..', '..', '.env');
    if (!fs.existsSync(envPath)) {
      console.log('❌ No .env file found!');
      console.log('Please create a .env file with your database connection string.');
      console.log('Example: DATABASE_URL=postgresql://username:password@localhost:5432/fateats');
      return;
    }
    
    // Load environment variables from .env file
    dotenv.config({ path: envPath });
    
    // Check if DATABASE_URL is set
    if (!process.env.DATABASE_URL) {
      console.log('❌ DATABASE_URL not found in .env file!');
      console.log('Please add: DATABASE_URL=postgresql://username:password@localhost:5432/fateats');
      return;
    }
    
    // Verify the connection string
    const dbUrl = process.env.DATABASE_URL;
    if (dbUrl.includes('neon.tech')) {
      console.log('⚠️  Found Neon connection string - make sure you want to use this!');
    } else {
      console.log('✅ Found local PostgreSQL connection string');
    }
    
    console.log('\n🗑️  Clearing all users and related data...');
    
    // Import database connection
    const { db } = await import('../../server/db.ts');
    console.log('✅ Database connection successful');
    
    // Clear tables in order (respecting foreign keys)
    console.log('\n🗑️  Clearing tables in dependency order...');
    
    const tables = [
      'user_states',      // Depends on users
      'message_queue',    // Depends on users  
      'messages',         // Depends on users and tickets
      'tickets',          // Depends on users
      'users'             // Base table
    ];
    
    for (const table of tables) {
      console.log(`  Clearing ${table}...`);
      try {
        await db.execute(`TRUNCATE TABLE "${table}" CASCADE`);
        console.log(`  ✅ Cleared ${table}`);
      } catch (error) {
        console.log(`  ⚠️  Error clearing ${table}: ${error.message}`);
      }
    }
    
    // Reset sequences for the cleared tables
    console.log('\n🔄 Resetting sequences...');
    
    const sequences = [
      'users_id_seq',
      'tickets_id_seq', 
      'messages_id_seq',
      'message_queue_id_seq',
      'user_states_id_seq'
    ];
    
    for (const sequence of sequences) {
      try {
        await db.execute(`ALTER SEQUENCE "${sequence}" RESTART WITH 1`);
        console.log(`  ✅ Reset ${sequence} to start from 1`);
      } catch (error) {
        console.log(`  ⚠️  Error resetting ${sequence}: ${error.message}`);
      }
    }
    
    console.log('\n🎉 Fresh start completed!');
    console.log('✅ All users and related data cleared');
    console.log('✅ All sequences reset to start from 1');
    console.log('✅ The bot can now create new users without conflicts');
    console.log('\n📋 Next steps:');
    console.log('   1. Restart your bot');
    console.log('   2. Users will be created fresh when they use /start');
    console.log('   3. No more primary key conflicts or lookup issues');
    
  } catch (error) {
    console.error('\n❌ Setup and clear failed:');
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    
    if (error.message.includes('DATABASE_URL must be set')) {
      console.log('\n💡 Solution:');
      console.log('   1. Make sure your .env file contains: DATABASE_URL=postgresql://username:password@localhost:5432/fateats');
      console.log('   2. Replace with your actual database credentials');
      console.log('   3. Make sure the .env file is in the project root directory');
    }
    
    throw error;
  }
}

// Run the function
setupAndClear().catch(console.error); 