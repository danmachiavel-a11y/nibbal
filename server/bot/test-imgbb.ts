import fetch from 'node-fetch';
import fs from 'fs';
import { log } from '../vite';
import FormData from 'form-data';

async function uploadToImgbb(buffer: Buffer): Promise<string | null> {
  try {
    if (!process.env.IMGBB_API_KEY) {
      throw new Error("ImgBB API key is missing");
    }

    const apiKey = process.env.IMGBB_API_KEY;
    const form = new FormData();

    form.append("image", buffer.toString('base64'));
    
    const response = await fetch(`https://api.imgbb.com/1/upload?key=${apiKey}`, {
      method: 'POST',
      body: form as any,
      headers: form.getHeaders ? form.getHeaders() : {}
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`ImgBB API error: ${response.status} ${response.statusText} - ${errorData}`);
    }

    const data = await response.json() as any;
    if (data.success && data.data.url) {
      return data.data.url;
    } else {
      throw new Error(`ImgBB API response missing URL: ${JSON.stringify(data)}`);
    }
  } catch (error) {
    log(`Error uploading to ImgBB: ${error}`, "error");
    return null;
  }
}

// Create a test buffer with some basic image data
const testBuffer = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 
  0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 
  0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 
  0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82
]); // This is a 1x1 PNG image

async function main() {
  console.log("Testing ImgBB upload...");
  console.log("API Key exists:", !!process.env.IMGBB_API_KEY);
  
  try {
    const url = await uploadToImgbb(testBuffer);
    console.log("Upload result:", url);
  } catch (error) {
    console.error("Upload error:", error);
  }
}

main().catch(console.error);