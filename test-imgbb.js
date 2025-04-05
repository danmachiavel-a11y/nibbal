// Simple script to test ImgBB API integration

import { testSingleUpload } from './server/bot/test-imgbb.ts';

async function runSimpleTest() {
  console.log("Starting ImgBB API test...");
  
  try {
    // Basic test with max 3 retries and 2 second delay between retries
    const result = await testSingleUpload('simple-test', 3, 2000);
    
    if (result.success) {
      console.log("✅ TEST PASSED: ImgBB API is working correctly");
      console.log(`Image URL: ${result.url}`);
      console.log(`Upload time: ${result.elapsedMs}ms`);
    } else {
      console.log("❌ TEST FAILED: ImgBB API is not working");
      console.log(`Error: ${result.error}`);
      console.log(`Status code: ${result.statusCode}`);
      
      if (!process.env.IMGBB_API_KEY) {
        console.log("\n⚠️ IMGBB_API_KEY environment variable is not set!");
        console.log("Please make sure you have set the ImgBB API key correctly.");
      }
    }
  } catch (error) {
    console.error("Error running test:", error);
  }
}

runSimpleTest().catch(console.error);