import fetch, { RequestInit, Response } from 'node-fetch';
import { log } from "../vite";
// Import async setTimeout for better promise handling
import { setTimeout as asyncSetTimeout } from 'timers/promises';
// Import normal setTimeout for use with clearTimeout
import { setTimeout, clearTimeout } from 'timers';
// Import the bridge version of uploadToImgbb for comparison testing
import path from 'path';
import fs from 'fs';

// Define interfaces to ensure consistency
interface ImgBBResponse {
  data?: {
    url: string;
    display_url: string;
    size: number;
    width: number;
    height: number;
    time: number;
    expiration: number;
    image: {
      filename: string;
      name: string;
      mime: string;
      extension: string;
      url: string;
    };
    thumb?: {
      filename: string;
      name: string;
      mime: string;
      extension: string;
      url: string;
    };
    delete_url?: string;
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
  elapsedMs: number;
}

// Test images of different sizes for thorough testing
const TINY_TEST_IMAGE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'); // 67 bytes, 1x1 transparent PNG
const SMALL_TEST_IMAGE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABGdBTUEAALGPC/xhBQAAAAFzUkdCAK7OHOkAAAAgY0hSTQAAeiYAAICEAAD6AAAAgOgAAHUwAADqYAAAOpgAABdwnLpRPAAAADxJREFUOI1jZGBgYBhk+P///38GBgYGRhgDA4NKAD7FMPwfihtAin+QPQiyBZmPrAfmApg3cLkQqwoG+gAAXq0KCSvIBccAAAAASUVORK5CYII=', 'base64'); // 222 bytes, 16x16 colored PNG
const MEDIUM_TEST_IMAGE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAnElEQVR42u3RAQ0AAAjDMO5fNCCDkC5z0HSOmIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIh8XqsyAcbmyxinAAAAAElFTkSuQmCC',
  'base64'
); // ~1KB, 100x100 transparent PNG

