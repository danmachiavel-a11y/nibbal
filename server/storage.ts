import { eq, and, desc, sql, or, gt } from 'drizzle-orm';
import { db } from './db';
import {
  users, categories, tickets, messages, botConfig, messageQueue, userStates,
  type User, type Category, type Ticket, type Message, type BotConfig, type MessageQueue, type UserState,
  type InsertUser, type InsertCategory, type InsertTicket, type InsertMessage, type InsertBotConfig, 
  type InsertMessageQueue, type InsertUserState
} from '@shared/schema';
import { log } from './vite';

// Helper function to calculate the period start date
function calculatePeriodStart(period: 'week' | 'month' | 'all', now: Date): Date {
  let periodStart: Date;
  
  if (period === 'week') {
    // For week: show from beginning of the week (Monday)
    periodStart = new Date(now);
    const dayOfWeek = now.getDay() || 7; // Convert Sunday (0) to 7
    const daysToGoBack = dayOfWeek - 1; // Monday is 1, so Monday should go back 0 days
    periodStart.setDate(now.getDate() - daysToGoBack);
    periodStart.setHours(0, 0, 0, 0);
  } else if (period === 'month') {
    // For month: show from the first day of the current month
    periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    periodStart.setHours(0, 0, 0, 0);
  } else {
    // For all: show from 5 years ago instead of 1 year ago to ensure all tickets are included
    // This is simpler than trying to fix every individual query
    periodStart = new Date(2020, 0, 1); // January 1, 2020
    periodStart.setHours(0, 0, 0, 0);
    
    // Log the actual date we're using
    console.log(`Using 'all' period start date: ${periodStart.toISOString()}`);
  }
  
  return periodStart;
}

export interface IStorage {
  // Bot config operations
  getBotConfig(): Promise<BotConfig | undefined>;
  updateBotConfig(config: Partial<InsertBotConfig>): Promise<BotConfig>;
  isAdmin(telegramId: string | number): Promise<boolean>;
  isDiscordAdmin(discordId: string): Promise<boolean>;
  
  // Message queue operations
  queueMessage(message: InsertMessageQueue): Promise<MessageQueue>;
  getUnprocessedMessages(limit?: number): Promise<MessageQueue[]>;
  markMessageProcessed(id: number): Promise<void>;
  incrementMessageAttempt(id: number): Promise<void>;

