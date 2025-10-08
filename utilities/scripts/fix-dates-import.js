#!/usr/bin/env node

/**
 * Fix Dates Import Script
 * Properly handles date conversion and imports all data
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

console.log('🔧 Fix Dates Import Script');
console.log('Importing all data with proper date handling...\n');

// Check environment
console.log('🔍 Environment check:');
console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'Set' : 'NOT SET');

// Function to properly convert date strings to Date objects
function convertDates(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  
  const converted = { ...obj };
  
  for (const [key, value] of Object.entries(converted)) {
    // Check if this looks like a date field - be more specific
    if ((key === 'created_at' || key === 'updated_at' || key === 'createdAt' || key === 'updatedAt') ||
        (key.includes('created') && key.includes('at')) ||
        (key.includes('updated') && key.includes('at')) ||
        (key.includes('timestamp') && !key.includes('Id')) ||
        (key === 'date' && !key.includes('Id'))) {
      
      if (value && typeof value === 'string') {
        // Try to parse the date string
        const date = new Date(value);
        if (!isNaN(date.getTime())) {
          converted[key] = date;
          console.log(`  ✅ Converted ${key}: ${value} -> ${date.toISOString()}`);
        } else {
          // If we can't parse it, remove the field
          console.log(`  ❌ Could not parse date for ${key}: ${value} - removing field`);
          delete converted[key];
        }
      } else if (value && typeof value === 'object' && value.$date) {
        // Handle MongoDB-style date objects
        const date = new Date(value.$date);
        if (!isNaN(date.getTime())) {
          converted[key] = date;
          console.log(`  ✅ Converted MongoDB date ${key}: ${value.$date} -> ${date.toISOString()}`);
        } else {
          delete converted[key];
        }
      } else if (!value) {
        // Remove null/undefined date fields
        delete converted[key];
      }
    }
  }
  
  return converted;
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
      const convertedBotConfig = exportData.tables.botConfig.map(row => convertDates(row));
      await db.insert(botConfig).values(convertedBotConfig);
      console.log(`✅ Imported ${exportData.tables.botConfig.length} bot config records`);
    }
    
    if (exportData.tables.categories?.length > 0) {
      console.log('📥 Importing categories...');
      const convertedCategories = exportData.tables.categories.map(row => convertDates(row));
      await db.insert(categories).values(convertedCategories);
      console.log(`✅ Imported ${exportData.tables.categories.length} categories`);
    }
    
    if (exportData.tables.users?.length > 0) {
      console.log('📥 Importing users...');
      const convertedUsers = exportData.tables.users.map(row => convertDates(row));
      await db.insert(users).values(convertedUsers);
      console.log(`✅ Imported ${exportData.tables.users.length} users`);
    }
    
    if (exportData.tables.tickets?.length > 0) {
      console.log('📥 Importing tickets...');
      const convertedTickets = exportData.tables.tickets.map(row => convertDates(row));
      await db.insert(tickets).values(convertedTickets);
      console.log(`✅ Imported ${exportData.tables.tickets.length} tickets`);
    }
    
    if (exportData.tables.messages?.length > 0) {
      console.log('📥 Importing messages...');
      const convertedMessages = exportData.tables.messages.map(row => convertDates(row));
      await db.insert(messages).values(convertedMessages);
      console.log(`✅ Imported ${exportData.tables.messages.length} messages`);
    }
    
    if (exportData.tables.messageQueue?.length > 0) {
      console.log('📥 Importing message queue...');
      const convertedMessageQueue = exportData.tables.messageQueue.map(row => convertDates(row));
      await db.insert(messageQueue).values(convertedMessageQueue);
      console.log(`✅ Imported ${exportData.tables.messageQueue.length} message queue records`);
    }
    
    if (exportData.tables.userStates?.length > 0) {
      console.log('📥 Importing user states...');
      const convertedUserStates = exportData.tables.userStates.map(row => convertDates(row));
      await db.insert(userStates).values(convertedUserStates);
      console.log(`✅ Imported ${exportData.tables.userStates.length} user states`);
    }
    
    console.log('\n🎉 Import completed successfully!');
    console.log('All your data has been imported to local PostgreSQL.');
    console.log('Your bot should now be running with all your existing data.');
    
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