// Complex test image with gradients and shapes (about 5KB)
const COMPLEX_TEST_IMAGE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAACXBIWXMAAAsTAAALEwEAmpwYAAAF7mlUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPD94cGFja2V0IGJlZ2luPSLvu78iIGlkPSJXNU0wTXBDZWhpSHpyZVN6TlRjemtjOWQiPz4gPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iQWRvYmUgWE1QIENvcmUgNS42LWMxNDUgNzkuMTYzNDk5LCAyMDE4LzA4LzEzLTE2OjQwOjIyICAgICAgICAiPiA8cmRmOlJERiB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiPiA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIiB4bWxuczp4bXA9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC8iIHhtbG5zOmRjPSJodHRwOi8vcHVybC5vcmcvZGMvZWxlbWVudHMvMS4xLyIgeG1sbnM6cGhvdG9zaG9wPSJodHRwOi8vbnMuYWRvYmUuY29tL3Bob3Rvc2hvcC8xLjAvIiB4bWxuczp4bXBNTT0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLyIgeG1sbnM6c3RFdnQ9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZUV2ZW50IyIgeG1wOkNyZWF0b3JUb29sPSJBZG9iZSBQaG90b3Nob3AgQ0MgMjAxOSAoTWFjaW50b3NoKSIgeG1wOkNyZWF0ZURhdGU9IjIwMTktMDMtMjJUMTg6MjA6MjQtMDc6MDAiIHhtcDpNb2RpZnlEYXRlPSIyMDE5LTAzLTIyVDE4OjIxOjQyLTA3OjAwIiB4bXA6TWV0YWRhdGFEYXRlPSIyMDE5LTAzLTIyVDE4OjIxOjQyLTA3OjAwIiBkYzpmb3JtYXQ9ImltYWdlL3BuZyIgcGhvdG9zaG9wOkNvbG9yTW9kZT0iMyIgcGhvdG9zaG9wOklDQ1Byb2ZpbGU9InNSR0IgSUVDNjE5NjYtMi4xIiB4bXBNTTpJbnN0YW5jZUlEPSJ4bXAuaWlkOjRmMzk4NzJiLTdlMDUtNGU0Yy1iYjI4LWM2YjRkNTQ5ZDYxMCIgeG1wTU06RG9jdW1lbnRJRD0iYWRvYmU6ZG9jaWQ6cGhvdG9zaG9wOjk2N2VlYzNiLTE0OTMtYzk0Yi1hMGE1LWZkYjg3ZjRkY2Q0ZCIgeG1wTU06T3JpZ2luYWxEb2N1bWVudElEPSJ4bXAuZGlkOmQ4ZGY5MDk2LWE5ZjctNGZiZS1hZGMyLTA0ODRjMDQwYzc4MyI+IDx4bXBNTTpIaXN0b3J5PiA8cmRmOlNlcT4gPHJkZjpsaSBzdEV2dDphY3Rpb249ImNyZWF0ZWQiIHN0RXZ0Omluc3RhbmNlSUQ9InhtcC5paWQ6ZDhkZjkwOTYtYTlmNy00ZmJlLWFkYzItMDQ4NGMwNDBjNzgzIiBzdEV2dDp3aGVuPSIyMDE5LTAzLTIyVDE4OjIwOjI0LTA3OjAwIiBzdEV2dDpzb2Z0d2FyZUFnZW50PSJBZG9iZSBQaG90b3Nob3AgQ0MgMjAxOSAoTWFjaW50b3NoKSIvPiA8cmRmOmxpIHN0RXZ0OmFjdGlvbj0ic2F2ZWQiIHN0RXZ0Omluc3RhbmNlSUQ9InhtcC5paWQ6NGYzOTg3MmItN2UwNS00ZTRjLWJiMjgtYzZiNGQ1NDlkNjEwIiBzdEV2dDp3aGVuPSIyMDE5LTAzLTIyVDE4OjIxOjQyLTA3OjAwIiBzdEV2dDpzb2Z0d2FyZUFnZW50PSJBZG9iZSBQaG90b3Nob3AgQ0MgMjAxOSAoTWFjaW50b3NoKSIgc3RFdnQ6Y2hhbmdlZD0iLyIvPiA8L3JkZjpTZXE+IDwveG1wTU06SGlzdG9yeT4gPC9yZGY6RGVzY3JpcHRpb24+IDwvcmRmOlJERj4gPC94OnhtcG1ldGE+IDw/eHBhY2tldCBlbmQ9InIiPz733LCGAAAJPklEQVR42u2dW2wcVxnHfzvrtde7XsdJHN/iNIlz07UoNCVKK4SKNsoDAqk8ICEBX3gDIXjIAyAQUoV44AFEJSSQUFPaClFKEwmVCxKBticbiXZTBDiKKkocO7Hr6/q61+PdnQNnxuPZ2Z3ZnfXOxc5fOrLeOXPmzPnOf77v+84ZK9BsNokoSzb6C0QIRQhFCEUIRQhFCEUIRQhFNgv5uPmcG4xNjA65vp8oLi6z5t1kcXEZ05xnrWkSMlOYZhlzaZ6J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',
  'base64'
); // ~5KB, 100x100 colored PNG

