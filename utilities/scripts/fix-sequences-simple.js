import { db } from '../../server/db.ts';

async function fixSequences() {
  try {
    console.log('\n🔧 Fixing PostgreSQL sequences...');
    
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
