#!/usr/bin/env node

/**
 * Fix and Import Script
 * Fixes date format issues and imports data from Neon export to local PostgreSQL
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

console.log('🔧 Fix and Import Script');
console.log('Fixing date formats and importing data from Neon export to local PostgreSQL...\n');

// Check environment
console.log('🔍 Environment check:');
console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'Set' : 'NOT SET');
if (process.env.DATABASE_URL) {
  console.log('Database URL starts with:', process.env.DATABASE_URL.substring(0, 20) + '...');
}

// Function to fix date fields
function fixDateFields(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  
  const fixed = { ...obj };
  
  for (const [key, value] of Object.entries(fixed)) {
    if (value && typeof value === 'string' && (
      key.includes('created') || 
      key.includes('updated') || 
      key.includes('timestamp') ||
      key.includes('date') ||
      key.includes('at')
    )) {
      // Try to parse as date
      const date = new Date(value);
      if (!isNaN(date.getTime())) {
        fixed[key] = date;
      }
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      fixed[key] = fixDateFields(value);
    }
  }
  
  return fixed;
}

async function importData() {
  try {
    console.log('\n🔗 Connecting to database...');
    
    // Import database connection
    const { db } = await import('../../server/db.ts');
    console.log('✅ Database connection successful');
    
    // Check if export file exists
    const exportFile = path.join(__dirname, '..', '..', 'database-backup', 'neon-export.json');
    if (!fs.existsSync(exportFile)) {
      throw new Error(`Export file not found: ${exportFile}`);
    }
    
    console.log('📂 Loading export data...');
    const exportData = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
    console.log('✅ Export data loaded');
    
    // Fix date fields in all tables
    console.log('🔧 Fixing date formats...');
    for (const [tableName, tableData] of Object.entries(exportData.tables)) {
      if (Array.isArray(tableData)) {
        exportData.tables[tableName] = tableData.map(row => fixDateFields(row));
      }
    }
    console.log('✅ Date formats fixed');
    
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
      await db.insert(botConfig).values(exportData.tables.botConfig);
      console.log(`✅ Imported ${exportData.tables.botConfig.length} bot config records`);
    }
    
    if (exportData.tables.categories?.length > 0) {
      console.log('📥 Importing categories...');
      await db.insert(categories).values(exportData.tables.categories);
      console.log(`✅ Imported ${exportData.tables.categories.length} categories`);
    }
    
    if (exportData.tables.users?.length > 0) {
      console.log('📥 Importing users...');
      await db.insert(users).values(exportData.tables.users);
      console.log(`✅ Imported ${exportData.tables.users.length} users`);
    }
    
    if (exportData.tables.tickets?.length > 0) {
      console.log('📥 Importing tickets...');
      await db.insert(tickets).values(exportData.tables.tickets);
      console.log(`✅ Imported ${exportData.tables.tickets.length} tickets`);
    }
    
    if (exportData.tables.messages?.length > 0) {
      console.log('📥 Importing messages...');
      await db.insert(messages).values(exportData.tables.messages);
      console.log(`✅ Imported ${exportData.tables.messages.length} messages`);
    }
    
    if (exportData.tables.messageQueue?.length > 0) {
      console.log('📥 Importing message queue...');
      await db.insert(messageQueue).values(exportData.tables.messageQueue);
      console.log(`✅ Imported ${exportData.tables.messageQueue.length} message queue records`);
    }
    
    if (exportData.tables.userStates?.length > 0) {
      console.log('📥 Importing user states...');
      await db.insert(userStates).values(exportData.tables.userStates);
      console.log(`✅ Imported ${exportData.tables.userStates.length} user states`);
    }
    
    console.log('\n🎉 Import completed successfully!');
    console.log('Your bot should now be using local PostgreSQL.');
    
  } catch (error) {
    console.error('\n❌ Import failed:');
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    
    if (error.message.includes('connection')) {
      console.error('\n💡 Connection troubleshooting:');
      console.error('1. Check if PostgreSQL is running');
      console.error('2. Verify DATABASE_URL in .env file');
      console.error('3. Test connection with: psql -U postgres -d fateats');
    }
    
    throw error;
  }
}

// Run the script
importData().catch(error => {
  console.error('\n❌ Script failed:', error.message);
  process.exit(1);
}); 