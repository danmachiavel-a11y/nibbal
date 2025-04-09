// Simplified ImgBB API test that doesn't rely on importing TypeScript

import fetch from 'node-fetch';
import FormData from 'form-data';

// Test image (1x1 transparent PNG)
const TEST_IMAGE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

async function testImgBB() {
  console.log("Starting simple ImgBB API test...");
  const startTime = Date.now();

  try {
    // Check for API key
    const apiKey = process.env.IMGBB_API_KEY;
    if (!apiKey) {
      console.error("ERROR: IMGBB_API_KEY environment variable is not set!");
      console.log("Please set the ImgBB API key to continue.");
      return;
    }

    // Create form data
    const formData = new FormData();
    formData.append('image', TEST_IMAGE.toString('base64'));
    formData.append('name', `test_${Date.now()}`);

    // Build URL with API key
    const url = `https://api.imgbb.com/1/upload?key=${apiKey}`;
    console.log(`Using ImgBB API with key: ${apiKey.substring(0, 3)}...${apiKey.substring(apiKey.length - 3)}`);

    // Make the request
    console.log("Sending request to ImgBB API...");
    const response = await fetch(url, {
      method: 'POST',
      body: formData
    });

    // Get response
    const data = await response.json();
    const elapsed = Date.now() - startTime;

    // Check if successful
    if (response.ok && data.success) {
      console.log(`✅ SUCCESS: Uploaded test image in ${elapsed}ms`);
      console.log(`Image URL: ${data.data.url}`);
      console.log(`Display URL: ${data.data.display_url}`);
      console.log(`Image size: ${data.data.size} bytes`);
      console.log(`Width x Height: ${data.data.width}x${data.data.height}`);
    } else {
      console.log(`❌ FAILED: ImgBB API returned error`);
      console.log(`Status: ${response.status} ${response.statusText}`);
      console.log(`Error message: ${data.error?.message || data.message || "Unknown error"}`);
    }

  } catch (error) {
    console.error("❌ ERROR: Failed to test ImgBB API:", error.message);
  }
}

testImgBB().catch(console.error);