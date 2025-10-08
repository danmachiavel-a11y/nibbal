#!/usr/bin/env node

/**
 * Aggressive Import Script
 * Imports data with very aggressive date field removal
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

console.log('💥 Aggressive Import Script');
console.log('Importing data with aggressive date field removal...\n');

// Function to remove ALL potential date fields
function removeAllDateFields(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  
  const cleaned = { ...obj };
  
  for (const [key, value] of Object.entries(cleaned)) {
    // Remove ALL fields that could be dates
    if (key === 'created_at' || key === 'updated_at' || key === 'createdAt' || key === 'updatedAt' ||
        key === 'created' || key === 'updated' || key === 'timestamp' || key === 'date' ||
        key === 'last_seen' || key === 'last_activity' || key === 'joined_at' ||
        key === 'last_message' || key === 'last_interaction' ||
        (key.includes('created') && key.includes('at')) ||
        (key.includes('updated') && key.includes('at')) ||
        (key.includes('timestamp') && !key.includes('Id')) ||
        (key.includes('date') && !key.includes('Id')) ||
        (key.includes('time') && !key.includes('Id')) ||
        (key.includes('last') && (key.includes('at') || key.includes('on'))) ||
        (key.includes('first') && (key.includes('at') || key.includes('on')))) {
      console.log(`  🗑️  Removing date field: ${key}`);
      delete cleaned[key];
    }
  }
  
  return cleaned;
}

async function importData() {
  try {
    console.log('\n🔗 Connecting to database...');
    
    // Import database connection
    const { db } = await import('../../server/db.ts');
    console.log('✅ Database connection successful');
    
    // Clear ALL tables first
    console.log('\n🗑️  Clearing all tables...');
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
    
    console.log('✅ All tables cleared');
    
    // Check if export file exists
    const exportFile = path.join(__dirname, '..', '..', 'database-backup', 'neon-export.json');
    if (!fs.existsSync(exportFile)) {
      throw new Error(`Export file not found: ${exportFile}`);
    }
    
    console.log('📂 Loading export data...');
    const exportData = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
    console.log('✅ Export data loaded');
    
    // Import schema
    const { 
      users, categories, tickets, messages, botConfig, messageQueue, userStates 
    } = await import('../../shared/schema.ts');
    console.log('✅ Schema imported');
    
    console.log('\n📊 Import Summary:');
    console.log(`   Users: ${exportData.tables.users?.length || 0}`);
    console.log(`   Categories: ${exportData.tables.categories?.length || 0}`);
    console.log(`   Tickets: ${exportData.tables.tickets?.length || 0}`);
    console.log(`   Messages: ${exportData.tables.messages?.length || 0}`);
    console.log(`   Bot Config: ${exportData.tables.botConfig?.length || 0}`);
    console.log(`   Message Queue: ${exportData.tables.messageQueue?.length || 0}`);
    console.log(`   User States: ${exportData.tables.userStates?.length || 0}`);
    
    // Import data in order (respecting foreign keys)
    console.log('\n📥 Starting data import...');
    
    if (exportData.tables.botConfig?.length > 0) {
      console.log('📥 Importing bot config...');
      const cleanedBotConfig = exportData.tables.botConfig.map(row => removeAllDateFields(row));
      await db.insert(botConfig).values(cleanedBotConfig);
      console.log(`✅ Imported ${exportData.tables.botConfig.length} bot config records`);
    }
    
    if (exportData.tables.categories?.length > 0) {
      console.log('📥 Importing categories...');
      const cleanedCategories = exportData.tables.categories.map(row => removeAllDateFields(row));
      await db.insert(categories).values(cleanedCategories);
      console.log(`✅ Imported ${exportData.tables.categories.length} categories`);
    }
    
    if (exportData.tables.users?.length > 0) {
      console.log('📥 Importing users...');
      const cleanedUsers = exportData.tables.users.map(row => removeAllDateFields(row));
      await db.insert(users).values(cleanedUsers);
      console.log(`✅ Imported ${exportData.tables.users.length} users`);
    }
    
    if (exportData.tables.tickets?.length > 0) {
      console.log('📥 Importing tickets...');
      const cleanedTickets = exportData.tables.tickets.map(row => removeAllDateFields(row));
      await db.insert(tickets).values(cleanedTickets);
      console.log(`✅ Imported ${exportData.tables.tickets.length} tickets`);
    }
    
    if (exportData.tables.messages?.length > 0) {
      console.log('📥 Importing messages...');
      const cleanedMessages = exportData.tables.messages.map(row => removeAllDateFields(row));
      await db.insert(messages).values(cleanedMessages);
      console.log(`✅ Imported ${exportData.tables.messages.length} messages`);
    }
    
    if (exportData.tables.messageQueue?.length > 0) {
      console.log('📥 Importing message queue...');
      const cleanedMessageQueue = exportData.tables.messageQueue.map(row => removeAllDateFields(row));
      await db.insert(messageQueue).values(cleanedMessageQueue);
      console.log(`✅ Imported ${exportData.tables.messageQueue.length} message queue records`);
    }
    
    if (exportData.tables.userStates?.length > 0) {
      console.log('📥 Importing user states...');
      const cleanedUserStates = exportData.tables.userStates.map(row => removeAllDateFields(row));
      await db.insert(userStates).values(cleanedUserStates);
      console.log(`✅ Imported ${exportData.tables.userStates.length} user states`);
    }
    
    console.log('\n🎉 Import completed successfully!');
    console.log('All your data has been imported to local PostgreSQL.');
    console.log('Note: All date fields were removed to avoid import issues.');
    console.log('New records will have proper timestamps when created.');
    
  } catch (error) {
    console.error('\n❌ Import failed:');
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    
    throw error;
  }
}

// Run the script
importData().catch(error => {
  console.error('\n❌ Script failed:', error.message);
  process.exit(1);
}); 