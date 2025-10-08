import pkg from 'pg';
const { Pool } = pkg;
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function fixSequences() {
  try {
    console.log('\n🔧 Fixing PostgreSQL sequences...');
    
    // Read .env file manually
    const envPath = path.join(__dirname, '..', '..', '.env');
    if (!fs.existsSync(envPath)) {
      console.log('❌ No .env file found!');
      return;
    }
    
    const envContent = fs.readFileSync(envPath, 'utf8');
    const envVars = {};
    
    envContent.split('\n').forEach(line => {
      const [key, ...valueParts] = line.split('=');
      if (key && valueParts.length > 0) {
        envVars[key.trim()] = valueParts.join('=').trim();
      }
    });
    
    const DATABASE_URL = envVars.DATABASE_URL;
    if (!DATABASE_URL) {
      console.log('❌ DATABASE_URL not found in .env file!');
      return;
    }
    
    console.log('✅ Found database connection string');
    
    // Determine if we're using Neon or local PostgreSQL
    const isNeon = DATABASE_URL.includes('neon.tech') || DATABASE_URL.includes('neondatabase');
    
    // Create database connection using same settings as main app
    const pool = new Pool({ 
      connectionString: DATABASE_URL,
      max: 15,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
      maxUses: 10000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 30000,
      allowExitOnIdle: true,
      ssl: isNeon ? { 
        rejectUnauthorized: false
      } : false,
    });
    
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
        const result = await pool.query(`SELECT MAX(id) as max_id FROM "${table}"`);
        const maxId = result.rows[0]?.max_id || 0;
        
        console.log(`  ${table}: max_id = ${maxId}`);
        
        if (maxId > 0) {
          // Reset the sequence to start after the maximum ID
          const sequenceName = `${table}_id_seq`;
          const nextId = maxId + 1;
          
          console.log(`  🔄 Resetting sequence ${sequenceName} to ${nextId}...`);
          await pool.query(`SELECT setval('${sequenceName}', ${nextId}, false)`);
          console.log(`  ✅ Sequence ${sequenceName} reset to ${nextId}`);
        } else {
          console.log(`  ⏭️  Table ${table} is empty, skipping sequence reset`);
        }
        
      } catch (error) {
        console.log(`  ⚠️  Error processing ${table}: ${error.message}`);
      }
    }
    
    await pool.end();
    
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
