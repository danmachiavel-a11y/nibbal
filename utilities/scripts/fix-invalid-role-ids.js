const { Pool } = require('pg');
require('dotenv').config();

async function fixInvalidRoleIds() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });

  try {
    console.log('🔧 Fixing invalid Discord role IDs in database...\n');

    // Fix invalid category role IDs
    const categoriesResult = await pool.query(`
      UPDATE categories 
      SET discord_role_id = NULL 
      WHERE discord_role_id IS NOT NULL 
      AND (discord_role_id !~ '^\\d{17,19}$' OR discord_role_id = '')
      RETURNING id, name, discord_role_id
    `);

    console.log(`📋 Fixed ${categoriesResult.rowCount} invalid category role IDs:`);
    for (const category of categoriesResult.rows) {
      console.log(`  Category: ${category.name} (ID: ${category.id}) - Removed invalid role ID: ${category.discord_role_id}`);
    }

    // Fix invalid ticket claimed_by IDs
    const ticketsResult = await pool.query(`
      UPDATE tickets 
      SET claimed_by = NULL 
      WHERE claimed_by IS NOT NULL 
      AND (claimed_by !~ '^\\d{17,19}$' OR claimed_by = '')
      RETURNING id, discord_channel_id, claimed_by, status
    `);

    console.log(`\n🎫 Fixed ${ticketsResult.rowCount} invalid ticket claimed_by IDs:`);
    for (const ticket of ticketsResult.rows) {
      console.log(`  Ticket: ${ticket.id} (Channel: ${ticket.discord_channel_id}) - Removed invalid claimed_by: ${ticket.claimed_by}`);
    }

    // Summary
    const totalFixed = categoriesResult.rowCount + ticketsResult.rowCount;
    console.log(`\n✅ SUMMARY: Fixed ${totalFixed} invalid Discord IDs total`);
    
    if (totalFixed === 0) {
      console.log('🎉 No invalid Discord IDs found - database is clean!');
    } else {
      console.log('💡 The bot should now be more stable and not crash on invalid role IDs.');
    }

  } catch (error) {
    console.error('❌ Error fixing database:', error);
  } finally {
    await pool.end();
  }
}

fixInvalidRoleIds(); 