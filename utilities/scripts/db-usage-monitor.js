#!/usr/bin/env node

/**
 * Database Usage Monitor
 * Helps track and reduce database compute time usage
 */

const fs = require('fs');
const path = require('path');

// Simple usage tracking
const usageLog = {
  queries: 0,
  startTime: Date.now(),
  expensiveQueries: []
};

// Track expensive operations
function trackExpensiveQuery(operation, duration) {
  usageLog.expensiveQueries.push({
    operation,
    duration,
    timestamp: new Date().toISOString()
  });
  
  // Keep only last 100 expensive queries
  if (usageLog.expensiveQueries.length > 100) {
    usageLog.expensiveQueries.shift();
  }
}

// Get usage summary
function getUsageSummary() {
  const runtime = Date.now() - usageLog.startTime;
  const hours = runtime / (1000 * 60 * 60);
  
  return {
    totalQueries: usageLog.queries,
    runtimeHours: hours,
    queriesPerHour: usageLog.queries / hours,
    expensiveQueries: usageLog.expensiveQueries.length,
    topExpensiveQueries: usageLog.expensiveQueries
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 5)
  };
}

// Save usage data
function saveUsageData() {
  const data = {
    ...usageLog,
    summary: getUsageSummary(),
    exportedAt: new Date().toISOString()
  };
  
  const filePath = path.join(__dirname, 'db-usage-log.json');
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`Usage data saved to ${filePath}`);
}

// Display usage tips
function showUsageTips() {
  console.log(`
=== DATABASE USAGE OPTIMIZATION TIPS ===

1. WAIT FOR QUOTA RESET:
   - Most providers reset daily/monthly
   - Check your provider's dashboard

2. REDUCE QUERY FREQUENCY:
   - Stats queries are now rate-limited (max 10/minute)
   - Categories are cached for 5 minutes
   - Bot config is cached for 5 minutes

3. LIMIT EXPENSIVE OPERATIONS:
   - Recent messages limited to 50 max
   - User messages limited to 25 max
   - Stats queries have rate limiting

4. MONITOR USAGE:
   - Check this script output regularly
   - Look for patterns in expensive queries

5. CONSIDER ALTERNATIVES:
   - Supabase (500MB free, 50k users/month)
   - Railway ($5 credit/month)
   - PlanetScale (1B reads/month free)

6. EMERGENCY MEASURES:
   - Disable stats dashboard temporarily
   - Reduce message history limits
   - Increase cache duration

Current Usage Summary:
${JSON.stringify(getUsageSummary(), null, 2)}
`);
}

// Export for use in other files
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    trackExpensiveQuery,
    getUsageSummary,
    saveUsageData,
    showUsageTips
  };
}

// Run if called directly
if (require.main === module) {
  showUsageTips();
  saveUsageData();
} 