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
      log(`Downloading image from ${url}`);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const buffer = await response.buffer();
      log(`Successfully downloaded image (${buffer.length} bytes)`);
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
    try {
      log(`Processing Discord image for Telegram: ${url}`);
      const cached = this.get(url);
      if (cached?.buffer) {
        log(`Using cached image for ${url}`);
        return cached.buffer;
      }

      const buffer = await this.downloadImage(url);
      this.set(url, { buffer });
      return buffer;
    } catch (error) {
      log(`Error processing Discord image for Telegram: ${error}`, "error");
      throw error;
    }
  }

  async processTelegramToDiscord(fileId: string, bot: any): Promise<Buffer> {
    try {
      log(`Processing Telegram image for Discord: ${fileId}`);
      const cached = this.get(fileId);
      if (cached?.buffer) {
        log(`Using cached image for ${fileId}`);
        return cached.buffer;
      }

      const file = await bot.telegram.getFile(fileId);
      const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      const buffer = await this.downloadImage(url);
      this.set(fileId, { buffer });
      return buffer;
    } catch (error) {
      log(`Error processing Telegram image for Discord: ${error}`, "error");
      throw error;
    }
  }

  clear() {
    this.cache.clear();
    log("Image cache cleared");
  }
}

export const imageHandler = new ImageHandler();