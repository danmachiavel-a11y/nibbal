#!/usr/bin/env node

import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function clearUsersAndStartFresh() {
  try {
    console.log('\n🗑️  Clearing all users and related data for fresh start...');
    
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
    console.error('\n❌ Clear failed:');
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    
    throw error;
  }
}

// Run the function
clearUsersAndStartFresh().catch(console.error); 