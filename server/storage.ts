import { eq, and, desc, sql, or } from 'drizzle-orm';
import { db } from './db';
import {
  users, categories, tickets, messages, botConfig, messageQueue, userStates,
  type User, type Category, type Ticket, type Message, type BotConfig, type MessageQueue, type UserState,
  type InsertUser, type InsertCategory, type InsertTicket, type InsertMessage, type InsertBotConfig, 
  type InsertMessageQueue, type InsertUserState
} from '@shared/schema';
import { log } from './vite';

export interface IStorage {
  // Bot config operations
  getBotConfig(): Promise<BotConfig | undefined>;
  updateBotConfig(config: Partial<InsertBotConfig>): Promise<BotConfig>;
  isAdmin(telegramId: string): Promise<boolean>;
  isDiscordAdmin(discordId: string): Promise<boolean>;
  
  // Message queue operations
  queueMessage(message: InsertMessageQueue): Promise<MessageQueue>;
  getUnprocessedMessages(limit?: number): Promise<MessageQueue[]>;
  markMessageProcessed(id: number): Promise<void>;
  incrementMessageAttempt(id: number): Promise<void>;

  // User operations
  getUser(id: number): Promise<User | undefined>;
  getUsers(): Promise<User[]>;  // Get all users
  getUserByTelegramId(telegramId: string): Promise<User | undefined>;
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
  // Method for getting any non-closed ticket (including pending) - used for photo handling
  getNonClosedTicketByUserId(userId: number): Promise<Ticket | undefined>;
  // Method for getting tickets by user ID
  getTicketsByUserId(userId: number): Promise<Ticket[]>;
  
  // User state persistence
  saveUserState(userId: number, telegramId: string, state: string): Promise<void>;
  getUserStateByTelegramId(telegramId: string): Promise<string | undefined>;
  deactivateUserState(telegramId: string): Promise<void>;
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
  