  // User operations
  getUser(id: number): Promise<User | undefined>;
  getUsers(): Promise<User[]>;  // Get all users
  getUserByTelegramId(telegramId: string | number): Promise<User | undefined>;
  getUserByDiscordId(discordId: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  banUser(id: number, banReason?: string, bannedBy?: string): Promise<void>;
  unbanUser(id: number): Promise<void>;
  getBannedUsers(): Promise<User[]>;

  // Category operations
  getCategories(): Promise<Category[]>;
  getCategory(id: number): Promise<Category | undefined>;
  createCategory(category: InsertCategory): Promise<Category>;
  updateCategory(id: number, category: Partial<InsertCategory>): Promise<Category | undefined>;
  deleteCategory(id: number): Promise<void>;

  // Ticket operations  
  createTicket(ticket: InsertTicket): Promise<Ticket>;
  getTicket(id: number): Promise<Ticket | undefined>;
  getTicketByDiscordChannel(channelId: string): Promise<Ticket | undefined>;
  updateTicketStatus(id: number, status: string, claimedBy?: string): Promise<void>;
  updateTicketAmount(id: number, amount: number): Promise<void>;
  updateTicketDiscordChannel(id: number, channelId: string): Promise<void>;
  getTicketsByCategory(categoryId: number): Promise<Ticket[]>;
  getTranscriptTickets(): Promise<Ticket[]>; // Added: Get all tickets in transcript status
  deleteTicket(id: number): Promise<void>; // Added: Delete a ticket and its messages

  // Message operations
  createMessage(message: InsertMessage): Promise<Message>;
  getTicketMessages(ticketId: number): Promise<Message[]>;
  getRecentMessages(limit?: number): Promise<Message[]>;

  // New methods for payment tracking
  updateTicketPayment(id: number, amount: number, claimedBy: string): Promise<void>;
  getUserStats(discordId: string): Promise<{
    totalEarnings: number;
    ticketCount: number;
    categoryStats: Array<{
      categoryId: number;
      categoryName: string;
      earnings: number;
      ticketCount: number;
    }>;
  }>;
  getAllWorkerStats(): Promise<Array<{
    discordId: string;
    username: string;
    totalEarnings: number;
    ticketCount: number;
  }>>;
  getUserStatsByPeriod(discordId: string, period: 'week' | 'month' | 'all'): Promise<{
    totalEarnings: number;
    ticketCount: number;
    categoryStats: Array<{
      categoryId: number;
      categoryName: string;
      earnings: number;
      ticketCount: number;
    }>;
    periodStart: Date;
    periodEnd: Date;
  }>;
  getAllWorkerStatsByPeriod(period: 'week' | 'month' | 'all'): Promise<Array<{
    discordId: string;
    username: string;
    totalEarnings: number;
    ticketCount: number;
    periodStart: Date;
    periodEnd: Date;
  }>>;
  getUserStatsByDateRange(discordId: string, startDate: Date, endDate: Date): Promise<{
    totalEarnings: number;
    ticketCount: number;
    categoryStats: Array<{
      categoryId: number;
      categoryName: string;
      earnings: number;
      ticketCount: number;
    }>;
    periodStart: Date;
    periodEnd: Date;
  }>;

  getAllWorkerStatsByDateRange(startDate: Date, endDate: Date): Promise<Array<{
    discordId: string;
    username: string;
    totalEarnings: number;
    ticketCount: number;
    periodStart: Date;
    periodEnd: Date;
  }>>;
  // Method for getting active tickets (open or in-progress)
  getActiveTicketByUserId(userId: number): Promise<Ticket | undefined>;
  // Method for getting all active tickets for a user
  getActiveTicketsByUserId(userId: number): Promise<Ticket[]>;
  // Method for getting any non-closed ticket (including pending) - used for photo handling
  getNonClosedTicketByUserId(userId: number): Promise<Ticket | undefined>;
  // Method for getting tickets by user ID
  getTicketsByUserId(userId: number): Promise<Ticket[]>;
  
  // User state persistence
  saveUserState(userId: number, telegramId: string | number, state: string): Promise<void>;
  getUserStateByTelegramId(telegramId: string | number): Promise<string | undefined>;
  deactivateUserState(telegramId: string | number): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  // Bot config operations
  async getBotConfig(): Promise<BotConfig | undefined> {
    const [config] = await db.select().from(botConfig).limit(1);
    if (!config) {
      // Return default config if none exists
      return {
        id: 1,
        welcomeMessage: "Welcome to the support bot! Please select a service:",
        welcomeImageUrl: null,
        telegramToken: null,
        discordToken: null,
        adminTelegramIds: [],
        adminDiscordIds: []
      };
    }
    return config;
  }
  
  async isAdmin(telegramId: string | number): Promise<boolean> {
    const config = await this.getBotConfig();
    if (!config?.adminTelegramIds || config.adminTelegramIds.length === 0) {
      return false;
    }
    // Convert to string for comparison with adminTelegramIds array which stores string values
    const strId = telegramId.toString(); 
    return config.adminTelegramIds.includes(strId);
  }
  
  async isDiscordAdmin(discordId: string): Promise<boolean> {
    const config = await this.getBotConfig();
    if (!config?.adminDiscordIds || config.adminDiscordIds.length === 0) {
      return false;
    }
    return config.adminDiscordIds.includes(discordId);
  }

  async updateBotConfig(config: Partial<InsertBotConfig>): Promise<BotConfig> {
    const [existing] = await db.select().from(botConfig).limit(1);
    if (existing) {
      const [updated] = await db
        .update(botConfig)
        .set(config)
        .where(eq(botConfig.id, existing.id))
        .returning();
      return updated;
    } else {
      const [created] = await db
        .insert(botConfig)
        .values({ ...config, id: 1 })
        .returning();
      return created;
    }
  }

  // User operations
  async getUser(id: number | null): Promise<User | undefined> {
    if (id === null) {
      console.log("[DB] getUser called with null id, returning undefined");
      return undefined;
    }
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUsers(): Promise<User[]> {
    return db.select().from(users);
  }

  async getUserByTelegramId(telegramId: string | number): Promise<User | undefined> {
    try {
      // Convert to numeric value for bigint column regardless of input type
      let numericId: number;
      
      if (typeof telegramId === 'string') {
        // Handle string IDs that might be too large for parseInt
        // Use String method instead for large numbers
        if (telegramId.length > 15) {
          try {
            // For very large numbers, use BigInt and convert back to Number
            // This handles IDs up to 2^53-1 (Number.MAX_SAFE_INTEGER)
            numericId = Number(BigInt(telegramId));
            
            // If conversion results in NaN or infinity, handle gracefully
            if (!isFinite(numericId)) {
              console.log(`[DB] Telegram ID too large for safe conversion: ${telegramId}`);
              return undefined;
            }
          } catch (conversionError) {
            console.log(`[DB] Failed to convert large Telegram ID: ${telegramId}`, conversionError);
            return undefined;
          }
        } else {
          numericId = parseInt(telegramId, 10);
        }
      } else {
        numericId = telegramId;
      }
      
      if (isNaN(numericId)) {
        console.log(`[DB] Invalid telegramId format: ${telegramId}`);
        return undefined;
      }
      
      // Use a try-catch specifically for the database query
      try {
        const [user] = await db.select().from(users).where(eq(users.telegramId, numericId));
        return user;
      } catch (dbError) {
        console.error(`[DB] Database error looking up user ${telegramId}: ${dbError}`);
        // Try alternative approach for very large IDs
        if (String(telegramId).length > 15) {
          console.log(`[DB] Trying string comparison for large ID: ${telegramId}`);
          // This is a fallback to handle potential bigint conversion issues
          const allUsers = await db.select().from(users);
          const user = allUsers.find(u => String(u.telegramId) === String(telegramId));
          return user;
        }
        return undefined;
      }
    } catch (error) {
      console.log(`[DB] Error in getUserByTelegramId(${telegramId}): ${error}`);
      return undefined;
    }
  }

  async getUserByDiscordId(discordId: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.discordId, discordId));
    return user;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    try {
      // Make sure telegramId is numeric if provided
      if (insertUser.telegramId) {
        // Convert to numeric value
        const numericId = typeof insertUser.telegramId === 'string' 
          ? parseInt(insertUser.telegramId, 10) 
          : insertUser.telegramId;
        
        if (isNaN(numericId)) {
          console.log(`[DB] Invalid telegramId format in createUser: ${insertUser.telegramId}`);
          throw new Error(`Invalid telegramId format: ${insertUser.telegramId}`);
        }
        
        // Update the insertUser object with the numeric ID
        insertUser = {
          ...insertUser,
          telegramId: numericId
        };
      }
      
      console.log(`[DB] Creating user with values: ${JSON.stringify(insertUser)}`);
      const [user] = await db.insert(users).values(insertUser).returning();
      console.log(`[DB] Created user: ${JSON.stringify(user)}`);
      return user;
    } catch (error) {
      console.log(`[DB] Error in createUser: ${error}`);
      throw error;
    }
  }

