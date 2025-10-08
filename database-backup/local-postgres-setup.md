# Local PostgreSQL Setup Instructions

## Prerequisites
- Windows Server with RDP access
- PostgreSQL installed on the server

## 1. Install PostgreSQL on Windows Server

### Option A: Using Chocolatey (Recommended)
```powershell
# Install Chocolatey first if not installed
Set-ExecutionPolicy Bypass -Scope Process -Force; [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072; iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))

# Install PostgreSQL
choco install postgresql
```

### Option B: Manual Installation
1. Download PostgreSQL from https://www.postgresql.org/download/windows/
2. Run the installer
3. Set a password for the postgres user
4. Keep default port 5432

## 2. Create Database and User

```sql
-- Connect to PostgreSQL as postgres user
psql -U postgres

-- Create database
CREATE DATABASE discord_telegram_bridge;

-- Create user (optional, for better security)
CREATE USER bot_user WITH PASSWORD 'your_secure_password';
GRANT ALL PRIVILEGES ON DATABASE discord_telegram_bridge TO bot_user;

-- Connect to the new database
\c discord_telegram_bridge

-- Grant privileges to the user
GRANT ALL ON SCHEMA public TO bot_user;
```

## 3. Update Environment Variables

Update your .env file with the local PostgreSQL connection:

```env
# Replace your current DATABASE_URL with:
DATABASE_URL=postgresql://postgres:your_password@localhost:5432/discord_telegram_bridge

# Or if using a separate user:
DATABASE_URL=postgresql://bot_user:your_secure_password@localhost:5432/discord_telegram_bridge
```

## 4. Update Database Configuration

The application will automatically use the new connection string. No code changes needed.

## 5. Import Data

After setting up the local database, run:
```bash
node utilities/scripts/migrate-to-local-postgres.js import
```

## 6. Test Application

Start your application and verify everything works:
```bash
npm run dev
```

## 7. Performance Optimization (Optional)

For better performance on your RDP server:

### PostgreSQL Configuration
Edit postgresql.conf:
```
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
```

### Windows Firewall
Ensure port 5432 is open for local connections.

## Troubleshooting

### Connection Issues
- Verify PostgreSQL service is running: `services.msc`
- Check if port 5432 is listening: `netstat -an | findstr 5432`
- Test connection: `psql -h localhost -U postgres -d discord_telegram_bridge`

### Performance Issues
- Monitor PostgreSQL logs: `tail -f /var/log/postgresql/postgresql-*.log`
- Use pgAdmin for database management
- Consider increasing shared_buffers if you have more RAM

### Backup Strategy
Set up automated backups:
```powershell
# Create backup script
pg_dump -U postgres discord_telegram_bridge > backup_%date%.sql
```
