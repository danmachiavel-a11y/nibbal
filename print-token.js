// Simple script to print token information
import fs from 'fs';
import dotenv from 'dotenv';

console.log("===== TOKEN INSPECTOR =====");

// Read env directly from file
try {
  const envContent = fs.readFileSync('.env', 'utf8');
  const envLines = envContent.split('\n');
  const tokenLine = envLines.find(line => line.startsWith('DISCORD_BOT_TOKEN='));
  
  if (tokenLine) {
    const fileToken = tokenLine.replace('DISCORD_BOT_TOKEN=', '').trim();
    console.log("TOKEN FROM .ENV FILE:");
    console.log(`Length: ${fileToken.length}`);
    console.log(`First 10 chars: ${fileToken.substring(0, 10)}...`);
    console.log(`Last 10 chars: ...${fileToken.substring(fileToken.length - 10)}`);
  } else {
    console.log("No Discord token found in .env file");
  }
} catch (err) {
  console.error("Error reading .env file:", err);
}

// Read from environment
dotenv.config();
const envToken = process.env.DISCORD_BOT_TOKEN;

if (envToken) {
  console.log("\nTOKEN FROM PROCESS.ENV:");
  console.log(`Length: ${envToken.length}`);
  console.log(`First 10 chars: ${envToken.substring(0, 10)}...`);
  console.log(`Last 10 chars: ...${envToken.substring(envToken.length - 10)}`);
} else {
  console.log("\nNo Discord token found in process.env");
}

// Test if token conforms to standard format
const tokenRegex = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
if (envToken) {
  console.log(`\nToken format valid: ${tokenRegex.test(envToken)}`);
  
  const sections = envToken.split('.');
  if (sections.length === 3) {
    console.log('Token has 3 sections separated by dots, which is correct');
    console.log(`Section 1 length: ${sections[0].length}`);
    console.log(`Section 2 length: ${sections[1].length}`);
    console.log(`Section 3 length: ${sections[2].length}`);
  } else {
    console.log(`Token has ${sections.length} sections, but should have 3`);
  }
}