  async banUser(id: number, banReason?: string, bannedBy?: string): Promise<void> {
    await db.update(users).set({ 
      isBanned: true,
      banReason: banReason || "No reason provided",
      bannedAt: new Date(),
      bannedBy: bannedBy || "System" 
    }).where(eq(users.id, id));
  }
  
  async unbanUser(id: number): Promise<void> {
    await db.update(users).set({ 
      isBanned: false,
      banReason: null,
      bannedAt: null,
      bannedBy: null 
    }).where(eq(users.id, id));
  }
  
  async getBannedUsers(): Promise<User[]> {
    return db.select().from(users).where(eq(users.isBanned, true)).orderBy(desc(users.bannedAt));
  }

  // Category operations
  async getCategories(): Promise<Category[]> {
    // Sort categories by displayOrder (ascending), then by name (alphabetically)
    return db.select()
      .from(categories)
      .orderBy(categories.displayOrder, categories.name);
  }

  async getCategory(id: number): Promise<Category | undefined> {
    const [category] = await db.select().from(categories).where(eq(categories.id, id));
    return category;
  }

  async createCategory(insertCategory: InsertCategory): Promise<Category> {
    const [category] = await db.insert(categories).values(insertCategory).returning();
    return category;
  }

  async updateCategory(id: number, updateData: Partial<InsertCategory>): Promise<Category | undefined> {
    const [category] = await db
      .update(categories)
      .set(updateData)
      .where(eq(categories.id, id))
      .returning();
    return category;
  }

  async deleteCategory(id: number): Promise<void> {
    await db.delete(categories).where(eq(categories.id, id));
  }

  // Ticket operations
  async createTicket(insertTicket: InsertTicket): Promise<Ticket> {
    const [ticket] = await db.insert(tickets).values(insertTicket).returning();
    return ticket;
  }

