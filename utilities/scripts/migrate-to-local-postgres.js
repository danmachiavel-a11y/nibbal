#!/usr/bin/env node

/**
 * Migration Script: Neon → Local PostgreSQL
 * Exports data from Neon and prepares for local PostgreSQL setup
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

// Configuration
const BACKUP_DIR = path.join(__dirname, '..', '..', 'database-backup');
const EXPORT_FILE = path.join(BACKUP_DIR, 'neon-export.json');
const SCHEMA_FILE = path.join(BACKUP_DIR, 'schema.sql');
const SETUP_INSTRUCTIONS = path.join(BACKUP_DIR, 'local-postgres-setup.md');

console.log('🚀 Neon → Local PostgreSQL Migration Script');
console.log('This script will export your data from Neon and prepare for local PostgreSQL setup.\n');

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
      const envBackupPath = path.join(BACKUP_DIR, 'env-backup.txt');
      fs.writeFileSync(envBackupPath, envContent);
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
  console.log('\n📊 Step 2: Exporting database data from Neon...');
  
  try {
    // Import database connection
    const { db } = await import('../../server/db.ts');
    const { 
      users, categories, tickets, messages, botConfig, messageQueue, userStates 
    } = await import('../../shared/schema.ts');
    
    console.log('🔗 Connecting to Neon database...');
    
    // Export all data
    const exportData = {
      exportedAt: new Date().toISOString(),
      source: 'neon',
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

// Step 3: Generate PostgreSQL schema
async function generatePostgreSQLSchema() {
  console.log('\n📝 Step 3: Generating PostgreSQL schema...');
  
  try {
    // Copy the existing schema
    const existingSchemaPath = path.join(__dirname, '..', '..', 'migrations', '0000_lush_xavin.sql');
    if (fs.existsSync(existingSchemaPath)) {
      const schemaContent = fs.readFileSync(existingSchemaPath, 'utf8');
      fs.writeFileSync(SCHEMA_FILE, schemaContent);
      console.log('✅ PostgreSQL schema copied');
    } else {
      console.log('⚠️  Could not find existing schema file');
    }
    
  } catch (error) {
    console.error('❌ Error generating schema:', error.message);
  }
}

// Step 4: Generate setup instructions
function generateSetupInstructions() {
  console.log('\n📋 Step 4: Generating local PostgreSQL setup instructions...');
  
  const instructions = `# Local PostgreSQL Setup Instructions

## Prerequisites
- Windows Server with RDP access
- PostgreSQL installed on the server

## 1. Install PostgreSQL on Windows Server

### Option A: Using Chocolatey (Recommended)
\`\`\`powershell
# Install Chocolatey first if not installed
Set-ExecutionPolicy Bypass -Scope Process -Force; [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072; iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))

# Install PostgreSQL
choco install postgresql
\`\`\`

### Option B: Manual Installation
1. Download PostgreSQL from https://www.postgresql.org/download/windows/
2. Run the installer
3. Set a password for the postgres user
4. Keep default port 5432

## 2. Create Database and User

\`\`\`sql
-- Connect to PostgreSQL as postgres user
psql -U postgres

-- Create database
CREATE DATABASE discord_telegram_bridge;

-- Create user (optional, for better security)
CREATE USER bot_user WITH PASSWORD 'your_secure_password';
GRANT ALL PRIVILEGES ON DATABASE discord_telegram_bridge TO bot_user;

-- Connect to the new database
\\c discord_telegram_bridge

-- Grant privileges to the user
GRANT ALL ON SCHEMA public TO bot_user;
\`\`\`

## 3. Update Environment Variables

Update your .env file with the local PostgreSQL connection:

\`\`\`env
# Replace your current DATABASE_URL with:
DATABASE_URL=postgresql://postgres:your_password@localhost:5432/discord_telegram_bridge

# Or if using a separate user:
DATABASE_URL=postgresql://bot_user:your_secure_password@localhost:5432/discord_telegram_bridge
\`\`\`

## 4. Update Database Configuration

The application will automatically use the new connection string. No code changes needed.

## 5. Import Data

After setting up the local database, run:
\`\`\`bash
node utilities/scripts/migrate-to-local-postgres.js import
\`\`\`

## 6. Test Application

Start your application and verify everything works:
\`\`\`bash
npm run dev
\`\`\`

## 7. Performance Optimization (Optional)

For better performance on your RDP server:

### PostgreSQL Configuration
Edit postgresql.conf:
\`\`\`
# Memory settings
shared_buffers = 256MB
effective_cache_size = 1GB
work_mem = 4MB
maintenance_work_mem = 64MB

# Connection settings
max_connections = 100

# Logging
log_statement = 'none'
log_min_duration_statement = 1000
\`\`\`

### Windows Firewall
Ensure port 5432 is open for local connections.

## Troubleshooting

### Connection Issues
- Verify PostgreSQL service is running: \`services.msc\`
- Check if port 5432 is listening: \`netstat -an | findstr 5432\`
- Test connection: \`psql -h localhost -U postgres -d discord_telegram_bridge\`

### Performance Issues
- Monitor PostgreSQL logs: \`tail -f /var/log/postgresql/postgresql-*.log\`
- Use pgAdmin for database management
- Consider increasing shared_buffers if you have more RAM

### Backup Strategy
Set up automated backups:
\`\`\`powershell
# Create backup script
pg_dump -U postgres discord_telegram_bridge > backup_%date%.sql
\`\`\`
`;

  fs.writeFileSync(SETUP_INSTRUCTIONS, instructions);
  console.log('✅ Local PostgreSQL setup instructions saved');
  
  return instructions;
}

// Step 4.5: Create database schema
async function createDatabaseSchema() {
  console.log('\n🏗️  Step 4.5: Creating database schema...');
  
  try {
    // Import database connection
    const { db } = await import('../../server/db.ts');
    
    console.log('🔗 Connecting to local PostgreSQL...');
    
    // Read the schema file
    if (fs.existsSync(SCHEMA_FILE)) {
      const schemaContent = fs.readFileSync(SCHEMA_FILE, 'utf8');
      
      // Split the schema into individual statements
      const statements = schemaContent
        .split(';')
        .map(stmt => stmt.trim())
        .filter(stmt => stmt.length > 0 && !stmt.startsWith('--'));
      
      console.log(`📝 Executing ${statements.length} schema statements...`);
      
      // Execute each statement
      for (let i = 0; i < statements.length; i++) {
        const statement = statements[i];
        if (statement.trim()) {
          try {
            await db.execute(statement);
            console.log(`✅ Executed statement ${i + 1}/${statements.length}`);
          } catch (error) {
            // Ignore errors for statements that might already exist
            if (!error.message.includes('already exists') && !error.message.includes('duplicate')) {
              console.log(`⚠️  Statement ${i + 1} failed: ${error.message}`);
            }
          }
        }
      }
      
      console.log('✅ Database schema created successfully');
    } else {
      console.log('⚠️  Schema file not found, trying drizzle-kit push...');
      // Fallback to drizzle-kit push
      const { execSync } = await import('child_process');
      execSync('npx drizzle-kit push', { 
        cwd: path.join(__dirname, '..', '..'),
        stdio: 'inherit'
      });
      console.log('✅ Database schema created using drizzle-kit');
    }
    
  } catch (error) {
    console.error('❌ Error creating schema:', error.message);
    throw error;
  }
}

// Step 5: Import data to local PostgreSQL
async function importToLocalPostgreSQL() {
  console.log('\n📥 Step 5: Importing data to local PostgreSQL...');
  
  if (!fs.existsSync(EXPORT_FILE)) {
    console.error('❌ No export file found. Run export first.');
    return;
  }
  
  try {
    // Load export data
    const exportData = JSON.parse(fs.readFileSync(EXPORT_FILE, 'utf8'));
    
    // Import database connection (should now be local PostgreSQL)
    const { db } = await import('../../server/db.ts');
    const { 
      users, categories, tickets, messages, botConfig, messageQueue, userStates 
    } = await import('../../shared/schema.ts');
    
    console.log('🔗 Connecting to local PostgreSQL...');
    
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
    
    console.log('✅ Data import completed successfully!');
    
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
        await generatePostgreSQLSchema();
        generateSetupInstructions();
        console.log('\n🎉 Export completed! Check the database-backup folder for files.');
        console.log('📋 Next steps:');
        console.log('   1. Follow the instructions in database-backup/local-postgres-setup.md');
        console.log('   2. Set up local PostgreSQL on your RDP server');
        console.log('   3. Update your DATABASE_URL environment variable');
        console.log('   4. Run: node utilities/scripts/migrate-to-local-postgres.js import');
        break;
        
      case 'import':
        await createDatabaseSchema();
        await importToLocalPostgreSQL();
        console.log('\n🎉 Migration completed! Your bot should now be using local PostgreSQL.');
        break;
        
      case 'schema':
        await createDatabaseSchema();
        console.log('\n✅ Database schema created successfully!');
        break;
        
      default:
        console.log('Usage:');
        console.log('  node utilities/scripts/migrate-to-local-postgres.js export  # Export from Neon');
        console.log('  node utilities/scripts/migrate-to-local-postgres.js import  # Import to local PostgreSQL');
        console.log('  node utilities/scripts/migrate-to-local-postgres.js schema  # Create schema only');
        break;
    }
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  }
}

// Run the script
main(); 