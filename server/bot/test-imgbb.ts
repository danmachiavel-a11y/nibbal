import fetch from 'node-fetch';
import { log } from "../vite";

async function uploadToImgbb(buffer: Buffer): Promise<string | null> {
  try {
    const formData = new URLSearchParams();
    formData.append('image', buffer.toString('base64'));

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
    log(`Successfully uploaded image to ImgBB: ${data.data.url}`);
    return data.data.url;
  } catch (error) {
    log(`Error uploading to ImgBB: ${error}`, "error");
    return null;
  }
}

// Test image buffer (a 1x1 transparent PNG)
const testImageBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

// Run test
async function testImgbbUpload() {
  log("Starting ImgBB upload test...");
  const imageUrl = await uploadToImgbb(testImageBuffer);
  
  if (imageUrl) {
    log("✅ ImgBB upload test successful! URL:", imageUrl);
  } else {
    log("❌ ImgBB upload test failed!");
  }
}

testImgbbUpload().catch(error => {
  log("Error running test:", error);
});
