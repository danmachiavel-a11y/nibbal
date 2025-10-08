# Discord Bot Crash Fix Summary

## 🚨 Root Cause Identified

The Discord bot was crashing with this error:
```
TypeError [InvalidType]: Supplied parameter is not a User nor a Role.
    at PermissionOverwriteManager.upsert
    at PermissionOverwriteManager.edit
```

### What Was Happening

1. **Invalid Role IDs in Database**: After the database migration from Neon to local PostgreSQL, some Discord role IDs in the database became corrupted or invalid.

2. **No Validation**: The bot code was passing these invalid IDs directly to Discord.js's `permissionOverwrites.edit()` method without validation.

3. **Crash Location**: The crash was specifically happening in the **unclaim command** when trying to restore permissions for staff roles.

## 🔧 Fixes Applied

### 1. Code Validation (Primary Fix)

Added validation in three critical locations in `server/bot/discord.ts`:

#### Claim Command (Line ~2343)
```typescript
// Validate that the roleId is a valid Discord role ID (17-19 digit string)
if (!roleId || typeof roleId !== 'string' || !/^\d{17,19}$/.test(roleId)) {
  log(`Skipping invalid role ID in claim command: ${roleId}`, "warn");
  continue;
}
```

#### Unclaim Command (Line ~2444)
```typescript
// Validate that the ID is a valid Discord role ID (17-19 digit string)
if (!id || typeof id !== 'string' || !/^\d{17,19}$/.test(id)) {
  log(`Skipping invalid role ID in unclaim command: ${id}`, "warn");
  return;
}
```

#### Move Channel Method (Line ~3323)
```typescript
// Validate that the roleId is a valid Discord role ID (17-19 digit string)
if (!roleId || typeof roleId !== 'string' || !/^\d{17,19}$/.test(roleId)) {
  log(`Skipping invalid role ID in moveChannelToCategory: ${roleId}`, "warn");
  continue;
}
```

### 2. Database Cleanup Scripts

Created two utility scripts to identify and fix invalid IDs:

#### Check Script: `utilities/scripts/check-invalid-role-ids.js`
- Scans the database for invalid Discord role IDs
- Reports which categories and tickets have problematic IDs
- Provides SQL commands to fix the issues

#### Fix Script: `utilities/scripts/fix-invalid-role-ids.js`
- Automatically removes invalid Discord IDs from the database
- Sets `discord_role_id` to NULL in categories table
- Sets `claimed_by` to NULL in tickets table

## 🚀 How to Apply the Fix

### Step 1: Run the Database Fix Script
```bash
cd utilities/scripts
node fix-invalid-role-ids.js
```

### Step 2: Restart the Bot
The code changes are already applied. Restart your bot to use the new validation.

### Step 3: Verify the Fix
```bash
cd utilities/scripts
node check-invalid-role-ids.js
```

## 🛡️ Prevention

The validation now ensures that:
- Only valid Discord role IDs (17-19 digit strings) are passed to Discord.js
- Invalid IDs are logged as warnings and skipped
- The bot continues operating even if some role IDs are invalid
- No more crashes from invalid permission overwrites

## 📊 Expected Results

After applying these fixes:
- ✅ Bot will no longer crash on invalid role IDs
- ✅ Invalid IDs will be logged as warnings
- ✅ Valid operations will continue normally
- ✅ Database will be cleaned of any corrupted IDs

## 🔍 Validation Pattern

The validation uses this regex pattern: `/^\d{17,19}$/`
- `^` - Start of string
- `\d{17,19}` - 17 to 19 digits (Discord ID format)
- `$` - End of string

This ensures only valid Discord user/role IDs are processed. 