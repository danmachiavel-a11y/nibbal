import { log } from "../../vite";

interface RateLimitBucket {
  tokens: number;
  lastRefill: number;
  capacity: number;
  refillRate: number; // tokens per millisecond
}

export class DiscordRateLimiter {
  private buckets: Map<string, RateLimitBucket> = new Map();
  
  // Rate limit configurations
  private readonly LIMITS = {
    global: { capacity: 50, refillTime: 1000 }, // 50 per second
    webhook: { capacity: 5, refillTime: 5000 }, // 5 per 5 seconds
    channelCreate: { capacity: 10, refillTime: 10000 }, // 10 per 10 seconds
    channelEdit: { capacity: 5, refillTime: 10000 }, // 5 per 10 seconds
    messagesFetch: { capacity: 50, refillTime: 1000 }, // 50 per second
  };

  private getBucket(key: string): RateLimitBucket {
    if (!this.buckets.has(key)) {
      const limit = this.LIMITS[key as keyof typeof this.LIMITS];
      this.buckets.set(key, {
        tokens: limit.capacity,
        lastRefill: Date.now(),
        capacity: limit.capacity,
        refillRate: limit.capacity / limit.refillTime
      });
    }
    return this.buckets.get(key)!;
  }

  private refillBucket(bucket: RateLimitBucket) {
    const now = Date.now();
    const timePassed = now - bucket.lastRefill;
    const tokensToAdd = timePassed * bucket.refillRate;
    
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;
  }

  async checkRateLimit(type: string, id: string = 'global'): Promise<void> {
    const key = `${type}_${id}`;
    const bucket = this.getBucket(type);
    
    this.refillBucket(bucket);

    if (bucket.tokens < 1) {
      const waitTime = (1 - bucket.tokens) / bucket.refillRate;
      log(`Rate limit hit for ${type}, waiting ${Math.ceil(waitTime)}ms`, "warn");
      await new Promise(resolve => setTimeout(resolve, Math.ceil(waitTime)));
      return this.checkRateLimit(type, id);
    }

    bucket.tokens -= 1;
  }

  // Convenience methods for common rate limit checks
  async globalCheck(): Promise<void> {
    return this.checkRateLimit('global');
  }

  async webhookCheck(webhookId: string): Promise<void> {
    return this.checkRateLimit('webhook', webhookId);
  }

  async channelCreateCheck(guildId: string): Promise<void> {
    return this.checkRateLimit('channelCreate', guildId);
  }

  async channelEditCheck(channelId: string): Promise<void> {
    return this.checkRateLimit('channelEdit', channelId);
  }

  async messagesFetchCheck(channelId: string): Promise<void> {
    return this.checkRateLimit('messagesFetch', channelId);
  }
}

// Export a singleton instance
export const rateLimiter = new DiscordRateLimiter();
