const { Pool } = require('pg');
require('dotenv').config();

async function checkInvalidRoleIds() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });

  try {
    console.log('🔍 Checking for invalid Discord role IDs in database...\n');

    // Check categories table for invalid discord_role_id
    const categoriesResult = await pool.query(`
      SELECT id, name, discord_role_id 
      FROM categories 
      WHERE discord_role_id IS NOT NULL
    `);

    console.log('📋 Categories with discord_role_id:');
    let invalidCategoryIds = [];
    
    for (const category of categoriesResult.rows) {
      const roleId = category.discord_role_id;
      const isValid = roleId && typeof roleId === 'string' && /^\d{17,19}$/.test(roleId);
      
      console.log(`  Category: ${category.name} (ID: ${category.id})`);
      console.log(`    Role ID: ${roleId}`);
      console.log(`    Valid: ${isValid ? '✅' : '❌'}`);
      
      if (!isValid) {
        invalidCategoryIds.push(category.id);
      }
      console.log('');
    }

    // Check tickets table for invalid claimed_by
    const ticketsResult = await pool.query(`
      SELECT id, discord_channel_id, claimed_by, status
      FROM tickets 
      WHERE claimed_by IS NOT NULL
    `);

    console.log('🎫 Tickets with claimed_by:');
    let invalidTicketIds = [];
    
    for (const ticket of ticketsResult.rows) {
      const claimedBy = ticket.claimed_by;
      const isValid = claimedBy && typeof claimedBy === 'string' && /^\d{17,19}$/.test(claimedBy);
      
      console.log(`  Ticket: ${ticket.id} (Channel: ${ticket.discord_channel_id})`);
      console.log(`    Claimed by: ${claimedBy}`);
      console.log(`    Status: ${ticket.status}`);
      console.log(`    Valid: ${isValid ? '✅' : '❌'}`);
      
      if (!isValid) {
        invalidTicketIds.push(ticket.id);
      }
      console.log('');
    }

    // Summary
    console.log('📊 SUMMARY:');
    console.log(`  Invalid category role IDs: ${invalidCategoryIds.length}`);
    console.log(`  Invalid ticket claimed_by IDs: ${invalidTicketIds.length}`);
    
    if (invalidCategoryIds.length > 0) {
      console.log('\n❌ INVALID CATEGORY ROLE IDS FOUND:');
      console.log(`  Category IDs: ${invalidCategoryIds.join(', ')}`);
      console.log('\n💡 To fix invalid category role IDs:');
      console.log('  UPDATE categories SET discord_role_id = NULL WHERE id IN (' + invalidCategoryIds.join(',') + ');');
    }
    
    if (invalidTicketIds.length > 0) {
      console.log('\n❌ INVALID TICKET CLAIMED_BY IDS FOUND:');
      console.log(`  Ticket IDs: ${invalidTicketIds.join(', ')}`);
      console.log('\n💡 To fix invalid ticket claimed_by IDs:');
      console.log('  UPDATE tickets SET claimed_by = NULL WHERE id IN (' + invalidTicketIds.join(',') + ');');
    }

    if (invalidCategoryIds.length === 0 && invalidTicketIds.length === 0) {
      console.log('✅ All Discord IDs appear to be valid!');
    }

  } catch (error) {
    console.error('❌ Error checking database:', error);
  } finally {
    await pool.end();
  }
}

checkInvalidRoleIds(); 