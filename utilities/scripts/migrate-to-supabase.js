#!/usr/bin/env node

/**
 * Safe Migration Script for Supabase
 * Exports current data and prepares migration without affecting the app
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const BACKUP_DIR = path.join(__dirname, '..', '..', 'database-backup');
const EXPORT_FILE = path.join(BACKUP_DIR, 'data-export.json');
const CONFIG_BACKUP = path.join(BACKUP_DIR, 'env-backup.txt');

console.log('🚀 Supabase Migration Script');
console.log('This script will safely export your data without affecting your current app.\n');

// Create backup directory
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  console.log('✅ Created backup directory');
}

// Step 1: Backup current environment
function backupEnvironment() {
  console.log('\n📋 Step 1: Backing up current environment...');
  
  try {
    const envPath = path.join(__dirname, '..', '..', '.env');
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf8');
      fs.writeFileSync(CONFIG_BACKUP, envContent);
      console.log('✅ Environment file backed up');
    } else {
      console.log('⚠️  No .env file found (using environment variables)');
    }
  } catch (error) {
    console.log('⚠️  Could not backup environment:', error.message);
  }
}

// Step 2: Export database data
async function exportDatabaseData() {
  console.log('\n📊 Step 2: Exporting database data...');
  
  try {
    // Import database connection
    const { db } = await import('../../server/db.js');
    const { 
      users, categories, tickets, messages, botConfig, messageQueue, userStates 
    } = await import('../../shared/schema.js');
    
    console.log('🔗 Connecting to current database...');
    
    // Export all data
    const exportData = {
      exportedAt: new Date().toISOString(),
      version: '1.0',
      tables: {}
    };
    
    // Export users
    console.log('📤 Exporting users...');
    const usersData = await db.select().from(users);
    exportData.tables.users = usersData;
    console.log(`✅ Exported ${usersData.length} users`);
    
    // Export categories
    console.log('📤 Exporting categories...');
    const categoriesData = await db.select().from(categories);
    exportData.tables.categories = categoriesData;
    console.log(`✅ Exported ${categoriesData.length} categories`);
    
    // Export tickets
    console.log('📤 Exporting tickets...');
    const ticketsData = await db.select().from(tickets);
    exportData.tables.tickets = ticketsData;
    console.log(`✅ Exported ${ticketsData.length} tickets`);
    
    // Export messages
    console.log('📤 Exporting messages...');
    const messagesData = await db.select().from(messages);
    exportData.tables.messages = messagesData;
    console.log(`✅ Exported ${messagesData.length} messages`);
    
    // Export bot config
    console.log('📤 Exporting bot config...');
    const botConfigData = await db.select().from(botConfig);
    exportData.tables.botConfig = botConfigData;
    console.log(`✅ Exported ${botConfigData.length} bot config records`);
    
    // Export message queue
    console.log('📤 Exporting message queue...');
    const messageQueueData = await db.select().from(messageQueue);
    exportData.tables.messageQueue = messageQueueData;
    console.log(`✅ Exported ${messageQueueData.length} message queue records`);
    
    // Export user states
    console.log('📤 Exporting user states...');
    const userStatesData = await db.select().from(userStates);
    exportData.tables.userStates = userStatesData;
    console.log(`✅ Exported ${userStatesData.length} user states`);
    
    // Save export file
    fs.writeFileSync(EXPORT_FILE, JSON.stringify(exportData, null, 2));
    console.log(`✅ Data exported to ${EXPORT_FILE}`);
    
    // Show summary
    const totalRecords = Object.values(exportData.tables).reduce((sum, table) => sum + table.length, 0);
    console.log(`\n📈 Export Summary:`);
    console.log(`   Total records: ${totalRecords}`);
    console.log(`   Users: ${usersData.length}`);
    console.log(`   Categories: ${categoriesData.length}`);
    console.log(`   Tickets: ${ticketsData.length}`);
    console.log(`   Messages: ${messagesData.length}`);
    console.log(`   Bot Config: ${botConfigData.length}`);
    console.log(`   Message Queue: ${messageQueueData.length}`);
    console.log(`   User States: ${userStatesData.length}`);
    
    return exportData;
    
  } catch (error) {
    console.error('❌ Error exporting data:', error.message);
    throw error;
  }
}

// Step 3: Generate Supabase setup instructions
function generateSupabaseInstructions() {
  console.log('\n📝 Step 3: Generating Supabase setup instructions...');
  
  const instructions = `
# Supabase Setup Instructions

## 1. Create Supabase Account
- Go to https://supabase.com
- Sign up for free account
- Create new project

## 2. Get Connection String
- Go to Settings > Database
- Copy the connection string
- It looks like: postgresql://postgres:[password]@[host]:5432/postgres

## 3. Update Environment
Replace your DATABASE_URL in .env with the Supabase connection string.

## 4. Run Migration
After updating the connection string, run:
node utilities/scripts/migrate-to-supabase.js import

## 5. Test Application
Start your app and verify everything works.
`;

  const instructionsFile = path.join(BACKUP_DIR, 'supabase-setup-instructions.md');
  fs.writeFileSync(instructionsFile, instructions);
  console.log('✅ Supabase instructions saved');
  
  return instructions;
}

// Step 4: Import data to Supabase (when ready)
async function importToSupabase() {
  console.log('\n📥 Step 4: Importing data to Supabase...');
  
  if (!fs.existsSync(EXPORT_FILE)) {
    console.error('❌ No export file found. Run export first.');
    return;
  }
  
  try {
    // Load export data
    const exportData = JSON.parse(fs.readFileSync(EXPORT_FILE, 'utf8'));
    
    // Import database connection (should now be Supabase)
    const { db } = await import('../../server/db.js');
    const { 
      users, categories, tickets, messages, botConfig, messageQueue, userStates 
    } = await import('../../shared/schema.js');
    
    console.log('🔗 Connecting to Supabase...');
    
    // Import data in order (respecting foreign keys)
    console.log('📥 Importing bot config...');
    if (exportData.tables.botConfig.length > 0) {
      await db.insert(botConfig).values(exportData.tables.botConfig);
    }
    
    console.log('📥 Importing categories...');
    if (exportData.tables.categories.length > 0) {
      await db.insert(categories).values(exportData.tables.categories);
    }
    
    console.log('📥 Importing users...');
    if (exportData.tables.users.length > 0) {
      await db.insert(users).values(exportData.tables.users);
    }
    
    console.log('📥 Importing tickets...');
    if (exportData.tables.tickets.length > 0) {
      await db.insert(tickets).values(exportData.tables.tickets);
    }
    
    console.log('📥 Importing messages...');
    if (exportData.tables.messages.length > 0) {
      await db.insert(messages).values(exportData.tables.messages);
    }
    
    console.log('📥 Importing message queue...');
    if (exportData.tables.messageQueue.length > 0) {
      await db.insert(messageQueue).values(exportData.tables.messageQueue);
    }
    
    console.log('📥 Importing user states...');
    if (exportData.tables.userStates.length > 0) {
      await db.insert(userStates).values(exportData.tables.userStates);
    }
    
    console.log('✅ All data imported to Supabase successfully!');
    
  } catch (error) {
    console.error('❌ Error importing data:', error.message);
    throw error;
  }
}

// Main function
async function main() {
  const command = process.argv[2];
  
  try {
    switch (command) {
      case 'export':
        backupEnvironment();
        await exportDatabaseData();
        generateSupabaseInstructions();
        console.log('\n✅ Export completed successfully!');
        console.log('📁 Check the database-backup folder for your exported data.');
        break;
        
      case 'import':
        await importToSupabase();
        console.log('\n✅ Import completed successfully!');
        console.log('🚀 Your app should now be using Supabase!');
        break;
        
      case 'status':
        console.log('\n📊 Migration Status:');
        console.log(`Export file exists: ${fs.existsSync(EXPORT_FILE) ? '✅ Yes' : '❌ No'}`);
        console.log(`Backup directory: ${BACKUP_DIR}`);
        if (fs.existsSync(EXPORT_FILE)) {
          const stats = fs.statSync(EXPORT_FILE);
          console.log(`Export file size: ${(stats.size / 1024).toFixed(2)} KB`);
          console.log(`Export date: ${stats.mtime}`);
        }
        break;
        
      default:
        console.log('Usage:');
        console.log('  node migrate-to-supabase.js export  - Export current data');
        console.log('  node migrate-to-supabase.js import  - Import to Supabase (after updating DATABASE_URL)');
        console.log('  node migrate-to-supabase.js status  - Check migration status');
        break;
    }
  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export {
  backupEnvironment,
  exportDatabaseData,
  importToSupabase,
  generateSupabaseInstructions
};
