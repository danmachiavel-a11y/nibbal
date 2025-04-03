import fetch, { RequestInit, Response } from 'node-fetch';
import { log } from "../vite";
// Import normal setTimeout/clearTimeout from Node.js
import { setTimeout as asyncSetTimeout } from 'timers/promises';

interface ImgBBResponse {
  data?: {
    url: string;
    display_url: string;
    size: number;
    width: number;
    height: number;
    image: {
      mime: string;
    };
  };
  success?: boolean;
  error?: {
    message: string;
    code: number;
  };
  message?: string;
  status?: number;
}

interface UploadResult {
  success: boolean;
  url?: string;
  error?: string;
  statusCode?: number;
  responseBody?: any;
  attemptNumber: number;
}

async function uploadToImgbb(buffer: Buffer, testId: string, attemptNumber: number = 1): Promise<UploadResult> {
  const startTime = Date.now();
  
  try {
    const formData = new URLSearchParams();
    formData.append('image', buffer.toString('base64'));
    formData.append('name', `test_${testId}_${Date.now()}`);
    formData.append('quality', '100');  // Preserve image quality
    formData.append('width', '0');      // Don't auto-resize
    formData.append('height', '0');     // Don't auto-resize

    // Add API key to URL
    const apiKey = process.env.IMGBB_API_KEY;
    if (!apiKey) {
      throw new Error('IMGBB_API_KEY is not defined');
    }
    
    const url = `https://api.imgbb.com/1/upload?key=${apiKey}`;
    
    // Log request start with unique ID
    log(`[${testId}] Starting ImgBB upload (attempt ${attemptNumber})...`);
    
    // Create a request options object
    const requestOptions: RequestInit = {
      method: 'POST',
      body: formData,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      }
    };
    
    // Set up an AbortController with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000) as unknown as number;
    requestOptions.signal = controller.signal;
    
    // Use AbortController for timeout
    const response = await fetch(url, requestOptions);
    clearTimeout(timeoutId); // Clear the timeout if fetch completes
    
    // Get response body in text form first
    const responseText = await response.text();
    let responseData: ImgBBResponse;
    
    try {
      // Then parse as JSON
      responseData = JSON.parse(responseText);
    } catch (parseError) {
      // If can't parse as JSON, return raw text
      return {
        success: false,
        error: `Failed to parse response as JSON: ${parseError}`,
        statusCode: response.status,
        responseBody: responseText,
        attemptNumber
      };
    }
    
    const elapsed = Date.now() - startTime;
    
    if (!response.ok) {
      // Detailed non-successful response
      return {
        success: false,
        error: responseData.error?.message || 
               responseData.message || 
               `HTTP Error: ${response.status} ${response.statusText}`,
        statusCode: response.status,
        responseBody: responseData,
        attemptNumber
      };
    }
    
    if (!responseData.success || !responseData.data) {
      // API returned success: false or no data
      return {
        success: false,
        error: 'ImgBB API returned success: false or no data',
        statusCode: response.status,
        responseBody: responseData,
        attemptNumber
      };
    }
    
    // Log detailed image information
    log(`[${testId}] ✅ Successfully uploaded image to ImgBB (${elapsed}ms):
    URL: ${responseData.data.url}
    Display URL: ${responseData.data.display_url}
    Size: ${responseData.data.size} bytes
    Width: ${responseData.data.width}px
    Height: ${responseData.data.height}px
    Type: ${responseData.data.image?.mime || 'unknown'}`);

    return {
      success: true,
      url: responseData.data.display_url || responseData.data.url,
      statusCode: response.status,
      attemptNumber
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`[${testId}] ❌ Error uploading to ImgBB: ${errorMessage}`, "error");
    
    return {
      success: false,
      error: errorMessage,
      attemptNumber
    };
  }
}

// Create a test image buffer (a 1x1 transparent PNG)
const smallTestImageBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

