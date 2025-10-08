#!/usr/bin/env node

/**
 * Get Server IP Address Utility
 * 
 * This script helps you find your server's IP address so you can access
 * your bot from other devices on the network.
 */

const os = require('os');

function getServerIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];

  console.log('🌐 Your Server IP Addresses:\n');

  for (const [name, addresses] of Object.entries(interfaces)) {
    // Skip loopback and internal interfaces
    if (name.includes('lo') || name.includes('docker') || name.includes('veth')) {
      continue;
    }

    for (const address of addresses) {
      // Only show IPv4 addresses that are not internal
      if (address.family === 'IPv4' && !address.internal) {
        ips.push({
          interface: name,
          ip: address.ip,
          mac: address.mac
        });
      }
    }
  }

  if (ips.length === 0) {
    console.log('❌ No external IP addresses found.');
    console.log('💡 Make sure your server is connected to a network.');
    return;
  }

  // Display the IPs
  ips.forEach((ip, index) => {
    console.log(`📡 Interface: ${ip.interface}`);
    console.log(`   IP Address: ${ip.ip}`);
    console.log(`   MAC Address: ${ip.mac}`);
    console.log(`   Bot URL: http://${ip.ip}:5000`);
    console.log('');
  });

  // Show the most likely IP to use
  const primaryIP = ips[0];
  console.log('🎯 Most likely IP to use:');
  console.log(`   http://${primaryIP.ip}:5000`);
  console.log('');
  
  console.log('📋 Quick Access URLs:');
  ips.forEach(ip => {
    console.log(`   • http://${ip.ip}:5000`);
  });
  console.log('');
  
  console.log('💡 Tips:');
  console.log('   • Make sure port 5000 is open in your firewall');
  console.log('   • If you can\'t access from other devices, check your firewall settings');
  console.log('   • On Windows: Windows Defender Firewall might be blocking the port');
  console.log('   • On Linux: Check with: sudo ufw status or sudo iptables -L');
}

// Run the script
getServerIPs();