// Enhanced uploadToImgbb function with better error handling and retry capabilities
async function uploadToImgbb(buffer: Buffer, testId: string, attemptNumber: number = 1): Promise<UploadResult> {
  const startTime = Date.now();
  
  try {
    // Ensure the buffer is valid
    if (!buffer || buffer.length < 32) {
      return {
        success: false,
        error: 'Invalid image buffer (too small)',
        attemptNumber,
        elapsedMs: Date.now() - startTime
      };
    }
    
    if (buffer.length > 10 * 1024 * 1024) {
      return {
        success: false,
        error: 'Image too large (max 10MB)',
        attemptNumber,
        elapsedMs: Date.now() - startTime
      };
    }
    
    // Create form data
    const formData = new URLSearchParams();
    formData.append('image', buffer.toString('base64'));
    formData.append('name', `test_${testId}_${Date.now()}`);
    formData.append('quality', '100');  // Preserve image quality
    formData.append('width', '0');      // Don't auto-resize
    formData.append('height', '0');     // Don't auto-resize
    
    // Get API key
    const apiKey = process.env.IMGBB_API_KEY;
    if (!apiKey) {
      return {
        success: false,
        error: 'IMGBB_API_KEY is not defined in environment variables',
        attemptNumber,
        elapsedMs: Date.now() - startTime
      };
    }
    
    const url = `https://api.imgbb.com/1/upload?key=${apiKey}`;
    
    // Log request start
    log(`[${testId}] Starting ImgBB upload (attempt ${attemptNumber})...`);
    
    // Create request options
    const requestOptions: RequestInit = {
      method: 'POST',
      body: formData,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      }
    };
    
    // Set up timeout with AbortController
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000) as unknown as number;
    requestOptions.signal = controller.signal;
    
    // Make the request
    const response = await fetch(url, requestOptions);
    clearTimeout(timeoutId);
    
    // Get response body in text form first
    const responseText = await response.text();
    let responseData: ImgBBResponse;
    
    try {
      // Parse response as JSON
      responseData = JSON.parse(responseText);
    } catch (parseError) {
      return {
        success: false,
        error: `Failed to parse response as JSON: ${parseError}`,
        statusCode: response.status,
        responseBody: responseText,
        attemptNumber,
        elapsedMs: Date.now() - startTime
      };
    }
    
    const elapsed = Date.now() - startTime;
    
    // Handle non-successful response
    if (!response.ok) {
      return {
        success: false,
        error: responseData.error?.message || 
               responseData.message || 
               `HTTP Error: ${response.status} ${response.statusText}`,
        statusCode: response.status,
        responseBody: responseData,
        attemptNumber,
        elapsedMs: elapsed
      };
    }
    
    // Ensure response has expected data
    if (!responseData.success || !responseData.data) {
      return {
        success: false,
        error: 'ImgBB API returned success: false or no data',
        statusCode: response.status,
        responseBody: responseData,
        attemptNumber,
        elapsedMs: elapsed
      };
    }
    
    // Log success
    log(`[${testId}] ✅ Successfully uploaded image to ImgBB (${elapsed}ms):
    URL: ${responseData.data.url}
    Display URL: ${responseData.data.display_url}
    Size: ${responseData.data.size} bytes
    Width: ${responseData.data.width}px
    Height: ${responseData.data.height}px
    Type: ${responseData.data.image?.mime || 'unknown'}`);
    
    // Return success
    return {
      success: true,
      url: responseData.data.display_url || responseData.data.url,
      statusCode: response.status,
      attemptNumber,
      elapsedMs: elapsed
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`[${testId}] ❌ Error uploading to ImgBB: ${errorMessage}`, "error");
    
    // Check for specific error types
    const isTimeout = errorMessage.includes('abort') || errorMessage.includes('timeout');
    const elapsedMs = Date.now() - startTime;
    
    return {
      success: false,
      error: isTimeout ? `Request timeout after ${elapsedMs}ms` : errorMessage,
      attemptNumber,
      elapsedMs
    };
  }
}

