/**
 * Migration script to convert Telegram IDs from text to bigint
 */
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();
const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL environment variable is not set');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function migrate() {
  const client = await pool.connect();
  
  try {
    // Start a transaction
    await client.query('BEGIN');
    
    console.log('Starting migration...');
    
    // 1. Create temporary columns
    console.log('Creating temporary bigint columns...');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_id_bigint BIGINT');
    await client.query('ALTER TABLE user_states ADD COLUMN IF NOT EXISTS telegram_id_bigint BIGINT');
    await client.query('ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS telegram_user_id_bigint BIGINT');
    
    // 2. Convert existing data
    console.log('Converting data in users table...');
    await client.query(`
      UPDATE users 
      SET telegram_id_bigint = telegram_id::bigint 
      WHERE telegram_id ~ '^[0-9]+$'
    `);
    
    console.log('Converting data in user_states table...');
    await client.query(`
      UPDATE user_states 
      SET telegram_id_bigint = telegram_id::bigint 
      WHERE telegram_id ~ '^[0-9]+$'
    `);
    
    console.log('Converting data in message_queue table...');
    await client.query(`
      UPDATE message_queue 
      SET telegram_user_id_bigint = telegram_user_id::bigint 
      WHERE telegram_user_id ~ '^[0-9]+$'
    `);
    
    // 3. Rename columns and create unique constraints/indexes as needed
    console.log('Updating schema structure...');
    
    // Users table
    await client.query('ALTER TABLE users DROP COLUMN telegram_id');
    await client.query('ALTER TABLE users RENAME COLUMN telegram_id_bigint TO telegram_id');
    await client.query('ALTER TABLE users ALTER COLUMN telegram_id TYPE BIGINT');
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS users_telegram_id_unique_idx ON users(telegram_id) WHERE telegram_id IS NOT NULL');
    
    // User states table
    await client.query('ALTER TABLE user_states DROP COLUMN telegram_id');
    await client.query('ALTER TABLE user_states RENAME COLUMN telegram_id_bigint TO telegram_id');
    await client.query('ALTER TABLE user_states ALTER COLUMN telegram_id TYPE BIGINT');
    
    // Message queue table
    await client.query('ALTER TABLE message_queue DROP COLUMN telegram_user_id');
    await client.query('ALTER TABLE message_queue RENAME COLUMN telegram_user_id_bigint TO telegram_user_id');
    await client.query('ALTER TABLE message_queue ALTER COLUMN telegram_user_id TYPE BIGINT');
    
    // Commit transaction
    await client.query('COMMIT');
    console.log('Migration completed successfully!');
    
  } catch (error) {
    // Rollback transaction on error
    await client.query('ROLLBACK');
    console.error('Migration failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run the migration
migrate().catch(err => {
  console.error('Migration script failed:', err);
  process.exit(1);
});