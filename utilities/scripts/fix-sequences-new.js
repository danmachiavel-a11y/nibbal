#!/usr/bin/env node

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function fixSequences() {
  try {
    console.log('\n🔧 Fixing PostgreSQL sequences...');
    
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
    
    // Import database connection
    const { db } = await import('../../server/db.ts');
    console.log('✅ Database connection successful');
    
    // Get the current maximum ID for each table
    console.log('\n📊 Checking current data...');
    
    const tables = [
      'bot_config',
      'categories', 
      'users',
      'tickets',
      'messages',
      'message_queue',
      'user_states'
    ];
    
    for (const table of tables) {
      try {
        // Get the current maximum ID
        const result = await db.execute(`SELECT MAX(id) as max_id FROM "${table}"`);
        const maxId = result[0]?.max_id || 0;
        
        console.log(`  ${table}: max_id = ${maxId}`);
        
        if (maxId > 0) {
          // Reset the sequence to start after the maximum ID
          const sequenceName = `${table}_id_seq`;
          const nextId = maxId + 1;
          
          console.log(`  🔄 Resetting sequence ${sequenceName} to ${nextId}...`);
          await db.execute(`SELECT setval('${sequenceName}', ${nextId}, false)`);
          console.log(`  ✅ Sequence ${sequenceName} reset to ${nextId}`);
        } else {
          console.log(`  ⏭️  Table ${table} is empty, skipping sequence reset`);
        }
        
      } catch (error) {
        console.log(`  ⚠️  Error processing ${table}: ${error.message}`);
      }
    }
    
    console.log('\n🎉 Sequence fix completed!');
    console.log('All sequences are now properly synchronized with existing data.');
    console.log('The bot should now be able to create new records without primary key conflicts.');
    
  } catch (error) {
    console.error('\n❌ Sequence fix failed:');
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    
    throw error;
  }
}

// Run the function
fixSequences().catch(console.error);
