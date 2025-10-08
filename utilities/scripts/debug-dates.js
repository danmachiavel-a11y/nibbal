#!/usr/bin/env node

/**
 * Debug Dates Script
 * Checks the date formats in the export data
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('🔍 Debug Dates Script');
console.log('Checking date formats in export data...\n');

// Check if export file exists
const exportFile = path.join(__dirname, '..', '..', 'database-backup', 'neon-export.json');
if (!fs.existsSync(exportFile)) {
  console.error('❌ Export file not found:', exportFile);
  process.exit(1);
}

console.log('📂 Loading export data...');
const exportData = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
console.log('✅ Export data loaded');

// Check date fields in users table
if (exportData.tables.users && exportData.tables.users.length > 0) {
  console.log('\n📊 Sample user data:');
  const sampleUser = exportData.tables.users[0];
  console.log('Sample user:', JSON.stringify(sampleUser, null, 2));
  
  // Check for date fields
  for (const [key, value] of Object.entries(sampleUser)) {
    if (key.includes('created') || key.includes('updated') || key.includes('at') || key.includes('date')) {
      console.log(`Date field "${key}":`, value, `(type: ${typeof value})`);
      if (typeof value === 'string') {
        const date = new Date(value);
        console.log(`  Parsed as:`, date, `(valid: ${!isNaN(date.getTime())})`);
      }
    }
  }
}

console.log('\n🔧 To fix this, you can:');
console.log('1. Run: npx drizzle-kit push (to ensure tables are created)');
console.log('2. Try importing with the original script and handle errors manually');
console.log('3. Or manually fix the date fields in the export data'); 