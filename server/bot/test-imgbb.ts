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