// Create a slightly larger test image (16x16 colored square)
const mediumTestImageBuffer = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABGdBTUEAALGPC/xhBQAAAAFzUkdCAK7OHOkAAAAgY0hSTQAAeiYAAICEAAD6AAAAgOgAAHUwAADqYAAAOpgAABdwnLpRPAAAADxJREFUOI1jZGBgYBhk+P///38GBgYGRhgDA4NKAD7FMPwfihtAin+QPQiyBZmPrAfmApg3cLkQqwoG+gAAXq0KCSvIBccAAAAASUVORK5CYII=',
  'base64'
);

// Test single upload with retry support
async function testSingleUpload(testId: string, maxRetries: number = 3, retryDelay: number = 2000) {
  log(`[${testId}] 🔄 Starting single ImgBB upload test with ${maxRetries} max retries...`);
  
  let lastResult: UploadResult | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    lastResult = await uploadToImgbb(smallTestImageBuffer, testId, attempt);
    
    if (lastResult.success) {
      log(`[${testId}] ✅ ImgBB upload succeeded on attempt ${attempt}!`);
      return lastResult;
    }
    
    const isRateLimit = lastResult.statusCode === 429 || 
                        (lastResult.error && lastResult.error.includes('rate limit'));
    
    if (isRateLimit) {
      const waitTime = retryDelay * Math.pow(2, attempt - 1); // Exponential backoff
      log(`[${testId}] 🕒 Rate limit detected. Waiting ${waitTime}ms before retry ${attempt+1}/${maxRetries}...`);
      await asyncSetTimeout(waitTime);
    } else if (attempt < maxRetries) {
      log(`[${testId}] ⚠️ Upload failed with error: ${lastResult.error}. Retrying (${attempt+1}/${maxRetries})...`);
      await asyncSetTimeout(retryDelay);
    } else {
      log(`[${testId}] ❌ Upload failed after ${maxRetries} attempts. Last error: ${lastResult.error}`);
    }
  }
  
  return lastResult!;
}

