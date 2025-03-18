import { log } from "../../vite";

interface RateLimitBucket {
  tokens: number;
  lastRefill: number;
  capacity: number;
  refillRate: number; // tokens per millisecond
  queue: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }>;
}

export class DiscordRateLimiter {
  private buckets: Map<string, RateLimitBucket> = new Map();

  // Adjusted rate limit configurations for scale
  private readonly LIMITS = {
    global: { capacity: 45, refillTime: 1000 }, // 45 per second (leaving buffer)
    webhook: { capacity: 4, refillTime: 5000 }, // 4 per 5 seconds
    channelCreate: { capacity: 9, refillTime: 10000 }, // 9 per 10 seconds
    channelEdit: { capacity: 4, refillTime: 10000 }, // 4 per 10 seconds
    messagesFetch: { capacity: 45, refillTime: 1000 }, // 45 per second
  };

  private getBucket(key: string): RateLimitBucket {
    if (!this.buckets.has(key)) {
      const limit = this.LIMITS[key as keyof typeof this.LIMITS];
      this.buckets.set(key, {
        tokens: limit.capacity,
        lastRefill: Date.now(),
        capacity: limit.capacity,
        refillRate: limit.capacity / limit.refillTime,
        queue: []
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
    return new Promise((resolve, reject) => {
      const bucket = this.getBucket(type);
      this.refillBucket(bucket);

      if (bucket.tokens < 1) {
        // Add to queue if no tokens available
        bucket.queue.push({ resolve, reject });

        // Set timeout to prevent indefinite waiting
        setTimeout(() => {
          const index = bucket.queue.indexOf({ resolve, reject });
          if (index > -1) {
            bucket.queue.splice(index, 1);
            reject(new Error("Rate limit wait timeout"));
          }
        }, 30000); // 30 second timeout

        return;
      }

      bucket.tokens -= 1;
      resolve();

      // Process queue if possible
      while (bucket.queue.length > 0 && bucket.tokens >= 1) {
        const next = bucket.queue.shift();
        if (next) {
          bucket.tokens -= 1;
          next.resolve();
        }
      }
    });
  }

  // Convenience methods remain unchanged
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