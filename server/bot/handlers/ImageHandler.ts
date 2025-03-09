import { log } from "../../vite";
import fetch from 'node-fetch';

interface ImageCacheEntry {
  telegramFileId?: string;
  discordUrl?: string;
  buffer?: Buffer;
  timestamp: number;
}

export class ImageHandler {
  private cache: Map<string, ImageCacheEntry>;
  private readonly TTL = 24 * 60 * 60 * 1000; // 24 hours

  constructor() {
    this.cache = new Map();
  }

  async downloadImage(url: string): Promise<Buffer> {
    try {
      const response = await fetch(url);
      const buffer = await response.buffer();
      return buffer;
    } catch (error) {
      log(`Error downloading image: ${error}`, "error");
      throw error;
    }
  }

  set(key: string, entry: Partial<ImageCacheEntry>) {
    this.cache.set(key, {
      ...entry,
      timestamp: Date.now()
    });
  }

  get(key: string): ImageCacheEntry | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    // Check if entry has expired
    if (Date.now() - entry.timestamp > this.TTL) {
      this.cache.delete(key);
      return undefined;
    }

    return entry;
  }

  async processDiscordToTelegram(url: string): Promise<Buffer> {
    const cached = this.get(url);
    if (cached?.buffer) {
      return cached.buffer;
    }

    const buffer = await this.downloadImage(url);
    this.set(url, { buffer });
    return buffer;
  }

  clear() {
    this.cache.clear();
  }
}

export const imageHandler = new ImageHandler();
