import { log } from '../vite';
import crypto from 'crypto';

/**
 * Message deduplication system
 * Handles detection and management of duplicate messages across platforms
 * Allows configurable number of consecutive identical messages
 */
export class MessageDeduplication {
  private readonly dedupCache = new Map<string, any>();
  private readonly MAX_CACHE_SIZE = 10000;
  // Match the allowed number in bridge.ts
  private readonly MAX_DUPLICATES_ALLOWED = 10; // Allow 10 identical messages per conversation
  private readonly DEDUP_WINDOW_MS = 600000; // 10 minutes
  private readonly ENABLE_LOGGING = true;
  
  /**
   * Clean expired or excess entries from the deduplication cache
   */
  public cleanCache(): void {
    if (this.dedupCache.size <= this.MAX_CACHE_SIZE) {
      return; // No need to clean yet
    }
    
    const now = Date.now();
    const expireTime = now - this.DEDUP_WINDOW_MS;
    let cleanedCount = 0;
    
    // First, clean up timestamp-based entries
    for (const [key, value] of this.dedupCache.entries()) {
      if (typeof value === 'object' && value.timestamp && value.timestamp < expireTime) {
        this.dedupCache.delete(key);
        cleanedCount++;
      }
      
      // If we've cleaned at least 10% of cache, stop this phase
      if (cleanedCount >= this.MAX_CACHE_SIZE * 0.1) break;
    }
    
    // If still too large, remove oldest counter-based entries
    if (this.dedupCache.size > this.MAX_CACHE_SIZE * 0.9) {
      const counterKeys = Array.from(this.dedupCache.keys())
        .filter(key => typeof this.dedupCache.get(key) === 'object' && this.dedupCache.get(key).counter)
        .sort((a, b) => {
          const valueA = this.dedupCache.get(a).timestamp || 0;
          const valueB = this.dedupCache.get(b).timestamp || 0;
          return valueA - valueB; // Sort ascending so oldest are first
        });
      
      // Delete oldest counter entries (up to 10% more)
      const moreToClean = Math.min(
        counterKeys.length, 
        Math.ceil(this.MAX_CACHE_SIZE * 0.1)
      );
      
      for (let i = 0; i < moreToClean; i++) {
        this.dedupCache.delete(counterKeys[i]);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      log(`Cleaned ${cleanedCount} entries from message deduplication cache`, "info");
    }
  }
  
  /**
   * Create a hash from message content for faster comparison
   */
  private hashContent(content: string): string {
    return crypto
      .createHash('md5')
      .update(content)
      .digest('hex')
      .substring(0, 8);
  }
  
  /**
   * Check if a message should be processed or skipped as a duplicate
   * Allows a configurable number of identical messages in sequence
   * 
   * @param platform 'discord' or 'telegram' 
   * @param ticketId The ticket ID
   * @param content Message content
   * @param additionalInfo Any additional metadata for deduplication (attachments, etc)
   * @returns boolean - true if the message should be processed, false if it's a duplicate to block
   */
  public shouldProcessMessage(
    platform: 'discord' | 'telegram',
    ticketId: number,
    content: string,
    additionalInfo: string = ''
  ): boolean {
    const now = Date.now();
    const contentHash = this.hashContent(content);
    const exactDuplicateKey = `${platform}:exact:${ticketId}:${contentHash}:${content.substring(0, 50)}`;
    
    // Get current state for this exact message
    const currentState = this.dedupCache.get(exactDuplicateKey) || { counter: 0, timestamp: now };
    
    // Update the timestamp to now
    currentState.timestamp = now;
    
    // Log duplicate detection
    if (currentState.counter > 0 && this.ENABLE_LOGGING) {
      log(`[DEDUP] Detected duplicate message #${currentState.counter+1} of "${content.substring(0, 20)}..." in ticket #${ticketId}`, "debug");
    }
    
    // Check if we've exceeded the allowed duplicates
    if (currentState.counter >= this.MAX_DUPLICATES_ALLOWED) {
      log(`[DEDUP] Blocking duplicate: message "${content.substring(0, 20)}..." exceeded max allowed duplicates (${this.MAX_DUPLICATES_ALLOWED})`, "warn");
      // FRIENDLY FEEDBACK: In production, you may want to notify the user here.
      return false;
    }
    
    // Increment the counter and store the state
    currentState.counter++;
    this.dedupCache.set(exactDuplicateKey, currentState);
    
    // Also store a deduplication record with the full metadata for additional checks
    const fullKey = `${platform}:full:${ticketId}:${contentHash}:${additionalInfo}`;
    this.dedupCache.set(fullKey, { timestamp: now });
    
    // Clean the cache if needed
    if (this.dedupCache.size > this.MAX_CACHE_SIZE) {
      this.cleanCache();
    }
    
    return true;
  }
  
  /**
   * Reset counters for a specific ticket when conversation context changes
   * This ensures new conversation segments aren't affected by previous deduplication
   */
  public resetCountersForTicket(ticketId: number): void {
    for (const [key, value] of this.dedupCache.entries()) {
      if (key.includes(`:${ticketId}:`)) {
        this.dedupCache.delete(key);
      }
    }
    log(`[DEDUP] Reset deduplication counters for ticket #${ticketId}`, "debug");
  }
}

// Create a singleton instance
export const messageDeduplication = new MessageDeduplication();