#!/usr/bin/env node

/**
 * Test Network Access Utility
 * 
 * This script tests if your bot server is accessible from the network
 * and provides helpful debugging information.
 */

const http = require('http');
const os = require('os');

function getServerIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];

  for (const [name, addresses] of Object.entries(interfaces)) {
    if (name.includes('lo') || name.includes('docker') || name.includes('veth')) {
      continue;
    }

    for (const address of addresses) {
      if (address.family === 'IPv4' && !address.internal) {
        ips.push(address.ip);
      }
    }
  }

  return ips;
}

function testEndpoint(url, description) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          success: true,
          status: res.statusCode,
          description,
          url
        });
      });
    });

    req.on('error', (error) => {
      resolve({
        success: false,
        error: error.message,
        description,
        url
      });
    });

    req.setTimeout(5000, () => {
      req.destroy();
      resolve({
        success: false,
        error: 'Request timeout',
        description,
        url
      });
    });
  });
}

async function testNetworkAccess() {
  console.log('🧪 Testing Network Access to Bot Server...\n');

  const serverIPs = getServerIPs();
  const port = process.env.PORT || 5000;

  if (serverIPs.length === 0) {
    console.log('❌ No external IP addresses found.');
    console.log('💡 Make sure your server is connected to a network.');
    return;
  }

  console.log(`📡 Found ${serverIPs.length} IP address(es):`);
  serverIPs.forEach(ip => console.log(`   • ${ip}`));
  console.log('');

  // Test localhost first
  console.log('🔍 Testing localhost access...');
  const localhostTest = await testEndpoint(`http://localhost:${port}/api/health`, 'Localhost Health Check');
  
  if (localhostTest.success) {
    console.log(`✅ Localhost: ${localhostTest.status} - Server is running locally`);
  } else {
    console.log(`❌ Localhost: ${localhostTest.error}`);
    console.log('💡 Make sure your bot server is running!');
    return;
  }

  console.log('\n🌐 Testing network access...');
  
  // Test each IP address
  for (const ip of serverIPs) {
    const networkTest = await testEndpoint(`http://${ip}:${port}/api/health`, `Network Health Check (${ip})`);
    
    if (networkTest.success) {
      console.log(`✅ ${ip}:${port} - Accessible from network`);
    } else {
      console.log(`❌ ${ip}:${port} - ${networkTest.error}`);
    }
  }

  console.log('\n📋 Summary:');
  console.log(`   Local access: http://localhost:${port}`);
  serverIPs.forEach(ip => {
    console.log(`   Network access: http://${ip}:${port}`);
  });

  console.log('\n💡 Troubleshooting:');
  console.log('   • If network access fails, check your firewall settings');
  console.log('   • Make sure port 5000 is open in your firewall');
  console.log('   • Ensure devices are on the same network');
  console.log('   • Try accessing from another device on the network');

  console.log('\n🔧 Debug endpoints:');
  console.log(`   • Health check: http://localhost:${port}/api/health`);
  console.log(`   • Network info: http://localhost:${port}/api/network-info`);
}

// Run the test
testNetworkAccess().then(() => {
  console.log('\n🏁 Network access test completed');
  process.exit(0);
}).catch(error => {
  console.error('💥 Test failed:', error);
  process.exit(1);
});
