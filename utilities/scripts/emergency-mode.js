#!/usr/bin/env node

/**
 * Emergency Mode Script
 * Temporarily disables expensive database operations when quota is exceeded
 */

const fs = require('fs');
const path = require('path');

const EMERGENCY_CONFIG_PATH = path.join(__dirname, '..', '..', 'emergency-config.json');

// Default emergency configuration
const defaultEmergencyConfig = {
  enabled: false,
  disabledFeatures: {
    statsDashboard: false,
    messageHistory: false,
    userStats: false,
    workerStats: false,
    recentMessages: false
  },
  limits: {
    maxMessagesPerQuery: 10,
    maxStatsQueriesPerHour: 5,
    cacheDurationMinutes: 30
  },
  message: "Emergency mode is active. Some features are temporarily disabled to save database compute time."
};

// Load emergency configuration
function loadEmergencyConfig() {
  try {
    if (fs.existsSync(EMERGENCY_CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(EMERGENCY_CONFIG_PATH, 'utf8'));
      return { ...defaultEmergencyConfig, ...config };
    }
  } catch (error) {
    console.error('Error loading emergency config:', error);
  }
  return defaultEmergencyConfig;
}

// Save emergency configuration
function saveEmergencyConfig(config) {
  try {
    fs.writeFileSync(EMERGENCY_CONFIG_PATH, JSON.stringify(config, null, 2));
    console.log('Emergency configuration saved');
  } catch (error) {
    console.error('Error saving emergency config:', error);
  }
}

// Enable emergency mode
function enableEmergencyMode() {
  const config = loadEmergencyConfig();
  config.enabled = true;
  config.disabledFeatures = {
    statsDashboard: true,
    messageHistory: true,
    userStats: true,
    workerStats: true,
    recentMessages: true
  };
  config.limits = {
    maxMessagesPerQuery: 5,
    maxStatsQueriesPerHour: 1,
    cacheDurationMinutes: 60
  };
  config.message = "EMERGENCY MODE: Database quota exceeded. Features disabled to save compute time.";
  
  saveEmergencyConfig(config);
  console.log('🚨 Emergency mode ENABLED');
  console.log('Features disabled: Stats dashboard, message history, user stats');
  console.log('Limits reduced: Max 5 messages per query, 1 stats query per hour');
  console.log('Cache extended: 60 minutes');
}

// Disable emergency mode
function disableEmergencyMode() {
  const config = loadEmergencyConfig();
  config.enabled = false;
  config.disabledFeatures = {
    statsDashboard: false,
    messageHistory: false,
    userStats: false,
    workerStats: false,
    recentMessages: false
  };
  config.limits = {
    maxMessagesPerQuery: 50,
    maxStatsQueriesPerHour: 10,
    cacheDurationMinutes: 5
  };
  config.message = "Emergency mode disabled. All features restored.";
  
  saveEmergencyConfig(config);
  console.log('✅ Emergency mode DISABLED');
  console.log('All features restored to normal operation');
}

// Show current status
function showStatus() {
  const config = loadEmergencyConfig();
  console.log('\n=== EMERGENCY MODE STATUS ===');
  console.log(`Status: ${config.enabled ? '🚨 ENABLED' : '✅ DISABLED'}`);
  console.log(`Message: ${config.message}`);
  
  if (config.enabled) {
    console.log('\nDisabled Features:');
    Object.entries(config.disabledFeatures).forEach(([feature, disabled]) => {
      console.log(`  ${feature}: ${disabled ? '❌ DISABLED' : '✅ ENABLED'}`);
    });
    
    console.log('\nCurrent Limits:');
    Object.entries(config.limits).forEach(([limit, value]) => {
      console.log(`  ${limit}: ${value}`);
    });
  }
  
  console.log('\nCommands:');
  console.log('  node emergency-mode.js enable  - Enable emergency mode');
  console.log('  node emergency-mode.js disable - Disable emergency mode');
  console.log('  node emergency-mode.js status  - Show current status');
}

// Main function
function main() {
  const command = process.argv[2];
  
  switch (command) {
    case 'enable':
      enableEmergencyMode();
      break;
    case 'disable':
      disableEmergencyMode();
      break;
    case 'status':
    default:
      showStatus();
      break;
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = {
  loadEmergencyConfig,
  saveEmergencyConfig,
  enableEmergencyMode,
  disableEmergencyMode
}; 