// Test single upload with retry support
async function testSingleUpload(testId: string, maxRetries: number = 3, retryDelay: number = 2000): Promise<UploadResult> {
  log(`[${testId}] 🔄 Starting single ImgBB upload test with ${maxRetries} max retries...`);
  
  let lastResult: UploadResult | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Upload with medium-sized test image
    lastResult = await uploadToImgbb(SMALL_TEST_IMAGE, testId, attempt);
    
    if (lastResult.success) {
      log(`[${testId}] ✅ ImgBB upload succeeded on attempt ${attempt}!`);
      return lastResult;
    }
    
    // Handle specific error types for retry strategy
    const isRateLimit = lastResult.statusCode === 429 || 
                        (lastResult.error && lastResult.error.includes('rate limit'));
    
    if (isRateLimit) {
      // Use exponential backoff for rate limits
      const waitTime = retryDelay * Math.pow(2, attempt - 1);
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
async function testConcurrentUploads(count: number, strategy: 'all-at-once' | 'batched' | 'sequential' = 'all-at-once', batchSize: number = 2): Promise<{
  successful: number;
  failed: number;
  errorTypes: Record<string, number>;
  elapsed: number;
  successRate: number;
}> {
  const testId = `concurrent-${Date.now()}`;
  log(`[${testId}] 🔄 Starting ${strategy} ImgBB upload test with ${count} uploads...`);
  
  const startTime = Date.now();
  const memoryBefore = process.memoryUsage().heapUsed / 1024 / 1024;
  
  const results: UploadResult[] = [];
  
  if (strategy === 'all-at-once') {
    // Launch all uploads at once
    const uploads = Array.from({ length: count }, (_, i) => 
      uploadToImgbb(SMALL_TEST_IMAGE, `${testId}-${i+1}`)
    );
    
    // Wait for all uploads to complete
    const uploadResults = await Promise.all(uploads);
    results.push(...uploadResults);
  } 
  else if (strategy === 'batched') {
    // Process in batches
    for (let i = 0; i < count; i += batchSize) {
      const batch = Array.from({ length: Math.min(batchSize, count - i) }, (_, j) => 
        uploadToImgbb(SMALL_TEST_IMAGE, `${testId}-${i+j+1}`)
      );
      
      const batchResults = await Promise.all(batch);
      results.push(...batchResults);
      
      if (i + batchSize < count) {
        // Wait between batches to avoid rate limits
        log(`[${testId}] Waiting 2 seconds between batches...`);
        await asyncSetTimeout(2000);
      }
    }
  } 
  else if (strategy === 'sequential') {
    // Process one at a time
    for (let i = 0; i < count; i++) {
      const result = await uploadToImgbb(SMALL_TEST_IMAGE, `${testId}-${i+1}`);
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
  const successRate = successful / count;
  
  // Group failures by error type
  const errorTypes = results.filter(r => !r.success).reduce((acc, curr) => {
    const errorType = curr.statusCode === 429 ? 'Rate Limit (429)' : 
                     curr.statusCode === 403 ? 'Forbidden (403)' :
                     curr.error?.includes('timeout') ? 'Timeout' :
                     curr.statusCode ? `HTTP ${curr.statusCode}` : 'Other';
    
    acc[errorType] = (acc[errorType] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  
  // Calculate performance metrics
  const endTime = Date.now();
  const elapsed = (endTime - startTime) / 1000;
  const memoryAfter = process.memoryUsage().heapUsed / 1024 / 1024;
  const averageTime = results.reduce((sum, r) => sum + r.elapsedMs, 0) / results.length;
  
  // Log detailed test results
  log(`
[${testId}] 📊 ${strategy.toUpperCase()} Upload Test Results:
✅ Successful: ${successful}/${count} (${(successRate*100).toFixed(1)}%)
❌ Failed: ${failed}/${count} (${((1-successRate)*100).toFixed(1)}%)
⏱️ Time taken: ${elapsed.toFixed(2)} seconds
⏱️ Average upload time: ${averageTime.toFixed(2)}ms
🚀 Average speed: ${(count/elapsed).toFixed(2)} uploads/second
💾 Memory usage: ${(memoryAfter - memoryBefore).toFixed(2)} MB increase

🔍 Failure Analysis:
${Object.entries(errorTypes).map(([type, count]) => `  - ${type}: ${count}`).join('\n')}
  `);
  
  return {
    successful,
    failed,
    errorTypes,
    elapsed,
    successRate
  };
}

// Test with different image sizes
async function testImageSizes() {
  const testId = `image-sizes-${Date.now()}`;
  log(`[${testId}] 🔄 Testing ImgBB with different image sizes...`);
  
  const images = [
    { name: 'Tiny (67 bytes)', buffer: TINY_TEST_IMAGE },
    { name: 'Small (222 bytes)', buffer: SMALL_TEST_IMAGE },
    { name: 'Medium (1KB)', buffer: MEDIUM_TEST_IMAGE },
    { name: 'Complex (5KB)', buffer: COMPLEX_TEST_IMAGE }
  ];
  
  const results = [];
  
  for (const image of images) {
    log(`[${testId}] Testing ${image.name} (${image.buffer.length} bytes)...`);
    const result = await uploadToImgbb(image.buffer, `${testId}-${image.name}`);
    results.push({ ...result, name: image.name, size: image.buffer.length });
    
    // Wait between tests
    await asyncSetTimeout(2000);
  }
  
  // Log results
  log(`
[${testId}] 📊 Image Size Test Results:
${results.map(r => `${r.success ? '✅' : '❌'} ${r.name} (${r.size} bytes): ${r.success ? `Success in ${r.elapsedMs}ms` : `Failed - ${r.error}`}`).join('\n')}
  `);
}

// Test with a delay between multiple uploads to check rate limit recovery
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
Initial batch: ${firstResult.successful}/${firstResult.successful + firstResult.failed} successful (${(firstResult.successRate*100).toFixed(1)}%)
After waiting: ${recoveryResult.success ? 'Recovered ✅' : 'Still limited ❌'}
Optimized strategy: ${optimizedResult.successful}/${optimizedResult.successful + optimizedResult.failed} successful (${(optimizedResult.successRate*100).toFixed(1)}%)

Recommended approach: ${optimizedResult.successRate > firstResult.successRate ? 'The batched approach is more effective' : 'Consider longer delays between uploads'}
  `);
  
  return {
    initialSuccessRate: firstResult.successRate,
    recoverySucceeded: recoveryResult.success,
    optimizedSuccessRate: optimizedResult.successRate
  };
}

// Run a comparison to test bridge.ts implementation 
async function compareWithBridgeImplementation() {
  try {
    // Import the bridge version directly to fix import issue
    const { uploadToImgbb: bridgeUploadToImgbb } = await import('./bridge');
    
    if (!bridgeUploadToImgbb) {
      log('❌ Could not find uploadToImgbb function in bridge.ts', 'error');
      return;
    }
    
    const testId = `bridge-comparison-${Date.now()}`;
    log(`[${testId}] 🔄 Comparing test-imgbb vs bridge implementations...`);
    
    // Run a single upload with each implementation
    const testStartTime = Date.now();
    
    // Test function
    const testResult = await testSingleUpload(`${testId}-test`);
    await asyncSetTimeout(2000);
    
    // Bridge function
    log(`[${testId}] Testing bridge.ts uploadToImgbb implementation...`);
    const bridgeStartTime = Date.now();
    let bridgeResult: any;
    try {
      const url = await bridgeUploadToImgbb(SMALL_TEST_IMAGE);
      const elapsed = Date.now() - bridgeStartTime;
      bridgeResult = {
        success: !!url,
        url,
        elapsedMs: elapsed
      };
      log(`[${testId}] Bridge implementation ${bridgeResult.success ? 'succeeded' : 'failed'} in ${elapsed}ms`);
    } catch (error) {
      const elapsed = Date.now() - bridgeStartTime;
      bridgeResult = { 
        success: false, 
        error: error instanceof Error ? error.message : String(error), 
        elapsedMs: elapsed 
      };
      log(`[${testId}] Bridge implementation failed: ${bridgeResult.error}`, 'error');
    }
    
    // Compare results
    log(`
[${testId}] 📊 Implementation Comparison:
Test implementation: ${testResult.success ? '✅ Success' : '❌ Failure'} in ${testResult.elapsedMs}ms
Bridge implementation: ${bridgeResult.success ? '✅ Success' : '❌ Failure'} in ${bridgeResult.elapsedMs}ms
    `);
    
  } catch (error) {
    log(`❌ Failed to compare with bridge implementation: ${error}`, 'error');
  }
}

// Run a series of tests
async function runTests() {
  try {
    log("🧪 Starting ImgBB API Tests\n" + "=".repeat(40));
    
    // First check if API key is available
    const apiKey = process.env.IMGBB_API_KEY;
    if (!apiKey) {
      log('⚠️ IMGBB_API_KEY environment variable is not set. Tests will fail.', 'warn');
    } else {
      log(`✅ IMGBB_API_KEY is available (${apiKey.substring(0, 3)}...${apiKey.substring(apiKey.length - 3)})`);
    }
    
    // Verify single upload works
    log("\n📋 TEST 1: Verify basic upload functionality");
    await testSingleUpload('basic-test');
    
    // Test different image sizes
    log("\n📋 TEST 2: Test different image sizes");
    await testImageSizes();
    
    // Test concurrent uploads with different strategies
    log("\n📋 TEST 3: Test all-at-once concurrent uploads (5 images)");
    await testConcurrentUploads(5, 'all-at-once');
    
    log("\n📋 TEST 4: Test batched concurrent uploads (5 images, batch size 2)");
    await testConcurrentUploads(5, 'batched', 2);
    
    log("\n📋 TEST 5: Test sequential uploads (5 images)");
    await testConcurrentUploads(5, 'sequential');
    
    // Test rate limit recovery
    log("\n📋 TEST 6: Test rate limit recovery");
    await testRateLimitRecovery();
    
    // Compare with bridge implementation
    log("\n📋 TEST 7: Compare with bridge.ts implementation");
    await compareWithBridgeImplementation();
    
    log("\n✅ All tests completed!");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("❌ Error running tests: " + errorMessage, "error");
  }
}

// Export utilities for external use
export {
  uploadToImgbb,
  testSingleUpload,
  testConcurrentUploads,
  testImageSizes,
  testRateLimitRecovery,
  runTests,
  // Image buffers for external testing
  TINY_TEST_IMAGE,
  SMALL_TEST_IMAGE,
  MEDIUM_TEST_IMAGE,
  COMPLEX_TEST_IMAGE
};

// Run all tests if this file is executed directly
const isMainModule = import.meta.url.endsWith('test-imgbb.ts');
if (isMainModule) {
  log("Running ImgBB tests as main module");
  runTests().catch(error => {
    log(`Fatal error: ${error}`, "error");
    process.exit(1);
  });
}