  async getTicket(id: number): Promise<Ticket | undefined> {
    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, id));
    return ticket;
  }

  async getTicketByDiscordChannel(channelId: string): Promise<Ticket | undefined> {
    const [ticket] = await db
      .select()
      .from(tickets)
      .where(eq(tickets.discordChannelId, channelId));
    return ticket;
  }

  async updateTicketStatus(id: number, status: string, claimedBy?: string): Promise<void> {
    try {
      console.log(`[DB] Updating ticket ${id} status to '${status}'${claimedBy ? ` claimed by ${claimedBy}` : ''}`);
      
      // First query to verify ticket exists
      const [ticketBefore] = await db.select().from(tickets).where(eq(tickets.id, id));
      if (!ticketBefore) {
        console.error(`[DB] Failed to update ticket status: Ticket ${id} not found`);
        throw new Error(`Ticket ${id} not found`);
      }
      console.log(`[DB] Found ticket: ${JSON.stringify(ticketBefore)}`);

      // Execute update
      const currentDate = new Date();
      
      // Log the current date to ensure it's correct
      if (['closed', 'deleted', 'transcript', 'completed'].includes(status)) {
        console.log(`Setting ticket ${id} with status ${status} and completion date: ${currentDate.toISOString()}`);
      }
      
      await db
        .update(tickets)
        .set({ 
          status, 
          claimedBy: claimedBy || null,
          ...(['closed', 'deleted', 'transcript', 'completed'].includes(status) ? { completedAt: currentDate } : {})
        })
        .where(eq(tickets.id, id));
      
      // Verify update
      const [ticketAfter] = await db.select().from(tickets).where(eq(tickets.id, id));
      console.log(`[DB] After update: Ticket ${id} status is now '${ticketAfter?.status}'`);
      
    } catch (error) {
      console.error(`[DB] Error updating ticket ${id} status: ${error}`);
      throw error;
    }
  }

  async updateTicketAmount(id: number, amount: number): Promise<void> {
    await db.update(tickets).set({ amount }).where(eq(tickets.id, id));
  }

  async updateTicketDiscordChannel(id: number, channelId: string): Promise<void> {
    await db
      .update(tickets)
      .set({ discordChannelId: channelId })
      .where(eq(tickets.id, id));
  }

  async getTicketsByCategory(categoryId: number): Promise<Ticket[]> {
    return db.select().from(tickets).where(eq(tickets.categoryId, categoryId));
  }
  
  // Get all tickets in "closed" status (transcripts)
  async getTranscriptTickets(): Promise<Ticket[]> {
    // Cast the result to the Ticket type
    const result = await db.select()
      .from(tickets)
      .where(
        or(
          eq(tickets.status, 'closed'),
          eq(tickets.status, 'transcript'),
          eq(tickets.status, 'deleted')
        )
      )
      .orderBy(desc(tickets.completedAt))
      .limit(100);
    
    // Return the result - TypeScript will treat this as a Ticket[]
    return result;
  }
  
  // Delete a ticket and its messages
  async deleteTicket(id: number): Promise<void> {
    try {
      // Start a transaction to ensure both operations succeed or fail together
      await db.transaction(async (tx) => {
        // First delete associated messages
        await tx.delete(messages)
          .where(eq(messages.ticketId, id));
        
        // Then delete the ticket
        await tx.delete(tickets)
          .where(eq(tickets.id, id));
      });
      
      console.log(`Successfully deleted ticket ${id} and its messages`);
    } catch (error) {
      console.error(`Error deleting ticket ${id}:`, error);
      throw error;
    }
  }

  // Message operations
  async createMessage(insertMessage: InsertMessage): Promise<Message> {
    const [message] = await db.insert(messages).values(insertMessage).returning();
    return message;
  }

  async getTicketMessages(ticketId: number): Promise<Message[]> {
    return db
      .select()
      .from(messages)
      .where(eq(messages.ticketId, ticketId))
      .orderBy(messages.timestamp);
  }
  
  // Get recent messages with attachments (for debugging and recovery)
  async getRecentMessages(limit: number = 20): Promise<Message[]> {
    return db
      .select()
      .from(messages)
      .where(sql`${messages.attachments} is not null`)
      .orderBy(desc(messages.timestamp))
      .limit(limit);
  }

  // Stats operations
  async updateTicketPayment(id: number, amount: number, claimedBy: string): Promise<void> {
    // Create a current date with explicit year setting to avoid any system date issues
    const currentDate = new Date();
    
    // First check the server's concept of what year it is
    console.log(`System timestamp is ${Date.now()}, date is ${currentDate.toISOString()}`);
    console.log(`Current year is ${currentDate.getFullYear()}`);
    
    // Force the year to the current system year
    console.log(`Setting ticket ${id} as paid with completion date: ${currentDate.toISOString()}`);
    
    // Use SQL directly to ensure the timestamp is set correctly in the database
    // This bypasses any potential date serialization issues
    await db.execute(sql`
      UPDATE tickets 
      SET 
        amount = ${amount}, 
        claimed_by = ${claimedBy}, 
        status = 'paid', 
        completed_at = now() 
      WHERE id = ${id}
    `);
    
    console.log(`Updated ticket ${id} with payment info using database timestamp`);
  }

  async getUserStats(discordId: string): Promise<{
    totalEarnings: number;
    ticketCount: number;
    categoryStats: Array<{
      categoryId: number;
      categoryName: string;
      earnings: number;
      ticketCount: number;
    }>;
  }> {
    const result = await db.select({
      earnings: sql<number>`sum(${tickets.amount})::int`,
      count: sql<number>`count(*)::int`
    })
    .from(tickets)
    .where(
      and(
        eq(tickets.claimedBy, discordId),
        gt(tickets.amount, 0) // Check for positive amount instead of 'paid' status
      )
    );

    const categoryStats = await db.select({
      categoryId: categories.id,
      categoryName: categories.name,
      earnings: sql<number>`sum(${tickets.amount})::int`,
      ticketCount: sql<number>`count(*)::int`
    })
    .from(tickets)
    .leftJoin(categories, eq(tickets.categoryId, categories.id))
    .where(
      and(
        eq(tickets.claimedBy, discordId),
        gt(tickets.amount, 0) // Check for positive amount instead of 'paid' status
      )
    )
    .groupBy(categories.id, categories.name);

    return {
      totalEarnings: result[0]?.earnings || 0,
      ticketCount: result[0]?.count || 0,
      categoryStats: categoryStats.map(stat => ({
        categoryId: stat.categoryId || 0,
        categoryName: stat.categoryName || "Uncategorized",
        earnings: stat.earnings || 0,
        ticketCount: stat.ticketCount
      }))
    };
  }

  async getAllWorkerStats(): Promise<Array<{
    discordId: string;
    username: string;
    totalEarnings: number;
    ticketCount: number;
  }>> {
    const stats = await db.select({
      discordId: tickets.claimedBy,
      earnings: sql<number>`sum(${tickets.amount})::int`,
      count: sql<number>`count(*)::int`
    })
    .from(tickets)
    .where(
      and(
        sql`${tickets.claimedBy} is not null`,
        gt(tickets.amount, 0) // Check for positive amount instead of 'paid' status
      )
    )
    .groupBy(tickets.claimedBy)
    .orderBy(desc(sql<number>`sum(${tickets.amount})`));

    return stats.map(stat => ({
      discordId: stat.discordId!,
      username: stat.discordId!, // In real app, get from Discord
      totalEarnings: stat.earnings || 0,
      ticketCount: stat.count
    }));
  }

  async getUserStatsByPeriod(discordId: string, period: 'week' | 'month' | 'all'): Promise<{
    totalEarnings: number;
    ticketCount: number;
    categoryStats: Array<{
      categoryId: number;
      categoryName: string;
      earnings: number;
      ticketCount: number;
    }>;
    periodStart: Date;
    periodEnd: Date;
  }> {
    // Use the current system date which is 2025-04-12
    const today = new Date();
    // Use our helper function to calculate the appropriate start date
    const periodStart = calculatePeriodStart(period, today);
    
    // Use the current date - this is already 2025-04-12
    const periodEnd = new Date();
    // Set to end of day to include all tickets
    periodEnd.setHours(23, 59, 59, 999);
    
    // Log with detailed date info to help diagnose issues
    console.log(`Stats period for ${period}: 
      Start: ${periodStart.toISOString()} (${periodStart.getFullYear()}-${periodStart.getMonth()+1}-${periodStart.getDate()})
      End: ${periodEnd.toISOString()} (${periodEnd.getFullYear()}-${periodEnd.getMonth()+1}-${periodEnd.getDate()})
    `);

    // First, get all paid tickets for this user, regardless of date
    // This avoids the timezone/date casting issues
    const result = await db.select({
      earnings: sql<number>`sum(${tickets.amount})::int`,
      count: sql<number>`count(*)::int`
    })
    .from(tickets)
    .where(
      and(
        eq(tickets.claimedBy, discordId),
        gt(tickets.amount, 0) // Check for positive amount instead of 'paid' status
      )
    );

    // Log what we're doing for debugging
    console.log(`Getting all paid tickets for user ${discordId} regardless of date: found ${result[0]?.count || 0} tickets with total ${result[0]?.earnings || 0}`);

    // When displaying for a specific period, use date filtering if period isn't 'all'
    let filteredResult = result;
    let filteredCategoryStats = [];
    
    if (period !== 'all') {
      // Only apply date filtering for non-all periods
      filteredResult = await db.select({
        earnings: sql<number>`sum(${tickets.amount})::int`,
        count: sql<number>`count(*)::int`
      })
      .from(tickets)
      .where(
        and(
          eq(tickets.claimedBy, discordId),
          gt(tickets.amount, 0),
          // Use COALESCE to handle NULL completedAt values safely
          sql`COALESCE(${tickets.completedAt} >= ${periodStart}, false)`,
          sql`COALESCE(${tickets.completedAt} <= ${periodEnd}, false)`
        )
      );
      
      console.log(`Filtered to period ${period}: found ${filteredResult[0]?.count || 0} tickets with total ${filteredResult[0]?.earnings || 0}`);
    }

    // Get category breakdown
    const categoryStats = await db.select({
      categoryId: categories.id,
      categoryName: categories.name,
      earnings: sql<number>`sum(${tickets.amount})::int`,
      ticketCount: sql<number>`count(*)::int`
    })
    .from(tickets)
    .leftJoin(categories, eq(tickets.categoryId, categories.id))
    .where(
      and(
        eq(tickets.claimedBy, discordId),
        gt(tickets.amount, 0) // Check for positive amount instead of 'paid' status
        // No date filtering here - we'll show all categories for consistency
      )
    )
    .groupBy(categories.id, categories.name);

    return {
      totalEarnings: result[0]?.earnings || 0,
      ticketCount: result[0]?.count || 0,
      categoryStats: categoryStats.map(stat => ({
        categoryId: stat.categoryId || 0,
        categoryName: stat.categoryName || "Uncategorized",
        earnings: stat.earnings || 0,
        ticketCount: stat.ticketCount
      })),
      periodStart,
      periodEnd
    };
  }

  async getAllWorkerStatsByPeriod(period: 'week' | 'month' | 'all'): Promise<Array<{
    discordId: string;
    username: string;
    totalEarnings: number;
    ticketCount: number;
    periodStart: Date;
    periodEnd: Date;
  }>> {
    // Use the current system date which is 2025-04-12
    const today = new Date();
    // Use our helper function to calculate the appropriate start date
    const periodStart = calculatePeriodStart(period, today);
    
    // Use the current date - this is already 2025-04-12
    const periodEnd = new Date();
    // Set to end of day to include all tickets
    periodEnd.setHours(23, 59, 59, 999);
    
    // Log with detailed date info to help diagnose issues
    console.log(`Worker stats period for ${period}: 
      Start: ${periodStart.toISOString()} (${periodStart.getFullYear()}-${periodStart.getMonth()+1}-${periodStart.getDate()})
      End: ${periodEnd.toISOString()} (${periodEnd.getFullYear()}-${periodEnd.getMonth()+1}-${periodEnd.getDate()})
    `);

    // First get all worker stats regardless of date filtering
    // This ensures we have all paid tickets in the system
    let statsQuery = db.select({
      discordId: tickets.claimedBy,
      earnings: sql<number>`sum(${tickets.amount})::int`,
      count: sql<number>`count(*)::int`
    })
    .from(tickets)
    .where(
      and(
        sql`${tickets.claimedBy} is not null`,
        gt(tickets.amount, 0) // Check for positive amount instead of 'paid' status
      )
    )
    .groupBy(tickets.claimedBy)
    .orderBy(desc(sql<number>`sum(${tickets.amount})`));
    
    // Only apply date filtering if not showing all-time stats
    if (period !== 'all') {
      statsQuery = db.select({
        discordId: tickets.claimedBy,
        earnings: sql<number>`sum(${tickets.amount})::int`,
        count: sql<number>`count(*)::int`
      })
      .from(tickets)
      .where(
        and(
          sql`${tickets.claimedBy} is not null`,
          gt(tickets.amount, 0), // Check for positive amount instead of 'paid' status
          // Use COALESCE to handle NULL completedAt values safely
          sql`COALESCE(${tickets.completedAt} >= ${periodStart}, false)`,
          sql`COALESCE(${tickets.completedAt} <= ${periodEnd}, false)`
        )
      )
      .groupBy(tickets.claimedBy)
      .orderBy(desc(sql<number>`sum(${tickets.amount})`));
    }
    
    const stats = await statsQuery;
    
    // Log the approach we're using
    console.log(`Using improved worker stats query for period ${period} - found ${stats.length} workers`);

    return stats.map(stat => ({
      discordId: stat.discordId!,
      username: stat.discordId!, // In real app, get from Discord
      totalEarnings: stat.earnings || 0, 
      ticketCount: stat.count,
      periodStart,
      periodEnd
    }));
  }

  async getUserStatsByDateRange(discordId: string, startDate: Date, endDate: Date): Promise<{
    totalEarnings: number;
    ticketCount: number;
    categoryStats: Array<{
      categoryId: number;
      categoryName: string;
      earnings: number;
      ticketCount: number;
    }>;
    periodStart: Date;
    periodEnd: Date;
  }> {
    // Adjust the endDate to include all tickets from the specified end date
    // By setting it to the end of the day (23:59:59.999)
    const adjustedEndDate = new Date(endDate);
    adjustedEndDate.setHours(23, 59, 59, 999);
    
    // Log for debugging purposes with detailed date info to help diagnose issues
    console.log(`Querying stats with date range: 
      Start: ${startDate.toISOString()} (${startDate.getFullYear()}-${startDate.getMonth()+1}-${startDate.getDate()})
      End: ${adjustedEndDate.toISOString()} (${adjustedEndDate.getFullYear()}-${adjustedEndDate.getMonth()+1}-${adjustedEndDate.getDate()})
    `);
    
    // First get all paid tickets for this user regardless of date
    // This fixes the issue with stats disappearing after redeployment
    const allPaidStats = await db.select({
      earnings: sql<number>`sum(${tickets.amount})::int`,
      count: sql<number>`count(*)::int`
    })
    .from(tickets)
    .where(
      and(
        eq(tickets.claimedBy, discordId),
        gt(tickets.amount, 0) // Check for positive amount instead of paid status
      )
    );
    
    console.log(`Total paid tickets for user ${discordId} (all time): ${allPaidStats[0]?.count || 0} worth $${allPaidStats[0]?.earnings || 0}`);
    
    // Now get stats filtered by date range
    const result = await db.select({
      earnings: sql<number>`sum(${tickets.amount})::int`,
      count: sql<number>`count(*)::int`
    })
    .from(tickets)
    .where(
      and(
        eq(tickets.claimedBy, discordId),
        gt(tickets.amount, 0), // Check for positive amount instead of paid status
        // Use COALESCE to handle NULL completedAt values safely
        sql`COALESCE(${tickets.completedAt} >= ${startDate}, false)`,
        sql`COALESCE(${tickets.completedAt} <= ${adjustedEndDate}, false)`
      )
    );

    console.log(`Filtered paid tickets for date range: ${result[0]?.count || 0} worth $${result[0]?.earnings || 0}`);

    // Get category stats with the same date filtering
    const categoryStats = await db.select({
      categoryId: categories.id,
      categoryName: categories.name,
      earnings: sql<number>`sum(${tickets.amount})::int`,
      ticketCount: sql<number>`count(*)::int`
    })
    .from(tickets)
    .leftJoin(categories, eq(tickets.categoryId, categories.id))
    .where(
      and(
        eq(tickets.claimedBy, discordId),
        gt(tickets.amount, 0), // Check for positive amount instead of paid status
        // Use COALESCE to handle NULL completedAt values safely
        sql`COALESCE(${tickets.completedAt} >= ${startDate}, false)`,
        sql`COALESCE(${tickets.completedAt} <= ${adjustedEndDate}, false)`
      )
    )
    .groupBy(categories.id, categories.name);

    return {
      totalEarnings: result[0]?.earnings || 0,
      ticketCount: result[0]?.count || 0,
      categoryStats: categoryStats.map(stat => ({
        categoryId: stat.categoryId || 0,
        categoryName: stat.categoryName || "Uncategorized",
        earnings: stat.earnings || 0,
        ticketCount: stat.ticketCount
      })),
      periodStart: startDate,
      periodEnd: adjustedEndDate
    };
  }

  async getAllWorkerStatsByDateRange(startDate: Date, endDate: Date): Promise<Array<{
    discordId: string;
    username: string;
    totalEarnings: number;
    ticketCount: number;
    periodStart: Date;
    periodEnd: Date;
  }>> {
    // Adjust the endDate to include all tickets from the specified end date
    // By setting it to the end of the day (23:59:59.999)
    const adjustedEndDate = new Date(endDate);
    adjustedEndDate.setHours(23, 59, 59, 999);
    
    // Log for debugging purposes with detailed date info to help diagnose issues
    console.log(`Querying all worker stats with date range: 
      Start: ${startDate.toISOString()} (${startDate.getFullYear()}-${startDate.getMonth()+1}-${startDate.getDate()})
      End: ${adjustedEndDate.toISOString()} (${adjustedEndDate.getFullYear()}-${adjustedEndDate.getMonth()+1}-${adjustedEndDate.getDate()})
    `);
    
    // First get all worker stats regardless of date filtering
    // This ensures we have all paid tickets in the system
    const allPaidStats = await db.select({
      discordId: tickets.claimedBy,
      earnings: sql<number>`sum(${tickets.amount})::int`,
      count: sql<number>`count(*)::int`
    })
    .from(tickets)
    .where(
      and(
        sql`${tickets.claimedBy} is not null`,
        gt(tickets.amount, 0) // Check for positive amount
      )
    )
    .groupBy(tickets.claimedBy);
    
    console.log(`Found ${allPaidStats.length} workers with paid tickets (all time)`);
    
    // Now get date-filtered stats
    const stats = await db.select({
      discordId: tickets.claimedBy,
      earnings: sql<number>`sum(${tickets.amount})::int`,
      count: sql<number>`count(*)::int`
    })
    .from(tickets)
    .where(
      and(
        sql`${tickets.claimedBy} is not null`,
        gt(tickets.amount, 0), // Check for positive amount instead of paid status
        // Use COALESCE to handle NULL completedAt values safely
        sql`COALESCE(${tickets.completedAt} >= ${startDate}, false)`,
        sql`COALESCE(${tickets.completedAt} <= ${adjustedEndDate}, false)`
      )
    )
    .groupBy(tickets.claimedBy)
    .orderBy(desc(sql<number>`sum(${tickets.amount})`));

    console.log(`Found ${stats.length} workers with tickets in the specified date range`);

    return stats.map(stat => ({
      discordId: stat.discordId!,
      username: stat.discordId!, // In real app, get from Discord
      totalEarnings: stat.earnings || 0,
      ticketCount: stat.count,
      periodStart: startDate,
      periodEnd: adjustedEndDate
    }));
  }

  async getActiveTicketByUserId(userId: number): Promise<Ticket | undefined> {
    console.log(`[DB] Checking for active tickets for user ${userId}`);
    
    // Get all tickets for this user that are not in a finalized state
    // This includes 'open', 'in-progress', 'pending', 'paid', but not 'closed', 'deleted', etc.
    try {
      // First, let's retrieve all active tickets to debug multiple ticket scenarios
      const activeTickets = await db
        .select()
        .from(tickets)
        .where(
          and(
            eq(tickets.userId, userId),
            // Consider any ticket not in a finalized state as "active"
            // Note: 'paid' status is included as active for user interaction purposes
            sql`(${tickets.status} NOT IN ('closed', 'deleted', 'transcript', 'completed'))`
          )
        )
        .orderBy(desc(tickets.id)); // Most recent first
      
      console.log(`[DB] Found ${activeTickets.length} potential active tickets for user ${userId}`);
      
      // Log all active tickets for debugging
      if (activeTickets.length > 0) {
        activeTickets.forEach(t => {
          console.log(`[DB] Active ticket candidate: #${t.id}, status: "${t.status}", category: ${t.categoryId}, channelId: ${t.discordChannelId || 'none'}`);
        });
        
        // Return the most recent ticket
        const [mostRecentTicket] = activeTickets;
        console.log(`[DB] Selected most recent active ticket #${mostRecentTicket.id} with status '${mostRecentTicket.status}' for user ${userId}`);
        return mostRecentTicket;
      } else {
        console.log(`[DB] No active tickets found for user ${userId}`);
        return undefined;
      }
    } catch (error) {
      console.error(`[DB] Error retrieving active ticket for user ${userId}:`, error);
      return undefined;
    }
  }
  
  // Get all active tickets for a user
  async getActiveTicketsByUserId(userId: number): Promise<Ticket[]> {
    console.log(`[DB] Retrieving all active tickets for user ${userId}`);
    
    // Get all tickets for this user that are not in a finalized state
    // This includes 'open', 'in-progress', 'pending', 'paid', but not 'closed', 'deleted', etc.
    const activeTickets = await db
      .select()
      .from(tickets)
      .where(
        and(
          eq(tickets.userId, userId),
          // Consider any ticket not in a finalized state as "active"
          // Note: 'paid' status is included as active for user interaction purposes
          sql`(${tickets.status} NOT IN ('closed', 'deleted', 'transcript', 'completed'))`
        )
      )
      .orderBy(desc(tickets.id)); // Most recent first
    
    // Log each active ticket for debugging purposes
    console.log(`[DB] Found ${activeTickets.length} active tickets for user ${userId}`);
    if (activeTickets.length > 0) {
      activeTickets.forEach(ticket => {
        console.log(`[DB] Active ticket: #${ticket.id}, status: ${ticket.status}, category: ${ticket.categoryId}, channelId: ${ticket.discordChannelId || 'none'}`);
      });
    }
    
    return activeTickets;
  }

  // Alternative method for photo handling, functionally equivalent to getActiveTicketByUserId
  async getNonClosedTicketByUserId(userId: number): Promise<Ticket | undefined> {
    console.log(`[DB] Checking for non-closed tickets for user ${userId} (for photo handling)`);
    
    // Get all non-closed tickets for this user
    // This includes 'open', 'in-progress', 'pending', 'paid', but not 'closed', 'deleted', etc.
    const [ticket] = await db
      .select()
      .from(tickets)
      .where(
        and(
          eq(tickets.userId, userId),
          // Consider any ticket not in a finalized state as "active"
          // Note: 'paid' status is included as active for user interaction purposes
          sql`(${tickets.status} NOT IN ('closed', 'deleted', 'transcript', 'completed'))`
        )
      )
      .orderBy(desc(tickets.id)) // Get the most recent ticket if multiple exist
      .limit(1);
    
    if (ticket) {
      console.log(`[DB] Found non-closed ticket ${ticket.id} with status '${ticket.status}' for photo upload from user ${userId}`);
    } else {
      console.log(`[DB] No non-closed tickets found for user ${userId} (photo handling)`);
    }
    
    return ticket;
  }
  async getTicketsByUserId(userId: number): Promise<Ticket[]> {
    return db
      .select()
      .from(tickets)
      .where(eq(tickets.userId, userId))
      .orderBy(desc(tickets.id));
  }

  // Message queue operations
  async queueMessage(message: InsertMessageQueue): Promise<MessageQueue> {
    const [queuedMessage] = await db
      .insert(messageQueue)
      .values(message)
      .returning();
    return queuedMessage;
  }

  async getUnprocessedMessages(limit = 50): Promise<MessageQueue[]> {
    return db
      .select()
      .from(messageQueue)
      .where(
        and(
          eq(messageQueue.processed, false),
          // Only get messages that have been attempted less than 5 times
          sql`${messageQueue.processingAttempts} < 5`
        )
      )
      .orderBy(messageQueue.timestamp)
      .limit(limit);
  }

  async markMessageProcessed(id: number): Promise<void> {
    await db
      .update(messageQueue)
      .set({ 
        processed: true
      })
      .where(eq(messageQueue.id, id));
  }

  async incrementMessageAttempt(id: number): Promise<void> {
    await db
      .update(messageQueue)
      .set({ 
        processingAttempts: sql`${messageQueue.processingAttempts} + 1`,
        lastAttempt: new Date()
      })
      .where(eq(messageQueue.id, id));
  }

  // User state persistence methods
  async saveUserState(userId: number, telegramId: string | number, state: string): Promise<void> {
    try {
      // Convert to numeric value for bigint column
      const numericId = typeof telegramId === 'string' ? parseInt(telegramId, 10) : telegramId;
      
      if (isNaN(numericId)) {
        console.log(`[DB] Invalid telegramId format in saveUserState: ${telegramId}`);
        throw new Error(`Invalid telegramId format: ${telegramId}`);
      }
      
      // First, deactivate any existing states for this telegram ID
      await db
        .update(userStates)
        .set({ isActive: false })
        .where(and(
          eq(userStates.telegramId, numericId),
          eq(userStates.isActive, true)
        ));
      
      // Then create a new active state
      await db.insert(userStates).values({
        userId,
        telegramId: numericId,
        state,
        timestamp: new Date(),
        isActive: true
      });
      
      console.log(`[DB] Saved user state for telegramId: ${telegramId}`);
    } catch (error) {
      console.error(`[DB] Error saving user state for telegramId: ${telegramId}`, error);
      throw error;
    }
  }

  async getUserStateByTelegramId(telegramId: string | number): Promise<string | undefined> {
    try {
      // Convert to numeric value for bigint column
      let numericId: number;
      
      if (typeof telegramId === 'string') {
        // Handle string IDs that might be too large for parseInt
        if (telegramId.length > 15) {
          try {
            // For very large numbers, use BigInt and convert back to Number
            numericId = Number(BigInt(telegramId));
            
            // If conversion results in NaN or infinity, handle gracefully
            if (!isFinite(numericId)) {
              console.log(`[DB] Telegram ID too large for safe conversion in getUserStateByTelegramId: ${telegramId}`);
              return undefined;
            }
          } catch (conversionError) {
            console.log(`[DB] Failed to convert large Telegram ID in getUserStateByTelegramId: ${telegramId}`, conversionError);
            return undefined;
          }
        } else {
          numericId = parseInt(telegramId, 10);
        }
      } else {
        numericId = telegramId;
      }
      
      if (isNaN(numericId)) {
        console.log(`[DB] Invalid telegramId format in getUserStateByTelegramId: ${telegramId}`);
        return undefined;
      }
      
      // Use a try-catch specifically for the database query
      try {
        const [userState] = await db
          .select()
          .from(userStates)
          .where(and(
            eq(userStates.telegramId, numericId),
            eq(userStates.isActive, true)
          ))
          .orderBy(desc(userStates.timestamp))
          .limit(1);
        
        if (userState) {
          console.log(`[DB] Found active user state for telegramId: ${telegramId}`);
          return userState.state;
        }
        
        console.log(`[DB] No active user state found for telegramId: ${telegramId}`);
        return undefined;
      } catch (dbError) {
        console.error(`[DB] Database error retrieving state for user ${telegramId}: ${dbError}`);
        
        // Try alternative approach for very large IDs
        if (String(telegramId).length > 15) {
          console.log(`[DB] Trying alternative lookup for state with large ID: ${telegramId}`);
          // This is a fallback to handle potential bigint conversion issues
          const allUserStates = await db
            .select()
            .from(userStates)
            .where(eq(userStates.isActive, true))
            .orderBy(desc(userStates.timestamp));
            
          const userState = allUserStates.find(u => String(u.telegramId) === String(telegramId));
          if (userState) {
            return userState.state;
          }
        }
        return undefined;
      }
    } catch (error) {
      console.error(`[DB] Error retrieving user state for telegramId: ${telegramId}`, error);
      return undefined;
    }
  }

  async deactivateUserState(telegramId: string | number): Promise<void> {
    try {
      // Convert to numeric value for bigint column
      let numericId: number;
      
      if (typeof telegramId === 'string') {
        // Handle string IDs that might be too large for parseInt
        if (telegramId.length > 15) {
          try {
            // For very large numbers, use BigInt and convert back to Number
            numericId = Number(BigInt(telegramId));
            
            // If conversion results in NaN or infinity, handle gracefully
            if (!isFinite(numericId)) {
              console.log(`[DB] Telegram ID too large for safe conversion in deactivateUserState: ${telegramId}`);
              // Don't throw error, but return early since we can't proceed
              return;
            }
          } catch (conversionError) {
            console.log(`[DB] Failed to convert large Telegram ID in deactivateUserState: ${telegramId}`, conversionError);
            // Don't throw error, but return early since we can't proceed
            return;
          }
        } else {
          numericId = parseInt(telegramId, 10);
        }
      } else {
        numericId = telegramId;
      }
      
      if (isNaN(numericId)) {
        console.log(`[DB] Invalid telegramId format in deactivateUserState: ${telegramId}`);
        return;
      }
      
      // Use a try-catch specifically for the database query
      try {
        await db
          .update(userStates)
          .set({ isActive: false })
          .where(and(
            eq(userStates.telegramId, numericId),
            eq(userStates.isActive, true)
          ));
        
        console.log(`[DB] Deactivated all user states for telegramId: ${telegramId}`);
      } catch (dbError) {
        console.error(`[DB] Database error deactivating state for user ${telegramId}: ${dbError}`);
        
        // Try alternative approach for very large IDs
        if (String(telegramId).length > 15) {
          try {
            console.log(`[DB] Trying alternative deactivation for state with large ID: ${telegramId}`);
            
            // Get all active states
            const activeStates = await db
              .select()
              .from(userStates)
              .where(eq(userStates.isActive, true));
              
            // Find the ones with matching telegram ID (as string comparison)
            const targetStates = activeStates.filter(u => String(u.telegramId) === String(telegramId));
            
            // If any found, update them one by one
            if (targetStates.length > 0) {
              for (const state of targetStates) {
                await db
                  .update(userStates)
                  .set({ isActive: false })
                  .where(eq(userStates.id, state.id));
              }
              console.log(`[DB] Deactivated ${targetStates.length} states using ID-based lookup for ${telegramId}`);
            }
          } catch (fallbackError) {
            console.error(`[DB] Fallback approach failed for user ${telegramId}:`, fallbackError);
          }
        }
      }
    } catch (error) {
      console.error(`[DB] Error deactivating user states for telegramId: ${telegramId}`, error);
      // Don't throw error to avoid crashing the application
      // This is a non-critical operation that can be retried
    }
  }
}

// Export the DatabaseStorage instance
export const storage = new DatabaseStorage();