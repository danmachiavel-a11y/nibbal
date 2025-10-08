const { Pool } = require('pg');
require('dotenv').config();

// Validation patterns
const DISCORD_ID_PATTERN = /^\d{17,19}$/;
const TELEGRAM_ID_PATTERN = /^\d+$/;
const WEBHOOK_URL_PATTERN = /^https:\/\/discord\.com\/api\/webhooks\/\d+\/[a-zA-Z0-9_-]+$/;

function isValidDiscordId(id) {
  return id && typeof id === 'string' && DISCORD_ID_PATTERN.test(id);
}

function isValidTelegramId(id) {
  return id && (typeof id === 'string' || typeof id === 'number') && TELEGRAM_ID_PATTERN.test(String(id));
}

function isValidWebhookUrl(url) {
  return url && typeof url === 'string' && WEBHOOK_URL_PATTERN.test(url);
}

async function comprehensiveIdValidation() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });

  try {
    console.log('🔍 Comprehensive ID Validation - Checking all potential crash sources...\n');

    let totalIssues = 0;
    const issues = [];

    // 1. Check categories table
    console.log('📋 Checking categories table...');
    const categoriesResult = await pool.query(`
      SELECT id, name, discord_role_id, discord_category_id, transcript_category_id
      FROM categories
    `);

    for (const category of categoriesResult.rows) {
      if (category.discord_role_id && !isValidDiscordId(category.discord_role_id)) {
        issues.push({
          table: 'categories',
          id: category.id,
          field: 'discord_role_id',
          value: category.discord_role_id,
          type: 'invalid_discord_id'
        });
        totalIssues++;
      }

      if (category.discord_category_id && !isValidDiscordId(category.discord_category_id)) {
        issues.push({
          table: 'categories',
          id: category.id,
          field: 'discord_category_id',
          value: category.discord_category_id,
          type: 'invalid_discord_id'
        });
        totalIssues++;
      }

      if (category.transcript_category_id && !isValidDiscordId(category.transcript_category_id)) {
        issues.push({
          table: 'categories',
          id: category.id,
          field: 'transcript_category_id',
          value: category.transcript_category_id,
          type: 'invalid_discord_id'
        });
        totalIssues++;
      }
    }

    // 2. Check tickets table
    console.log('🎫 Checking tickets table...');
    const ticketsResult = await pool.query(`
      SELECT id, discord_channel_id, claimed_by, user_id
      FROM tickets
    `);

    for (const ticket of ticketsResult.rows) {
      if (ticket.discord_channel_id && !isValidDiscordId(ticket.discord_channel_id)) {
        issues.push({
          table: 'tickets',
          id: ticket.id,
          field: 'discord_channel_id',
          value: ticket.discord_channel_id,
          type: 'invalid_discord_id'
        });
        totalIssues++;
      }

      if (ticket.claimed_by && !isValidDiscordId(ticket.claimed_by)) {
        issues.push({
          table: 'tickets',
          id: ticket.id,
          field: 'claimed_by',
          value: ticket.claimed_by,
          type: 'invalid_discord_id'
        });
        totalIssues++;
      }
    }

    // 3. Check users table
    console.log('👥 Checking users table...');
    const usersResult = await pool.query(`
      SELECT id, telegram_id, discord_id, banned_by
      FROM users
    `);

    for (const user of usersResult.rows) {
      if (user.telegram_id && !isValidTelegramId(user.telegram_id)) {
        issues.push({
          table: 'users',
          id: user.id,
          field: 'telegram_id',
          value: user.telegram_id,
          type: 'invalid_telegram_id'
        });
        totalIssues++;
      }

      if (user.discord_id && !isValidDiscordId(user.discord_id)) {
        issues.push({
          table: 'users',
          id: user.id,
          field: 'discord_id',
          value: user.discord_id,
          type: 'invalid_discord_id'
        });
        totalIssues++;
      }

      if (user.banned_by && !isValidDiscordId(user.banned_by)) {
        issues.push({
          table: 'users',
          id: user.id,
          field: 'banned_by',
          value: user.banned_by,
          type: 'invalid_discord_id'
        });
        totalIssues++;
      }
    }

    // 4. Check bot_config table
    console.log('🤖 Checking bot_config table...');
    const botConfigResult = await pool.query(`
      SELECT id, admin_telegram_ids, admin_discord_ids
      FROM bot_config
    `);

    for (const config of botConfigResult.rows) {
      if (config.admin_telegram_ids && Array.isArray(config.admin_telegram_ids)) {
        for (let i = 0; i < config.admin_telegram_ids.length; i++) {
          const telegramId = config.admin_telegram_ids[i];
          if (telegramId && !isValidTelegramId(telegramId)) {
            issues.push({
              table: 'bot_config',
              id: config.id,
              field: `admin_telegram_ids[${i}]`,
              value: telegramId,
              type: 'invalid_telegram_id'
            });
            totalIssues++;
          }
        }
      }

      if (config.admin_discord_ids && Array.isArray(config.admin_discord_ids)) {
        for (let i = 0; i < config.admin_discord_ids.length; i++) {
          const discordId = config.admin_discord_ids[i];
          if (discordId && !isValidDiscordId(discordId)) {
            issues.push({
              table: 'bot_config',
              id: config.id,
              field: `admin_discord_ids[${i}]`,
              value: discordId,
              type: 'invalid_discord_id'
            });
            totalIssues++;
          }
        }
      }
    }

    // 5. Check user_states table
    console.log('💾 Checking user_states table...');
    const userStatesResult = await pool.query(`
      SELECT id, telegram_id
      FROM user_states
    `);

    for (const userState of userStatesResult.rows) {
      if (userState.telegram_id && !isValidTelegramId(userState.telegram_id)) {
        issues.push({
          table: 'user_states',
          id: userState.id,
          field: 'telegram_id',
          value: userState.telegram_id,
          type: 'invalid_telegram_id'
        });
        totalIssues++;
      }
    }

    // 6. Check message_queue table
    console.log('📬 Checking message_queue table...');
    const messageQueueResult = await pool.query(`
      SELECT id, telegram_user_id
      FROM message_queue
    `);

    for (const message of messageQueueResult.rows) {
      if (message.telegram_user_id && !isValidTelegramId(message.telegram_user_id)) {
        issues.push({
          table: 'message_queue',
          id: message.id,
          field: 'telegram_user_id',
          value: message.telegram_user_id,
          type: 'invalid_telegram_id'
        });
        totalIssues++;
      }
    }

    // Summary
    console.log('\n📊 VALIDATION SUMMARY:');
    console.log(`  Total issues found: ${totalIssues}`);
    
    if (totalIssues === 0) {
      console.log('✅ All IDs appear to be valid! Database is clean.');
    } else {
      console.log('\n❌ ISSUES FOUND:');
      
      // Group issues by type
      const issuesByType = {};
      issues.forEach(issue => {
        if (!issuesByType[issue.type]) {
          issuesByType[issue.type] = [];
        }
        issuesByType[issue.type].push(issue);
      });

      for (const [type, typeIssues] of Object.entries(issuesByType)) {
        console.log(`\n  ${type.toUpperCase()} (${typeIssues.length} issues):`);
        typeIssues.forEach(issue => {
          console.log(`    ${issue.table}.${issue.field} (ID: ${issue.id}): "${issue.value}"`);
        });
      }

      console.log('\n💡 RECOMMENDED FIXES:');
      console.log('  1. Run the fix script: node fix-invalid-role-ids.js');
      console.log('  2. For additional safety, run: node comprehensive-id-fix.js');
      console.log('  3. Restart your bot after fixing the database');
    }

  } catch (error) {
    console.error('❌ Error during validation:', error);
  } finally {
    await pool.end();
  }
}

comprehensiveIdValidation(); 