import fetch from 'node-fetch';
import { log } from "../vite";

async function uploadToImgbb(buffer: Buffer): Promise<string | null> {
  try {
    const formData = new URLSearchParams();
    formData.append('image', buffer.toString('base64'));
    formData.append('name', `test_photo_${Date.now()}`);
    // Preserve image quality
    formData.append('quality', '100');
    // Don't auto-resize
    formData.append('width', '0');
    formData.append('height', '0');

    const response = await fetch(`https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`, {
      method: 'POST',
      body: formData,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      }
    });

    if (!response.ok) {
      throw new Error(`ImgBB API error: ${response.status}`);
    }

    const data = await response.json();

    // Log detailed image information
    log(`Successfully uploaded image to ImgBB:
    Original size: ${buffer.length} bytes
    URL: ${data.data.url}
    Display URL: ${data.data.display_url}
    Size: ${data.data.size} bytes
    Width: ${data.data.width}px
    Height: ${data.data.height}px
    Type: ${data.data.image.mime}`);

    return data.data.display_url || data.data.url;
  } catch (error) {
    log(`Error uploading to ImgBB: ${error}`, "error");
    return null;
  }
}

// Test image buffer (a 1x1 transparent PNG)
const testImageBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

// Run single test
async function testImgbbUpload() {
  log("Starting single ImgBB upload test...");
  const imageUrl = await uploadToImgbb(testImageBuffer);

  if (imageUrl) {
    log("✅ ImgBB upload test successful! URL:", imageUrl);
  } else {
    log("❌ ImgBB upload test failed!");
  }
}

// Run concurrent tests - simulate multiple users uploading at the same time
async function testConcurrentUploads(count: number) {
  log(`Starting concurrent ImgBB upload test with ${count} uploads...`);
  
  const startTime = Date.now();
  const memoryBefore = process.memoryUsage().heapUsed / 1024 / 1024;
  log(`Memory usage before test: ${memoryBefore.toFixed(2)} MB`);
  
  // Create an array of promises
  const uploads = Array.from({ length: count }, () => uploadToImgbb(testImageBuffer));
  
  // Wait for all uploads to complete
  const results = await Promise.all(uploads);
  
  // Check results
  const successful = results.filter(Boolean).length;
  const failed = count - successful;
  
  const endTime = Date.now();
  const memoryAfter = process.memoryUsage().heapUsed / 1024 / 1024;
  
  log(`
Concurrent upload test results:
✅ Successful: ${successful}
❌ Failed: ${failed}
⏱️ Time taken: ${(endTime - startTime) / 1000} seconds
💾 Memory before: ${memoryBefore.toFixed(2)} MB
💾 Memory after: ${memoryAfter.toFixed(2)} MB
💾 Memory difference: ${(memoryAfter - memoryBefore).toFixed(2)} MB
  `);
  
  // Force garbage collection if possible and check memory again
  if (global.gc) {
    global.gc();
    const memoryAfterGC = process.memoryUsage().heapUsed / 1024 / 1024;
    log(`💾 Memory after GC: ${memoryAfterGC.toFixed(2)} MB`);
    log(`💾 Memory difference after GC: ${(memoryAfterGC - memoryBefore).toFixed(2)} MB`);
  }
}

// Run the tests
async function runTests() {
  try {
    // First run a single test
    await testImgbbUpload();
    
    // Then run concurrent tests
    await testConcurrentUploads(5);  // Try with 5 concurrent uploads
  } catch (error) {
    log("Error running tests:", error);
  }
}

runTests();