// Run concurrent tests with different strategies
async function testConcurrentUploads(count: number, strategy: 'all-at-once' | 'batched' | 'sequential' = 'all-at-once', batchSize: number = 2) {
  const testId = `concurrent-${Date.now()}`;
  log(`[${testId}] 🔄 Starting ${strategy} ImgBB upload test with ${count} uploads...`);
  
  const startTime = Date.now();
  const memoryBefore = process.memoryUsage().heapUsed / 1024 / 1024;
  
  const results: UploadResult[] = [];
  
  if (strategy === 'all-at-once') {
    // Launch all uploads at once
    const uploads = Array.from({ length: count }, (_, i) => 
      uploadToImgbb(mediumTestImageBuffer, `${testId}-${i+1}`)
    );
    
    // Wait for all uploads to complete
    const uploadResults = await Promise.all(uploads);
    results.push(...uploadResults);
  } 
  else if (strategy === 'batched') {
    // Process in batches
    for (let i = 0; i < count; i += batchSize) {
      const batch = Array.from({ length: Math.min(batchSize, count - i) }, (_, j) => 
        uploadToImgbb(mediumTestImageBuffer, `${testId}-${i+j+1}`)
      );
      
      const batchResults = await Promise.all(batch);
      results.push(...batchResults);
      
      if (i + batchSize < count) {
        // Wait between batches to avoid rate limits
        await asyncSetTimeout(2000);
      }
    }
  } 
  else if (strategy === 'sequential') {
    // Process one at a time
    for (let i = 0; i < count; i++) {
      const result = await uploadToImgbb(mediumTestImageBuffer, `${testId}-${i+1}`);
      results.push(result);
      
      if (i < count - 1) {
        // Wait between uploads
        await asyncSetTimeout(1000);
      }
    }
  }
  
  // Analyze results
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  
  // Group failures by error type
  const errorTypes = results.filter(r => !r.success).reduce((acc, curr) => {
    const errorType = curr.statusCode === 429 ? 'Rate Limit (429)' : 
                     curr.error?.includes('timeout') ? 'Timeout' :
                     curr.statusCode ? `HTTP ${curr.statusCode}` : 'Other';
    
    acc[errorType] = (acc[errorType] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  
  const endTime = Date.now();
  const elapsed = (endTime - startTime) / 1000;
  const memoryAfter = process.memoryUsage().heapUsed / 1024 / 1024;
  
  log(`
[${testId}] 📊 ${strategy.toUpperCase()} Upload Test Results:
✅ Successful: ${successful}/${count} (${(successful/count*100).toFixed(1)}%)
❌ Failed: ${failed}/${count} (${(failed/count*100).toFixed(1)}%)
⏱️ Time taken: ${elapsed.toFixed(2)} seconds
🚀 Average speed: ${(count/elapsed).toFixed(2)} uploads/second
💾 Memory usage: ${(memoryAfter - memoryBefore).toFixed(2)} MB increase

🔍 Failure Analysis:
${Object.entries(errorTypes).map(([type, count]) => `  - ${type}: ${count}`).join('\n')}
  `);
  
  return {
    successful,
    failed,
    errorTypes,
    elapsed
  };
}

// Test with a delay between multiple uploads
async function testRateLimitRecovery() {
  const testId = `rate-limit-recovery-${Date.now()}`;
  log(`[${testId}] 🔄 Testing ImgBB rate limit recovery...`);
  
  // First, try a bunch of uploads to hit the rate limit
  log(`[${testId}] Step 1: Attempting to hit rate limit with 10 concurrent uploads...`);
  const firstResult = await testConcurrentUploads(10, 'all-at-once');
  
  // Wait for rate limit to reset
  const waitTime = 30000; // 30 seconds
  log(`[${testId}] Step 2: Waiting ${waitTime/1000} seconds for rate limit to reset...`);
  await asyncSetTimeout(waitTime);
  
  // Try a single upload to see if we can upload again
  log(`[${testId}] Step 3: Testing if rate limit has reset with a single upload...`);
  const recoveryResult = await testSingleUpload(`${testId}-recovery`);
  
  // Then try a small batch with a better strategy
  log(`[${testId}] Step 4: Testing optimized upload strategy (batched)...`);
  const optimizedResult = await testConcurrentUploads(5, 'batched', 2);
  
  log(`
[${testId}] 📈 Rate Limit Recovery Test Summary:
Initial batch: ${firstResult.successful}/${firstResult.successful + firstResult.failed} successful
After waiting: ${recoveryResult.success ? 'Recovered' : 'Still limited'}
Optimized strategy: ${optimizedResult.successful}/${optimizedResult.successful + optimizedResult.failed} successful
  `);
}

// Run a series of tests
async function runTests() {
  try {
    log("🧪 Starting ImgBB API Tests\n" + "=".repeat(40));
    
    // Verify single upload works
    log("\n📋 TEST 1: Verify basic upload functionality");
    await testSingleUpload('basic-test');
    
    // Test concurrent uploads with different strategies
    log("\n📋 TEST 2: Test all-at-once concurrent uploads");
    await testConcurrentUploads(5, 'all-at-once');
    
    log("\n📋 TEST 3: Test batched concurrent uploads");
    await testConcurrentUploads(5, 'batched', 2);
    
    log("\n📋 TEST 4: Test sequential uploads");
    await testConcurrentUploads(5, 'sequential');
    
    // Test rate limit recovery
    log("\n📋 TEST 5: Test rate limit recovery");
    await testRateLimitRecovery();
    
    log("\n✅ All tests completed!");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("❌ Error running tests:", errorMessage);
  }
}

// Export utilities for external use
export {
  uploadToImgbb,
  testSingleUpload,
  testConcurrentUploads
};

// Run all tests if this file is executed directly
// In ES modules, we can check the import.meta.url to determine if this is the main module
const isMainModule = import.meta.url.endsWith('test-imgbb.ts');
if (isMainModule) {
  runTests();
}