  async isAdmin(telegramId: string): Promise<boolean> {
    const config = await this.getBotConfig();
    if (!config?.adminTelegramIds || config.adminTelegramIds.length === 0) {
      return false;
    }
    return config.adminTelegramIds.includes(telegramId);
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
  async getUser(id: number): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUsers(): Promise<User[]> {
    return db.select().from(users);
  }

  async getUserByTelegramId(telegramId: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.telegramId, telegramId));
    return user;
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
    const [user] = await db.insert(users).values(insertUser).returning();
    return user;
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
      await db
        .update(tickets)
        .set({ 
          status, 
          claimedBy: claimedBy || null,
          ...(['closed', 'deleted', 'transcript', 'completed'].includes(status) ? { completedAt: new Date() } : {})
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
      .where(eq(tickets.status, 'closed'))
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
    await db
      .update(tickets)
      .set({ 
        amount, 
        claimedBy, 
        status: 'paid',
        completedAt: new Date()
      })
      .where(eq(tickets.id, id));
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
        eq(tickets.status, 'paid')
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
        eq(tickets.status, 'paid')
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
        eq(tickets.status, 'paid')
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
    const now = new Date();
    let periodStart = new Date(0);
    const periodEnd = now;

    if (period === 'week') {
      periodStart = new Date(now);
      periodStart.setDate(now.getDate() - now.getDay());
      periodStart.setHours(0, 0, 0, 0);
    } else if (period === 'month') {
      periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    }

    const result = await db.select({
      earnings: sql<number>`sum(${tickets.amount})::int`,
      count: sql<number>`count(*)::int`
    })
    .from(tickets)
    .where(
      and(
        eq(tickets.claimedBy, discordId),
        eq(tickets.status, 'paid'),
        sql`${tickets.completedAt} >= ${periodStart}`,
        sql`${tickets.completedAt} <= ${periodEnd}`
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
        eq(tickets.status, 'paid'),
        sql`${tickets.completedAt} >= ${periodStart}`,
        sql`${tickets.completedAt} <= ${periodEnd}`
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
    const now = new Date();
    let periodStart = new Date(0);
    const periodEnd = now;

    if (period === 'week') {
      periodStart = new Date(now);
      periodStart.setDate(now.getDate() - now.getDay());
      periodStart.setHours(0, 0, 0, 0);
    } else if (period === 'month') {
      periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    }

    const stats = await db.select({
      discordId: tickets.claimedBy,
      earnings: sql<number>`sum(${tickets.amount})::int`,
      count: sql<number>`count(*)::int`
    })
    .from(tickets)
    .where(
      and(
        sql`${tickets.claimedBy} is not null`,
        eq(tickets.status, 'paid'),
        sql`${tickets.completedAt} >= ${periodStart}`,
        sql`${tickets.completedAt} <= ${periodEnd}`
      )
    )
    .groupBy(tickets.claimedBy)
    .orderBy(desc(sql<number>`sum(${tickets.amount})`));

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
    
    // Log for debugging purposes
    console.log(`Querying stats with range: ${startDate.toISOString()} to ${adjustedEndDate.toISOString()}`);
    
    const result = await db.select({
      earnings: sql<number>`sum(${tickets.amount})::int`,
      count: sql<number>`count(*)::int`
    })
    .from(tickets)
    .where(
      and(
        eq(tickets.claimedBy, discordId),
        eq(tickets.status, 'paid'),
        sql`${tickets.completedAt} >= ${startDate}`,
        sql`${tickets.completedAt} <= ${adjustedEndDate}`
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
        eq(tickets.status, 'paid'),
        sql`${tickets.completedAt} >= ${startDate}`,
        sql`${tickets.completedAt} <= ${adjustedEndDate}`
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
    
    // Log for debugging purposes
    console.log(`Querying all worker stats with range: ${startDate.toISOString()} to ${adjustedEndDate.toISOString()}`);
    
    const stats = await db.select({
      discordId: tickets.claimedBy,
      earnings: sql<number>`sum(${tickets.amount})::int`,
      count: sql<number>`count(*)::int`
    })
    .from(tickets)
    .where(
      and(
        sql`${tickets.claimedBy} is not null`,
        eq(tickets.status, 'paid'),
        sql`${tickets.completedAt} >= ${startDate}`,
        sql`${tickets.completedAt} <= ${adjustedEndDate}`
      )
    )
    .groupBy(tickets.claimedBy)
    .orderBy(desc(sql<number>`sum(${tickets.amount})`));

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
    // This includes 'open', 'in-progress', 'pending', but not 'closed', 'deleted', etc.
    const [ticket] = await db
      .select()
      .from(tickets)
      .where(
        and(
          eq(tickets.userId, userId),
          // Consider any ticket not in a finalized state as "active"
          sql`(${tickets.status} NOT IN ('closed', 'deleted', 'transcript', 'completed'))`
        )
      )
      .orderBy(desc(tickets.id)) // Get the most recent ticket if multiple exist
      .limit(1);
    
    if (ticket) {
      console.log(`[DB] Found active ticket ${ticket.id} with status '${ticket.status}' for user ${userId}`);
    } else {
      console.log(`[DB] No active tickets found for user ${userId}`);
    }
    
    return ticket;
  }

  // Alternative method for photo handling, functionally equivalent to getActiveTicketByUserId
  async getNonClosedTicketByUserId(userId: number): Promise<Ticket | undefined> {
    console.log(`[DB] Checking for non-closed tickets for user ${userId} (for photo handling)`);
    
    // Get all non-closed tickets for this user
    const [ticket] = await db
      .select()
      .from(tickets)
      .where(
        and(
          eq(tickets.userId, userId),
          // Consider any ticket not in a finalized state
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
  async saveUserState(userId: number, telegramId: string, state: string): Promise<void> {
    try {
      // First, deactivate any existing states for this telegram ID
      await db
        .update(userStates)
        .set({ isActive: false })
        .where(and(
          eq(userStates.telegramId, telegramId),
          eq(userStates.isActive, true)
        ));
      
      // Then create a new active state
      await db.insert(userStates).values({
        userId,
        telegramId,
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

  async getUserStateByTelegramId(telegramId: string): Promise<string | undefined> {
    try {
      const [userState] = await db
        .select()
        .from(userStates)
        .where(and(
          eq(userStates.telegramId, telegramId),
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
    } catch (error) {
      console.error(`[DB] Error retrieving user state for telegramId: ${telegramId}`, error);
      return undefined;
    }
  }

  async deactivateUserState(telegramId: string): Promise<void> {
    try {
      await db
        .update(userStates)
        .set({ isActive: false })
        .where(and(
          eq(userStates.telegramId, telegramId),
          eq(userStates.isActive, true)
        ));
      
      console.log(`[DB] Deactivated all user states for telegramId: ${telegramId}`);
    } catch (error) {
      console.error(`[DB] Error deactivating user states for telegramId: ${telegramId}`, error);
      throw error;
    }
  }
}

// Export the DatabaseStorage instance
export const storage = new DatabaseStorage();