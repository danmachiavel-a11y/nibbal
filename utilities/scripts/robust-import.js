#!/usr/bin/env node

/**
 * Robust Import Script
 * Handles date conversion more carefully and imports data with better error handling
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

console.log('🛡️  Robust Import Script');
console.log('Importing data with careful date handling...\n');

// Check environment
console.log('🔍 Environment check:');
console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'Set' : 'NOT SET');

// Function to safely convert date strings to Date objects
function safeDateConversion(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
  }
  return null;
}

// Function to fix date fields more carefully
function fixDateFields(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  
  const fixed = { ...obj };
  
  for (const [key, value] of Object.entries(fixed)) {
    // Check if this looks like a date field
    if (key.includes('created') || 
        key.includes('updated') || 
        key.includes('timestamp') ||
        key.includes('date') ||
        key.includes('at') ||
        key === 'created_at' ||
        key === 'updated_at') {
      
      const convertedDate = safeDateConversion(value);
      if (convertedDate) {
        fixed[key] = convertedDate;
        console.log(`  Fixed date field "${key}": ${value} -> ${convertedDate.toISOString()}`);
      } else if (value) {
        console.log(`  Warning: Could not convert date field "${key}": ${value}`);
        // Remove problematic date fields
        delete fixed[key];
      }
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
      const fixedBotConfig = exportData.tables.botConfig.map(row => fixDateFields(row));
      await db.insert(botConfig).values(fixedBotConfig);
      console.log(`✅ Imported ${exportData.tables.botConfig.length} bot config records`);
    }
    
    if (exportData.tables.categories?.length > 0) {
      console.log('📥 Importing categories...');
      const fixedCategories = exportData.tables.categories.map(row => fixDateFields(row));
      await db.insert(categories).values(fixedCategories);
      console.log(`✅ Imported ${exportData.tables.categories.length} categories`);
    }
    
    if (exportData.tables.users?.length > 0) {
      console.log('📥 Importing users...');
      const fixedUsers = exportData.tables.users.map(row => fixDateFields(row));
      await db.insert(users).values(fixedUsers);
      console.log(`✅ Imported ${exportData.tables.users.length} users`);
    }
    
    if (exportData.tables.tickets?.length > 0) {
      console.log('📥 Importing tickets...');
      const fixedTickets = exportData.tables.tickets.map(row => fixDateFields(row));
      await db.insert(tickets).values(fixedTickets);
      console.log(`✅ Imported ${exportData.tables.tickets.length} tickets`);
    }
    
    if (exportData.tables.messages?.length > 0) {
      console.log('📥 Importing messages...');
      const fixedMessages = exportData.tables.messages.map(row => fixDateFields(row));
      await db.insert(messages).values(fixedMessages);
      console.log(`✅ Imported ${exportData.tables.messages.length} messages`);
    }
    
    if (exportData.tables.messageQueue?.length > 0) {
      console.log('📥 Importing message queue...');
      const fixedMessageQueue = exportData.tables.messageQueue.map(row => fixDateFields(row));
      await db.insert(messageQueue).values(fixedMessageQueue);
      console.log(`✅ Imported ${exportData.tables.messageQueue.length} message queue records`);
    }
    
    if (exportData.tables.userStates?.length > 0) {
      console.log('📥 Importing user states...');
      const fixedUserStates = exportData.tables.userStates.map(row => fixDateFields(row));
      await db.insert(userStates).values(fixedUserStates);
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