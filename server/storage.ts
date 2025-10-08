import { eq, and, desc, sql, or, gt, gte, lte, inArray } from 'drizzle-orm';
import { db } from './db';
import {
  users, categories, tickets, messages, botConfig, messageQueue, userStates,
  earningsLedger, earningsAdjustments, workerEarningsSummary, categorySubmenuRelations,
  adminRoles, roleCategoryPermissions,
  type User, type Category, type Ticket, type Message, type BotConfig, type MessageQueue, type UserState,
  type EarningsLedger, type EarningsAdjustment, type WorkerEarningsSummary,
  type AdminRole, type RoleCategoryPermission,
  type InsertUser, type InsertCategory, type InsertTicket, type InsertMessage, type InsertBotConfig, 
  type InsertMessageQueue, type InsertUserState, type InsertEarningsLedger, type InsertEarningsAdjustment, type InsertWorkerEarningsSummary,
  type InsertAdminRole, type InsertRoleCategoryPermission
} from '@shared/schema';
import { log } from './vite';
import { z } from "zod";

const telegramIdSchema = z.string().regex(/^[0-9]{5,20}$/);

// Add simple in-memory caching to reduce database queries
const cache = {
  categories: null as Category[] | null,
  botConfig: null as BotConfig | null,
  lastCacheTime: 0,
  CACHE_DURATION: 5 * 60 * 1000, // 5 minutes
  statsQueries: 0,
  lastStatsQuery: 0,
  STATS_RATE_LIMIT: 30, // Max 30 stats queries per minute
  STATS_RATE_WINDOW: 60 * 1000 // 1 minute window
};

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

// Helper function to check if cache is valid
function isCacheValid(): boolean {
  return cache.lastCacheTime > 0 && (Date.now() - cache.lastCacheTime) < cache.CACHE_DURATION;
}

// Helper function to clear cache
function clearCache(): void {
  cache.categories = null;
  cache.botConfig = null;
  cache.lastCacheTime = 0;
}

// Helper function to check stats query rate limit
function checkStatsRateLimit(): boolean {
  const now = Date.now();
  
  // Reset counter if window has passed
  if (now - cache.lastStatsQuery > cache.STATS_RATE_WINDOW) {
    cache.statsQueries = 0;
    cache.lastStatsQuery = now;
  }
  
  // Check if we're within rate limit
  if (cache.statsQueries >= cache.STATS_RATE_LIMIT) {
    log(`Stats query rate limit exceeded. Skipping query to save database compute time.`, "warn");
    return false;
  }
  
  cache.statsQueries++;
  return true;
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
  
  // Category-Submenu relationship operations
  getCategorySubmenus(categoryId: number): Promise<number[]>;
  setCategorySubmenus(categoryId: number, submenuIds: number[]): Promise<boolean>;
  getSubmenuCategories(submenuId: number): Promise<Category[]>;

  // Ticket operations  
  createTicket(ticket: InsertTicket): Promise<Ticket>;
  getTicket(id: number): Promise<Ticket | undefined>;
  getTicketByDiscordChannel(channelId: string): Promise<Ticket | undefined>;
  getAllTicketsWithStatuses(statuses: string[]): Promise<Ticket[]>; // Get tickets by their status values
  updateTicket(id: number, data: Partial<InsertTicket>): Promise<Ticket | undefined>; // Generic update method
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
  getRecentMessagesFromUser(userId: number, limit: number): Promise<Message[]>;

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
  saveUserState(userId: number, telegramId: string, state: string): Promise<void>;
  getUserStateByTelegramId(telegramId: string): Promise<string | undefined>;
  deactivateUserState(telegramId: string | number): Promise<void>;

  // Earnings operations
  addEarningsAdjustment(workerId: string, amount: number, reason: string): Promise<void>;
  editEarningsAdjustment(id: number, amount: number, reason: string): Promise<void>;
  deleteEarningsAdjustment(id: number): Promise<void>;
  clearAllStatistics(): Promise<void>;
  ensureDiscordWorkerExists(discordId: string): Promise<void>;
  updateWorkerUsername(discordId: string, username: string): Promise<void>;
  refreshAllWorkerUsernames(): Promise<number>;

  // Admin role operations
  createAdminRole(role: InsertAdminRole): Promise<AdminRole>;
  getAdminRoles(): Promise<AdminRole[]>;
  getAdminRole(id: number): Promise<AdminRole | undefined>;
  getAdminRoleByDiscordId(discordRoleId: string): Promise<AdminRole | undefined>;
  updateAdminRole(id: number, role: Partial<InsertAdminRole>): Promise<AdminRole | undefined>;
  deleteAdminRole(id: number): Promise<void>;
  
  // Role-category permission operations
  setRoleCategoryPermissions(roleId: number, categoryIds: number[]): Promise<boolean>;
  getRoleCategoryPermissions(roleId: number): Promise<number[]>;
  getCategoryRolePermissions(categoryId: number): Promise<number[]>;
  
  // Permission checking
  getUserAllowedCategories(discordUserId: string): Promise<number[]>;
  canUserAccessCategory(discordUserId: string, categoryId: number): Promise<boolean>;
  isUserFullAdmin(discordUserId: string): Promise<boolean>;
}

export class DatabaseStorage implements IStorage {
  // Bot config operations
  async getBotConfig(): Promise<BotConfig | undefined> {
    if (isCacheValid()) {
      return cache.botConfig;
    }
    const [config] = await db.select().from(botConfig).limit(1);
    if (!config) {
      // Return default config if none exists
      const defaultConfig = {
        id: 1,
        welcomeMessage: "Welcome to the support bot! Please select a service:",
        welcomeImageUrl: null,
        telegramToken: null,
        discordToken: null,
        adminTelegramIds: [],
        adminDiscordIds: []
      };
      cache.botConfig = defaultConfig;
      return defaultConfig;
    }
    cache.botConfig = config;
    cache.lastCacheTime = Date.now();
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
      cache.botConfig = updated;
      cache.lastCacheTime = Date.now();
      return updated;
    } else {
      const [created] = await db
        .insert(botConfig)
        .values({ ...config, id: 1 })
        .returning();
      cache.botConfig = created;
      cache.lastCacheTime = Date.now();
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

  async getUserByTelegramId(telegramId: string): Promise<User | undefined> {
    try {
      // Validate telegramId
      telegramIdSchema.parse(telegramId);
      const [user] = await db.select().from(users).where(eq(users.telegramId, telegramId));
      return user;
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
      if (insertUser.telegramId) {
        telegramIdSchema.parse(insertUser.telegramId);
      }
      console.log(`[DB] Creating user with values: ${JSON.stringify(insertUser)}`);
      try {
        const [user] = await db.insert(users).values(insertUser).returning();
        console.log(`[DB] Created user: ${JSON.stringify(user)}`);
        return user;
      } catch (dbError: any) {
        console.error(`[DB] Database error creating user:`, dbError);
        
        // Handle sequence synchronization issues
        if (dbError.code === '23505' && dbError.detail?.includes('already exists')) {
          log(`User sequence out of sync detected. Attempting to fix...`, "warn");
          
          try {
            // Fix the sequence by setting it to the max ID + 1
            await db.execute(sql`
              SELECT setval('users_id_seq', (SELECT COALESCE(MAX(id), 0) + 1 FROM users), false)
            `);
            
            log(`User sequence fixed. Retrying user creation...`, "info");
            
            // Retry the insert
            const [user] = await db.insert(users).values(insertUser).returning();
            console.log(`[DB] Created user after sequence fix: ${JSON.stringify(user)}`);
            return user;
          } catch (retryError: any) {
            log(`Failed to fix user sequence and retry: ${retryError.message}`, "error");
            // Continue to the existing duplicate handling logic
          }
        }
        
        // If this was a duplicate key error, try to find the existing user
        const error = dbError as Error;
        if (insertUser.telegramId && error.message?.includes('duplicate')) {
          console.log(`[DB] Possible duplicate user, checking if user already exists with telegramId: ${insertUser.telegramId}`);
          // Look up the existing user
          const existingUser = await this.getUserByTelegramId(insertUser.telegramId);
          if (existingUser) {
            console.log(`[DB] Found existing user with telegramId ${insertUser.telegramId}: ${JSON.stringify(existingUser)}`);
            return existingUser;
          }
        }
        throw dbError;
      }
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
    if (isCacheValid() && cache.categories) {
      return cache.categories;
    }
    // Sort categories by displayOrder (ascending), then by name (alphabetically)
    const categoryList = await db.select()
      .from(categories)
      .orderBy(categories.displayOrder, categories.name);
    cache.categories = categoryList;
    cache.lastCacheTime = Date.now();
    return categoryList;
  }

  async getCategory(id: number): Promise<Category | undefined> {
    const [category] = await db.select().from(categories).where(eq(categories.id, id));
    return category;
  }

  async createCategory(insertCategory: InsertCategory): Promise<Category> {
    try {
      const [category] = await db.insert(categories).values(insertCategory).returning();
      cache.categories = null;
      return category;
    } catch (error: any) {
      // Handle sequence synchronization issues
      if (error.code === '23505' && error.detail?.includes('already exists')) {
        log(`Sequence out of sync detected. Attempting to fix...`, "warn");
        
        try {
          // Fix the sequence by setting it to the max ID + 1
          await db.execute(sql`
            SELECT setval('categories_id_seq', (SELECT COALESCE(MAX(id), 0) + 1 FROM categories), false)
          `);
          
          log(`Sequence fixed. Retrying category creation...`, "info");
          
          // Retry the insert
          const [category] = await db.insert(categories).values(insertCategory).returning();
          cache.categories = null;
          return category;
        } catch (retryError: any) {
          log(`Failed to fix sequence and retry: ${retryError.message}`, "error");
          throw error; // Throw the original error if retry fails
        }
      }
      
      throw error;
    }
  }

  async updateCategory(id: number, updateData: Partial<InsertCategory>): Promise<Category | undefined> {
    const [category] = await db
      .update(categories)
      .set(updateData)
      .where(eq(categories.id, id))
      .returning();
    cache.categories = null;
    return category;
  }

  async deleteCategory(id: number): Promise<void> {
    // First delete all submenu relations for this category
    await db.delete(categorySubmenuRelations).where(eq(categorySubmenuRelations.categoryId, id));
    
    // Then delete the category itself
    await db.delete(categories).where(eq(categories.id, id));
    cache.categories = null;
  }

  // New methods for handling many-to-many relationships
  async getCategorySubmenus(categoryId: number): Promise<number[]> {
    try {
      const relations = await db
        .select({ submenuId: categorySubmenuRelations.submenuId })
        .from(categorySubmenuRelations)
        .where(eq(categorySubmenuRelations.categoryId, categoryId));
      
      return relations.map(r => r.submenuId);
    } catch (error) {
      log(`Error getting category submenus: ${error}`, "error");
      return [];
    }
  }

  async setCategorySubmenus(categoryId: number, submenuIds: number[]): Promise<boolean> {
    try {
      // First, remove all existing relations for this category
      await db.delete(categorySubmenuRelations).where(eq(categorySubmenuRelations.categoryId, categoryId));
      
      // Then, add the new relations
      if (submenuIds.length > 0) {
        const relations = submenuIds.map((submenuId, index) => ({
          categoryId,
          submenuId,
          displayOrder: index
        }));
        
        await db.insert(categorySubmenuRelations).values(relations);
      }
      
      cache.categories = null;
      return true;
    } catch (error) {
      log(`Error setting category submenus: ${error}`, "error");
      return false;
    }
  }

  async getSubmenuCategories(submenuId: number): Promise<Category[]> {
    try {
      const relations = await db
        .select({ 
          categoryId: categorySubmenuRelations.categoryId,
          displayOrder: categorySubmenuRelations.displayOrder
        })
        .from(categorySubmenuRelations)
        .where(eq(categorySubmenuRelations.submenuId, submenuId))
        .orderBy(categorySubmenuRelations.displayOrder);
      
      if (relations.length === 0) {
        return [];
      }
      
      const categoryIds = relations.map(r => r.categoryId);
      const categories = await db
        .select()
        .from(categories)
        .where(inArray(categories.id, categoryIds));
      
      // Sort by the display order from relations
      const sortedCategories = relations.map(relation => 
        categories.find(cat => cat.id === relation.categoryId)
      ).filter(Boolean) as Category[];
      
      return sortedCategories;
    } catch (error) {
      log(`Error getting submenu categories: ${error}`, "error");
      return [];
    }
  }

  // Ticket operations
  async createTicket(insertTicket: InsertTicket): Promise<Ticket> {
    try {
      const [ticket] = await db.insert(tickets).values(insertTicket).returning();
      return ticket;
    } catch (error: any) {
      // Handle sequence synchronization issues
      if (error.code === '23505' && error.detail?.includes('already exists')) {
        log(`Ticket sequence out of sync detected. Attempting to fix...`, "warn");
        
        try {
          // Fix the sequence by setting it to the max ID + 1
          await db.execute(sql`
            SELECT setval('tickets_id_seq', (SELECT COALESCE(MAX(id), 0) + 1 FROM tickets), false)
          `);
          
          log(`Ticket sequence fixed. Retrying ticket creation...`, "info");
          
          // Retry the insert
          const [ticket] = await db.insert(tickets).values(insertTicket).returning();
          return ticket;
        } catch (retryError: any) {
          log(`Failed to fix ticket sequence and retry: ${retryError.message}`, "error");
          throw error; // Throw the original error if retry fails
        }
      }
      
      throw error;
    }
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
  
  async getAllTicketsWithStatuses(statuses: string[]): Promise<Ticket[]> {
    try {
      console.log(`[DB] Getting all tickets with statuses: ${statuses.join(', ')}`);
      
      // Using Drizzle's SQL or operator to find tickets with any of the specified statuses
      // since inArray is not directly available in this version of Drizzle
      const ticketsFound = await db
        .select()
        .from(tickets)
        .where(
          // Create an OR condition for each status
          or(...statuses.map(status => eq(tickets.status, status)))
        );
      
      console.log(`[DB] Found ${ticketsFound.length} tickets with the specified statuses`);
      return ticketsFound;
    } catch (error) {
      console.error(`[DB] Error getting tickets by statuses: ${error}`);
      return [];
    }
  }

  /**
   * Generic method to update any ticket properties
   * @param id Ticket ID
   * @param data Partial ticket data to update
   * @returns The updated ticket or undefined if not found
   */
  async updateTicket(id: number, data: Partial<InsertTicket>): Promise<Ticket | undefined> {
    try {
      console.log(`[DB] Updating ticket ${id} with data: ${JSON.stringify(data)}`);
      
      // First query to verify ticket exists
      const [ticketBefore] = await db.select().from(tickets).where(eq(tickets.id, id));
      if (!ticketBefore) {
        console.error(`[DB] Failed to update ticket: Ticket ${id} not found`);
        return undefined;
      }
      
      // Perform the update
      const [updatedTicket] = await db
        .update(tickets)
        .set(data)
        .where(eq(tickets.id, id))
        .returning();
        
      console.log(`[DB] Successfully updated ticket ${id}`);
      return updatedTicket;
    } catch (error) {
      console.error(`[DB] Error in updateTicket: ${error}`);
      throw error;
    }
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

      // If someone is claiming the ticket or marking it as completed/paid, ensure they exist in the users table
      if (claimedBy && (status === 'in-progress' || status === 'completed' || status === 'paid' || status === 'closed')) {
        await this.ensureDiscordWorkerExists(claimedBy);
      }

      // If closing/deleting a paid ticket, preserve payment data BEFORE status change
      if (['closed', 'deleted', 'transcript', 'completed'].includes(status) && 
          ticketBefore.amount > 0 && ticketBefore.claimedBy) {
        
        // Check if this payment is already recorded to prevent duplicates
        const existingEntry = await db.select()
          .from(earningsLedger)
          .where(and(
            eq(earningsLedger.ticketId, ticketBefore.id),
            eq(earningsLedger.workerId, ticketBefore.claimedBy),
            eq(earningsLedger.type, 'ticket_payment')
          ));
        
        // Only record if not already in earnings ledger
        if (existingEntry.length === 0) {
          await db.insert(earningsLedger).values({
            workerId: ticketBefore.claimedBy,
            ticketId: ticketBefore.id,
            categoryId: ticketBefore.categoryId || 0,
            amount: ticketBefore.amount,
            type: 'ticket_payment',
            reason: `Payment preserved from ${status} ticket`,
            status: 'confirmed',
            createdAt: new Date(),
            confirmedAt: new Date(),
            confirmedBy: 'system'
          });
          
          // Update worker earnings summary
          await this.updateWorkerEarningsSummary(ticketBefore.claimedBy, ticketBefore.amount);
          
          log(`Preserved payment of $${ticketBefore.amount} for worker ${ticketBefore.claimedBy} from ${status} ticket ${id}`, "info");
        } else {
          log(`Payment for ticket ${id} already exists in earnings ledger, skipping duplicate entry`, "info");
        }
      }

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
      
      // If ticket was closed/deleted, notify the Telegram user and update their state
      if (['closed', 'deleted', 'transcript', 'completed'].includes(status) && ticketBefore.userId) {
        try {
          // Get the user who owns this ticket
          const user = await this.getUser(ticketBefore.userId);
          if (user?.telegramId) {
            // Use the bridge manager to send notification instead of creating new bot instance
            const { BridgeManager } = await import('./bot/bridge');
            const bridge = BridgeManager.getInstance();
            
            // Send notification to user
            const statusMessage = status === 'closed' ? 'closed' : 
                                status === 'deleted' ? 'deleted' : 
                                status === 'transcript' ? 'moved to transcripts' : 'completed';
            
            await bridge.sendMessageToTelegram(
              user.telegramId,
              `📋 **Ticket #${id} has been ${statusMessage}**\n\n` +
              `Your ticket has been ${statusMessage} by our staff. ` +
              `If you have other active tickets, you can continue using those, or use /start to create a new ticket.`
            );
            
            // Update user state to remove this ticket from their active ticket
            const telegramBot = bridge.getTelegramBot();
            const userState = telegramBot.getUserState(user.telegramId);
            if (userState && userState.activeTicketId === id) {
              userState.activeTicketId = undefined;
              await telegramBot.setState(user.telegramId, userState);
              log(`Updated user ${user.telegramId} state to remove closed ticket ${id}`, "info");
            }
            
            log(`Notified user ${user.telegramId} about ticket ${id} being ${status}`, "info");
          }
        } catch (notificationError) {
          log(`Failed to notify user about ticket ${id} closure: ${notificationError}`, "error");
          // Don't throw error - ticket closure should succeed even if notification fails
        }
      }
      
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
      // Get the ticket before deleting
      const [ticket] = await db.select().from(tickets).where(eq(tickets.id, id));
      
      if (!ticket) {
        throw new Error(`Ticket ${id} not found`);
      }
      
      // If ticket has payment data, preserve it in earnings ledger BEFORE deleting
      if (ticket.amount > 0 && ticket.claimedBy) {
        // Check if this payment is already recorded in earnings ledger
        const existingEntry = await db.select()
          .from(earningsLedger)
          .where(and(
            eq(earningsLedger.ticketId, ticket.id),
            eq(earningsLedger.workerId, ticket.claimedBy),
            eq(earningsLedger.type, 'ticket_payment')
          ));
        
        // Only record if not already in earnings ledger
        if (existingEntry.length === 0) {
          await db.insert(earningsLedger).values({
            workerId: ticket.claimedBy,
            ticketId: ticket.id,
            categoryId: ticket.categoryId || 0,
            amount: ticket.amount,
            type: 'ticket_payment',
            reason: 'Payment preserved from deleted ticket',
            status: 'confirmed',
            createdAt: new Date(),
            confirmedAt: new Date(),
            confirmedBy: 'system'
          });
          
          // Update worker earnings summary
          await this.updateWorkerEarningsSummary(ticket.claimedBy, ticket.amount);
          
          log(`Preserved payment of $${ticket.amount} for worker ${ticket.claimedBy} from deleted ticket ${id}`, "info");
        } else {
          log(`Payment for ticket ${id} already exists in earnings ledger, skipping duplicate entry`, "info");
        }
      }
      
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
      
      // Notify the Telegram user about ticket deletion and update their state
      if (ticket.userId) {
        try {
          // Get the user who owns this ticket
          const user = await this.getUser(ticket.userId);
          if (user?.telegramId) {
            // Use the bridge manager to send notification instead of creating new bot instance
            const { BridgeManager } = await import('./bot/bridge');
            const bridge = BridgeManager.getInstance();
            
            // Send notification to user
            await bridge.sendMessageToTelegram(
              user.telegramId,
              `🗑️ **Ticket #${id} has been deleted**\n\n` +
              `Your ticket has been deleted by our staff. ` +
              `If you have other active tickets, you can continue using those, or use /start to create a new ticket.`
            );
            
            // Update user state to remove this ticket from their active ticket
            const telegramBot = bridge.getTelegramBot();
            const userState = telegramBot.getUserState(user.telegramId);
            if (userState && userState.activeTicketId === id) {
              userState.activeTicketId = undefined;
              await telegramBot.setState(user.telegramId, userState);
              log(`Updated user ${user.telegramId} state to remove deleted ticket ${id}`, "info");
            }
            
            log(`Notified user ${user.telegramId} about ticket ${id} being deleted`, "info");
          }
        } catch (notificationError) {
          log(`Failed to notify user about ticket ${id} deletion: ${notificationError}`, "error");
          // Don't throw error - ticket deletion should succeed even if notification fails
        }
      }
      
    } catch (error) {
      console.error(`Error deleting ticket ${id}:`, error);
      throw error;
    }
  }

  // Message operations
  async createMessage(insertMessage: InsertMessage): Promise<Message> {
    try {
      const [message] = await db.insert(messages).values(insertMessage).returning();
      return message;
    } catch (error: any) {
      // Handle sequence synchronization issues
      if (error.code === '23505' && error.detail?.includes('already exists')) {
        log(`Message sequence out of sync detected. Attempting to fix...`, "warn");
        
        try {
          // Fix the sequence by setting it to the max ID + 1
          await db.execute(sql`
            SELECT setval('messages_id_seq', (SELECT COALESCE(MAX(id), 0) + 1 FROM messages), false)
          `);
          
          log(`Message sequence fixed. Retrying message creation...`, "info");
          
          // Retry the insert
          const [message] = await db.insert(messages).values(insertMessage).returning();
          return message;
        } catch (retryError: any) {
          log(`Failed to fix message sequence and retry: ${retryError.message}`, "error");
          throw error; // Throw the original error if retry fails
        }
      }
      
      throw error;
    }
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
    // Limit to prevent expensive queries
    const safeLimit = Math.min(limit, 100);
    return db
      .select()
      .from(messages)
      .where(sql`${messages.attachments} is not null`)
      .orderBy(desc(messages.timestamp))
      .limit(safeLimit);
  }
  
  // Get recent messages from a specific user (to determine active ticket)
  async getRecentMessagesFromUser(userId: number, limit: number = 10): Promise<Message[]> {
    // Limit to prevent expensive queries
    const safeLimit = Math.min(limit, 50);
    return db
      .select()
      .from(messages)
      .where(eq(messages.authorId, userId))
      .orderBy(desc(messages.timestamp))
      .limit(safeLimit);
  }

  // Stats operations
  async updateTicketPayment(id: number, amount: number, claimedBy: string): Promise<void> {
    try {
      // Ensure the worker exists in the users table
      await this.ensureDiscordWorkerExists(claimedBy);
      
      // Get the ticket to get category information
      const ticket = await this.getTicket(id);
      if (!ticket) {
        throw new Error(`Ticket ${id} not found`);
      }

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

      // Record the payment in the persistent earnings ledger
      await this.recordTicketPayment(
        id, 
        claimedBy, 
        amount, 
        ticket.categoryId || 0, 
        `Payment for ticket #${id}`
      );
      
      console.log(`Recorded persistent payment of $${amount} for worker ${claimedBy} on ticket ${id}`);
    } catch (error: any) {
      console.error(`Failed to update ticket payment: ${error.message}`);
      throw error;
    }
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
    try {
      // Get persistent earnings from the ledger
      const ledgerResult = await db.select({
        totalEarnings: sql<number>`COALESCE(SUM(${earningsLedger.amount}), 0)::int`,
        totalTickets: sql<number>`COUNT(*)::int`
      })
      .from(earningsLedger)
      .where(and(
        eq(earningsLedger.workerId, discordId),
        eq(earningsLedger.status, 'confirmed'),
        eq(earningsLedger.type, 'ticket_payment')
      ));

      // Get category stats from the ledger
      const categoryStats = await db.select({
        categoryId: earningsLedger.categoryId,
        categoryName: categories.name,
        earnings: sql<number>`SUM(${earningsLedger.amount})::int`,
        ticketCount: sql<number>`COUNT(*)::int`
      })
      .from(earningsLedger)
      .leftJoin(categories, eq(earningsLedger.categoryId, categories.id))
      .where(and(
        eq(earningsLedger.workerId, discordId),
        eq(earningsLedger.status, 'confirmed'),
        eq(earningsLedger.type, 'ticket_payment')
      ))
      .groupBy(earningsLedger.categoryId, categories.name);

      return {
        totalEarnings: ledgerResult[0]?.totalEarnings || 0,
        ticketCount: ledgerResult[0]?.totalTickets || 0,
        categoryStats: categoryStats.map(stat => ({
          categoryId: stat.categoryId || 0,
          categoryName: stat.categoryName || 'Unknown',
          earnings: stat.earnings || 0,
          ticketCount: stat.ticketCount || 0
        }))
      };
    } catch (error: any) {
      log(`Failed to get user stats for ${discordId}: ${error.message}`, "error");
      return {
        totalEarnings: 0,
        ticketCount: 0,
        categoryStats: []
      };
    }
  }

  async getAllWorkerStats(): Promise<Array<{
    discordId: string;
    username: string;
    totalEarnings: number;
    ticketCount: number;
  }>> {
    // Get all workers (users with at least one ticket, adjustment, or ledger entry)
    const workers = await db.select({
      discordId: users.discordId,
      username: users.username
    }).from(users);

    // Get ticket earnings
    const ticketStats = await db.select({
      discordId: tickets.claimedBy,
      earnings: sql<number>`sum(${tickets.amount})::int`,
      count: sql<number>`count(*)::int`
    })
      .from(tickets)
      .where(sql`${tickets.claimedBy} is not null`)
      .groupBy(tickets.claimedBy);

    // Get adjustments
    const adjustments = await db.select({
      workerId: earningsAdjustments.workerId,
      totalAdjustment: sql<number>`sum(${earningsAdjustments.amount})::int`
    })
      .from(earningsAdjustments)
      .groupBy(earningsAdjustments.workerId);

    // Get ledger earnings
    const ledger = await db.select({
      workerId: earningsLedger.workerId,
      totalLedger: sql<number>`sum(${earningsLedger.amount})::int`
    })
      .from(earningsLedger)
      .groupBy(earningsLedger.workerId);

    // Merge stats
    return workers.map(worker => {
      const ticketStat = ticketStats.find(ts => ts.discordId === worker.discordId) || { earnings: 0, count: 0 };
      const adjustment = adjustments.find(adj => adj.workerId === worker.discordId) || { totalAdjustment: 0 };
      const ledgerStat = ledger.find(l => l.workerId === worker.discordId) || { totalLedger: 0 };
      return {
        discordId: worker.discordId,
        username: worker.username,
        totalEarnings: (ticketStat.earnings || 0) + (adjustment.totalAdjustment || 0) + (ledgerStat.totalLedger || 0),
        ticketCount: ticketStat.count || 0 // Optionally, you could sum ticketCount + ledger count if you want
      };
    });
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

    // First get all worker stats from earnings ledger (preserved payments)
    // This ensures we have all paid tickets even if they were deleted
    let statsQuery = db.select({
      discordId: earningsLedger.workerId,
      earnings: sql<number>`sum(${earningsLedger.amount})::int`,
      count: sql<number>`count(*)::int`
    })
    .from(earningsLedger)
    .where(
      and(
        sql`${earningsLedger.workerId} is not null`,
        eq(earningsLedger.type, 'ticket_payment'),
        eq(earningsLedger.status, 'confirmed')
      )
    )
    .groupBy(earningsLedger.workerId)
    .orderBy(desc(sql<number>`sum(${earningsLedger.amount})`));
    
    // Only apply date filtering if not showing all-time stats
    if (period !== 'all') {
      statsQuery = db.select({
        discordId: earningsLedger.workerId,
        earnings: sql<number>`sum(${earningsLedger.amount})::int`,
        count: sql<number>`count(*)::int`
      })
      .from(earningsLedger)
      .where(
        and(
          sql`${earningsLedger.workerId} is not null`,
          eq(earningsLedger.type, 'ticket_payment'),
          eq(earningsLedger.status, 'confirmed'),
          // Use proper date comparison with null handling
          sql`${earningsLedger.completedAt} IS NOT NULL`,
          gte(earningsLedger.completedAt, periodStart),
          lte(earningsLedger.completedAt, periodEnd)
        )
      )
      .groupBy(earningsLedger.workerId)
      .orderBy(desc(sql<number>`sum(${earningsLedger.amount})`));
    }
    
    const stats = await statsQuery;
    
    // Log the approach we're using
    console.log(`Using improved worker stats query for period ${period} - found ${stats.length} workers`);

    // Get usernames for all workers
    const discordIds = stats.map(stat => stat.discordId!).filter(id => id);
    const usersData = discordIds.length > 0 ? await db.select({
      discordId: users.discordId,
      username: users.username
    })
    .from(users)
    .where(inArray(users.discordId, discordIds)) : [];

    const userMap = new Map(usersData.map(user => [user.discordId, user.username]));

    return stats.map(stat => ({
      discordId: stat.discordId!,
      username: userMap.get(stat.discordId!) || stat.discordId!, // Use actual username or fallback to Discord ID
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
    
    // First get all worker stats from earnings ledger (preserved payments)
    // This ensures we have all paid tickets even if they were deleted
    const allPaidStats = await db.select({
      discordId: earningsLedger.workerId,
      earnings: sql<number>`sum(${earningsLedger.amount})::int`,
      count: sql<number>`count(*)::int`
    })
    .from(earningsLedger)
    .where(
      and(
        sql`${earningsLedger.workerId} is not null`,
        eq(earningsLedger.type, 'ticket_payment'),
        eq(earningsLedger.status, 'confirmed')
      )
    )
    .groupBy(earningsLedger.workerId);
    
    console.log(`Found ${allPaidStats.length} workers with paid tickets (all time)`);
    
    // Now get date-filtered stats from earnings ledger
    const stats = await db.select({
      discordId: earningsLedger.workerId,
      earnings: sql<number>`sum(${earningsLedger.amount})::int`,
      count: sql<number>`count(*)::int`
    })
    .from(earningsLedger)
    .where(
        and(
          sql`${earningsLedger.workerId} is not null`,
          eq(earningsLedger.type, 'ticket_payment'),
          eq(earningsLedger.status, 'confirmed'),
          // Use proper date comparison with null handling
          sql`${earningsLedger.completedAt} IS NOT NULL`,
          gte(earningsLedger.completedAt, startDate),
          lte(earningsLedger.completedAt, adjustedEndDate)
        )
    )
    .groupBy(earningsLedger.workerId)
    .orderBy(desc(sql<number>`sum(${earningsLedger.amount})`));

    console.log(`Found ${stats.length} workers with tickets in the specified date range`);

    // Get usernames for all workers
    const discordIds = stats.map(stat => stat.discordId!).filter(id => id);
    const usersData = discordIds.length > 0 ? await db.select({
      discordId: users.discordId,
      username: users.username
    })
    .from(users)
    .where(inArray(users.discordId, discordIds)) : [];

    const userMap = new Map(usersData.map(user => [user.discordId, user.username]));

    return stats.map(stat => ({
      discordId: stat.discordId!,
      username: userMap.get(stat.discordId!) || stat.discordId!, // Use actual username or fallback to Discord ID
      totalEarnings: stat.earnings || 0,
      ticketCount: stat.count,
      periodStart: startDate,
      periodEnd: adjustedEndDate
    }));
  }

  async getActiveTicketByUserId(userId: number): Promise<Ticket | undefined> {
    console.log(`[DB] Checking for active tickets for user ${userId}`);
    
    // Get all tickets for this user that are in an active state
    // This should include 'open', 'in-progress', 'pending', and 'paid' since users should still be able to message in paid tickets
    try {
      // First, let's retrieve all active tickets to debug multiple ticket scenarios
      const activeTickets = await db
        .select()
        .from(tickets)
        .where(
          and(
            eq(tickets.userId, userId),
            // Consider tickets with active statuses including 'paid' since users should still be able to message
            sql`(${tickets.status} IN ('open', 'in-progress', 'pending', 'paid'))`
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
    // This should include 'open', 'in-progress', 'pending', and 'paid' since users should still be able to message in paid tickets
    const activeTickets = await db
      .select()
      .from(tickets)
      .where(
        and(
          eq(tickets.userId, userId),
          // Consider tickets with active statuses including 'paid' since users should still be able to message
          sql`(${tickets.status} IN ('open', 'in-progress', 'pending', 'paid'))`
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

  // Alternative method for photo handling - allows paid tickets for continued messaging
  async getNonClosedTicketByUserId(userId: number): Promise<Ticket | undefined> {
    console.log(`[DB] Checking for non-closed tickets for user ${userId} (for photo handling)`);
    
    // Get all non-closed tickets for this user
    // This includes 'open', 'in-progress', 'pending', 'paid', but not 'closed', 'deleted', etc.
    // We keep this separate from getActiveTicketsByUserId since it SHOULD include 'paid' status
    // because users should still be able to send photos to paid tickets
    const [ticket] = await db
      .select()
      .from(tickets)
      .where(
        and(
          eq(tickets.userId, userId),
          // Consider any ticket not in a finalized state as "active" for photo/message handling
          // Note: 'paid' status is included because users should still be able to interact with paid tickets
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
      telegramIdSchema.parse(telegramId);
      await db.insert(userStates).values({ userId, telegramId, state }).returning();
    } catch (error) {
      console.error(`[DB] Error saving user state for telegramId: ${telegramId}`, error);
      throw error;
    }
  }

  async getUserStateByTelegramId(telegramId: string): Promise<string | undefined> {
    try {
      telegramIdSchema.parse(telegramId);
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
      console.error(`[DB] Error retrieving state for telegramId: ${telegramId}`, error);
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

  // Persistent earnings tracking methods
  async recordTicketPayment(ticketId: number, workerId: string, amount: number, categoryId: number, reason: string = "Ticket payment"): Promise<void> {
    try {
      // Check if this payment is already recorded
      const existingEntry = await db.select()
        .from(earningsLedger)
        .where(and(
          eq(earningsLedger.ticketId, ticketId),
          eq(earningsLedger.workerId, workerId),
          eq(earningsLedger.type, 'ticket_payment')
        ));
      
      if (existingEntry.length > 0) {
        const existingPayment = existingEntry[0];
        const oldAmount = existingPayment.amount;
        
        // If the amount is the same, no need to update
        if (oldAmount === amount) {
          log(`Payment for ticket ${ticketId} already exists with same amount $${amount}, no update needed`, "info");
          return;
        }
        
        // Update the existing payment amount
        await db.update(earningsLedger)
          .set({
            amount: amount,
            reason: reason,
            confirmedAt: new Date(),
            confirmedBy: 'system'
          })
          .where(eq(earningsLedger.id, existingPayment.id));
        
        // Update worker earnings summary to reflect the change
        const amountDifference = amount - oldAmount;
        await this.updateWorkerEarningsSummary(workerId, amountDifference);
        
        log(`Updated payment for ticket ${ticketId} from $${oldAmount} to $${amount} for worker ${workerId}`, "info");
        return;
      }
      
      // Record new payment in the earnings ledger
      await db.insert(earningsLedger).values({
        workerId,
        ticketId,
        categoryId,
        amount,
        type: 'ticket_payment',
        reason,
        status: 'confirmed',
        createdAt: new Date(),
        confirmedAt: new Date(),
        confirmedBy: 'system'
      });

      // Update the worker earnings summary
      await this.updateWorkerEarningsSummary(workerId, amount);
      
      log(`Recorded new payment of $${amount} for worker ${workerId} on ticket ${ticketId}`, "info");
    } catch (error: any) {
      log(`Failed to record ticket payment: ${error.message}`, "error");
      throw error;
    }
  }

  async updateWorkerEarningsSummary(workerId: string, additionalAmount: number = 0): Promise<void> {
    try {
      // Calculate total earnings from ledger
      const ledgerResult = await db.select({
        totalEarnings: sql<number>`COALESCE(SUM(${earningsLedger.amount}), 0)::int`,
        totalTickets: sql<number>`COUNT(*)::int`,
        lastEarningDate: sql<Date>`MAX(${earningsLedger.createdAt})`
      })
      .from(earningsLedger)
      .where(and(
        eq(earningsLedger.workerId, workerId),
        eq(earningsLedger.status, 'confirmed')
      ));

      const totalEarnings = ledgerResult[0]?.totalEarnings || 0;
      const totalTickets = ledgerResult[0]?.totalTickets || 0;
      const lastEarningDate = ledgerResult[0]?.lastEarningDate;

      // Upsert the summary
      await db.execute(sql`
        INSERT INTO worker_earnings_summary (worker_id, total_earnings, total_tickets, last_earning_date, last_updated)
        VALUES (${workerId}, ${totalEarnings}, ${totalTickets}, ${lastEarningDate}, NOW())
        ON CONFLICT (worker_id) 
        DO UPDATE SET 
          total_earnings = ${totalEarnings},
          total_tickets = ${totalTickets},
          last_earning_date = ${lastEarningDate},
          last_updated = NOW()
      `);
    } catch (error: any) {
      log(`Failed to update worker earnings summary: ${error.message}`, "error");
      throw error;
    }
  }

  async getWorkerEarningsSummary(workerId: string): Promise<WorkerEarningsSummary | undefined> {
    try {
      const [summary] = await db.select().from(workerEarningsSummary).where(eq(workerEarningsSummary.workerId, workerId));
      return summary;
    } catch (error: any) {
      log(`Failed to get worker earnings summary: ${error.message}`, "error");
      return undefined;
    }
  }

  async getAllWorkerEarningsSummaries(): Promise<WorkerEarningsSummary[]> {
    try {
      return await db.select().from(workerEarningsSummary).orderBy(desc(workerEarningsSummary.totalEarnings));
    } catch (error: any) {
      log(`Failed to get all worker earnings summaries: ${error.message}`, "error");
      return [];
    }
  }

  async getWorkerEarningsHistory(workerId: string, limit: number = 50): Promise<EarningsLedger[]> {
    try {
      return await db.select()
        .from(earningsLedger)
        .where(eq(earningsLedger.workerId, workerId))
        .orderBy(desc(earningsLedger.createdAt))
        .limit(limit);
    } catch (error: any) {
      log(`Failed to get worker earnings history: ${error.message}`, "error");
      return [];
    }
  }

  // Get payment history for a specific ticket
  async getTicketPaymentHistory(ticketId: number): Promise<EarningsLedger[]> {
    try {
      return await db.select()
        .from(earningsLedger)
        .where(and(
          eq(earningsLedger.ticketId, ticketId),
          eq(earningsLedger.type, 'ticket_payment')
        ))
        .orderBy(desc(earningsLedger.createdAt));
    } catch (error: any) {
      log(`Failed to get ticket payment history: ${error.message}`, "error");
      return [];
    }
  }

  // Get comprehensive payment statistics that are always preserved
  async getPaymentStatistics(): Promise<{
    totalPayments: number;
    totalAmount: number;
    workerStats: Array<{
      workerId: string;
      username: string | null;
      totalEarnings: number;
      totalTickets: number;
      lastPaymentDate: Date | null;
    }>;
    categoryStats: Array<{
      categoryId: number;
      categoryName: string;
      totalAmount: number;
      totalTickets: number;
    }>;
  }> {
    try {
      log("Getting payment statistics from earnings ledger...", "info");
      // Get total payment statistics from earnings ledger
      const totalStats = await db.select({
        totalPayments: sql<number>`COUNT(*)::int`,
        totalAmount: sql<number>`COALESCE(SUM(${earningsLedger.amount}), 0)::int`
      })
      .from(earningsLedger)
      .where(and(
        eq(earningsLedger.type, 'ticket_payment'),
        eq(earningsLedger.status, 'confirmed')
      ));

      // Get worker statistics with usernames
      const workerStats = await db.select({
        workerId: earningsLedger.workerId,
        username: users.username,
        totalEarnings: sql<number>`COALESCE(SUM(${earningsLedger.amount}), 0)::int`,
        totalTickets: sql<number>`COUNT(*)::int`,
        lastPaymentDate: sql<Date>`MAX(${earningsLedger.createdAt})`
      })
      .from(earningsLedger)
      .leftJoin(users, eq(earningsLedger.workerId, users.discordId))
      .where(and(
        eq(earningsLedger.type, 'ticket_payment'),
        eq(earningsLedger.status, 'confirmed')
      ))
      .groupBy(earningsLedger.workerId, users.username)
      .orderBy(desc(sql`SUM(${earningsLedger.amount})`));

      // Get category statistics
      const categoryStats = await db.select({
        categoryId: earningsLedger.categoryId,
        totalAmount: sql<number>`COALESCE(SUM(${earningsLedger.amount}), 0)::int`,
        totalTickets: sql<number>`COUNT(*)::int`
      })
      .from(earningsLedger)
      .where(and(
        eq(earningsLedger.type, 'ticket_payment'),
        eq(earningsLedger.status, 'confirmed')
      ))
      .groupBy(earningsLedger.categoryId)
      .orderBy(desc(sql`SUM(${earningsLedger.amount})`));

      // Get category names for the stats
      const categoryIds = categoryStats.map(stat => stat.categoryId).filter(id => id !== null && id !== undefined);
      const categoriesData = categoryIds.length > 0 ? await db.select()
        .from(categories)
        .where(inArray(categories.id, categoryIds)) : [];

      const categoryMap = new Map(categoriesData.map(cat => [cat.id, cat.name]));

      const result = {
        totalPayments: totalStats[0]?.totalPayments || 0,
        totalAmount: totalStats[0]?.totalAmount || 0,
        workerStats: workerStats.map(stat => ({
          workerId: stat.workerId,
          username: stat.username,
          totalEarnings: stat.totalEarnings,
          totalTickets: stat.totalTickets,
          lastPaymentDate: stat.lastPaymentDate
        })),
        categoryStats: categoryStats.map(stat => ({
          categoryId: stat.categoryId || 0,
          categoryName: categoryMap.get(stat.categoryId || 0) || 'Unknown Category',
          totalAmount: stat.totalAmount,
          totalTickets: stat.totalTickets
        }))
      };

      log(`Payment statistics result: ${result.totalPayments} payments, $${result.totalAmount} total`, "info");
      return result;
    } catch (error: any) {
      log(`Failed to get payment statistics: ${error.message}`, "error");
      return {
        totalPayments: 0,
        totalAmount: 0,
        workerStats: [],
        categoryStats: []
      };
    }
  }

  // Add methods for earnings adjustments
  async addEarningsAdjustment(workerId: string, amount: number, reason: string = ""): Promise<void> {
    await db.insert(earningsAdjustments).values({
      workerId,
      amount,
      reason,
      createdAt: new Date()
    });
  }

  async editEarningsAdjustment(id: number, amount: number, reason: string = ""): Promise<void> {
    await db.update(earningsAdjustments).set({ amount, reason }).where(sql`id = ${id}`);
  }

  async deleteEarningsAdjustment(id: number): Promise<void> {
    await db.delete(earningsAdjustments).where(sql`id = ${id}`);
  }

  async clearAllStatistics(): Promise<void> {
    // Clear all earnings-related data
    await db.delete(earningsLedger);
    await db.delete(earningsAdjustments);
    await db.delete(workerEarningsSummary);
    
    // Reset all ticket amounts to 0 (but keep the tickets)
    await db.update(tickets).set({ amount: 0 });
    
    log('All statistics cleared - earnings ledger, adjustments, worker summaries, and ticket amounts reset', 'warn');
  }

  async ensureDiscordWorkerExists(discordId: string): Promise<void> {
    try {
      // Check if this Discord user already exists
      const existingUser = await db.select()
        .from(users)
        .where(eq(users.discordId, discordId))
        .limit(1);

      // Try to get the real Discord username
      let realUsername = `Worker_${discordId.slice(-4)}`; // Fallback
      
      try {
        // Import bridge dynamically to avoid circular dependencies
        const { BridgeManager } = await import('./bot/bridge');
        const bridge = BridgeManager.getInstance();
        const discordBot = bridge.getDiscordBot();
        
        // Get the real Discord user
        const discordUser = await discordBot.client.users.fetch(discordId);
        if (discordUser) {
          realUsername = discordUser.username;
          log(`Fetched real Discord username for ${discordId}: ${realUsername}`, 'info');
        }
      } catch (discordError) {
        log(`Could not fetch Discord username for ${discordId}, using fallback: ${discordError}`, 'warn');
      }

      if (existingUser.length === 0) {
        // Create a new user entry for this Discord worker
        await db.insert(users).values({
          discordId: discordId,
          username: realUsername,
          telegramId: null, // Discord workers don't have Telegram IDs
          isBanned: false,
          createdAt: new Date()
        });
        log(`Created user entry for Discord worker: ${discordId} with username: ${realUsername}`, 'info');
      } else {
        // User exists, but update their username if it's still a fake one
        const currentUsername = existingUser[0].username;
        if (currentUsername.startsWith('Worker_') && realUsername !== `Worker_${discordId.slice(-4)}`) {
          await db.update(users)
            .set({ username: realUsername })
            .where(eq(users.discordId, discordId));
          log(`Updated existing worker ${discordId} username from "${currentUsername}" to "${realUsername}"`, 'info');
        }
      }
    } catch (error) {
      log(`Error ensuring Discord worker exists: ${error}`, 'error');
      // Don't throw - this shouldn't break ticket claiming
    }
  }

  async updateWorkerUsername(discordId: string, username: string): Promise<void> {
    try {
      // First ensure the worker exists
      await this.ensureDiscordWorkerExists(discordId);
      
      // Update the username
      await db.update(users)
        .set({ username })
        .where(eq(users.discordId, discordId));
      
      log(`Updated username for Discord worker ${discordId} to: ${username}`, 'info');
    } catch (error) {
      log(`Error updating worker username: ${error}`, 'error');
      throw error;
    }
  }

  async refreshAllWorkerUsernames(): Promise<number> {
    try {
      // Get all users with Discord IDs (workers)
      const workers = await db.select({
        id: users.id,
        discordId: users.discordId,
        currentUsername: users.username
      })
      .from(users)
      .where(sql`${users.discordId} IS NOT NULL`);

      log(`Found ${workers.length} workers to refresh usernames for`, 'info');

      let updatedCount = 0;

      // Import bridge dynamically to avoid circular dependencies
      const { BridgeManager } = await import('./bot/bridge');
      const bridge = BridgeManager.getInstance();
      const discordBot = bridge.getDiscordBot();

      for (const worker of workers) {
        try {
          // Get the real Discord username
          const discordUser = await discordBot.client.users.fetch(worker.discordId);
          if (discordUser && discordUser.username !== worker.currentUsername) {
            // Update the username in database
            await db.update(users)
              .set({ username: discordUser.username })
              .where(eq(users.id, worker.id));
            
            log(`Updated worker ${worker.discordId} username from "${worker.currentUsername}" to "${discordUser.username}"`, 'info');
            updatedCount++;
          }
        } catch (discordError) {
          log(`Could not fetch Discord username for worker ${worker.discordId}: ${discordError}`, 'warn');
        }
      }

      log(`Successfully refreshed ${updatedCount} worker usernames`, 'info');
      return updatedCount;
    } catch (error) {
      log(`Error refreshing worker usernames: ${error}`, 'error');
      throw error;
    }
  }

  // Admin role operations
  async createAdminRole(role: InsertAdminRole): Promise<AdminRole> {
    try {
      const [newRole] = await db.insert(adminRoles).values(role).returning();
      log(`Created admin role: ${newRole.roleName} (${newRole.discordRoleId})`, 'info');
      return newRole;
    } catch (error) {
      log(`Error creating admin role: ${error}`, 'error');
      throw error;
    }
  }

  async getAdminRoles(): Promise<AdminRole[]> {
    try {
      return await db.select().from(adminRoles).orderBy(adminRoles.roleName);
    } catch (error) {
      log(`Error getting admin roles: ${error}`, 'error');
      throw error;
    }
  }

  async getAdminRole(id: number): Promise<AdminRole | undefined> {
    try {
      const [role] = await db.select().from(adminRoles).where(eq(adminRoles.id, id));
      return role;
    } catch (error) {
      log(`Error getting admin role ${id}: ${error}`, 'error');
      throw error;
    }
  }

  async getAdminRoleByDiscordId(discordRoleId: string): Promise<AdminRole | undefined> {
    try {
      const [role] = await db.select().from(adminRoles).where(eq(adminRoles.discordRoleId, discordRoleId));
      return role;
    } catch (error) {
      log(`Error getting admin role by Discord ID ${discordRoleId}: ${error}`, 'error');
      throw error;
    }
  }

  async updateAdminRole(id: number, role: Partial<InsertAdminRole>): Promise<AdminRole | undefined> {
    try {
      const [updatedRole] = await db.update(adminRoles)
        .set(role)
        .where(eq(adminRoles.id, id))
        .returning();
      log(`Updated admin role ${id}`, 'info');
      return updatedRole;
    } catch (error) {
      log(`Error updating admin role ${id}: ${error}`, 'error');
      throw error;
    }
  }

  async deleteAdminRole(id: number): Promise<void> {
    try {
      await db.delete(adminRoles).where(eq(adminRoles.id, id));
      log(`Deleted admin role ${id}`, 'info');
    } catch (error) {
      log(`Error deleting admin role ${id}: ${error}`, 'error');
      throw error;
    }
  }

  // Role-category permission operations
  async setRoleCategoryPermissions(roleId: number, categoryIds: number[]): Promise<boolean> {
    try {
      // First, delete existing permissions for this role
      await db.delete(roleCategoryPermissions).where(eq(roleCategoryPermissions.roleId, roleId));
      
      // Then, insert new permissions
      if (categoryIds.length > 0) {
        const permissions = categoryIds.map(categoryId => ({
          roleId,
          categoryId
        }));
        await db.insert(roleCategoryPermissions).values(permissions);
      }
      
      log(`Set permissions for role ${roleId}: ${categoryIds.length} categories`, 'info');
      return true;
    } catch (error) {
      log(`Error setting role category permissions: ${error}`, 'error');
      throw error;
    }
  }

  async getRoleCategoryPermissions(roleId: number): Promise<number[]> {
    try {
      const permissions = await db.select({ categoryId: roleCategoryPermissions.categoryId })
        .from(roleCategoryPermissions)
        .where(eq(roleCategoryPermissions.roleId, roleId));
      return permissions.map(p => p.categoryId);
    } catch (error) {
      log(`Error getting role category permissions for role ${roleId}: ${error}`, 'error');
      throw error;
    }
  }

  async getCategoryRolePermissions(categoryId: number): Promise<number[]> {
    try {
      const permissions = await db.select({ roleId: roleCategoryPermissions.roleId })
        .from(roleCategoryPermissions)
        .where(eq(roleCategoryPermissions.categoryId, categoryId));
      return permissions.map(p => p.roleId);
    } catch (error) {
      log(`Error getting category role permissions for category ${categoryId}: ${error}`, 'error');
      throw error;
    }
  }

  // Permission checking
  async getUserAllowedCategories(discordUserId: string): Promise<number[]> {
    try {
      // Import bridge dynamically to avoid circular dependencies
      const { BridgeManager } = await import('./bot/bridge');
      const bridge = BridgeManager.getInstance();
      const discordBot = bridge.getDiscordBot();
      
      // Get user's roles from Discord
      const guild = discordBot.client.guilds.cache.first();
      if (!guild) {
        log('No guild found for permission checking', 'warn');
        return [];
      }
      
      const member = await guild.members.fetch(discordUserId).catch(() => null);
      if (!member) {
        log(`User ${discordUserId} not found in guild`, 'warn');
        return [];
      }
      
      // Get user's role IDs (including @everyone role)
      const userRoleIds = member.roles.cache.map(role => role.id);
      log(`User ${discordUserId} has roles: ${userRoleIds.join(', ')}`, 'info');
      
      // Get all admin roles from database
      const adminRoles = await this.getAdminRoles();
      log(`Found ${adminRoles.length} admin roles in database`, 'info');
      
      // Check which admin roles the user has
      const userAdminRoles = adminRoles.filter(role => {
        const hasRole = userRoleIds.includes(role.discordRoleId);
        if (hasRole) {
          log(`User ${discordUserId} has admin role: ${role.roleName} (${role.discordRoleId})`, 'info');
        }
        return hasRole;
      });
      
      if (userAdminRoles.length === 0) {
        log(`User ${discordUserId} has no admin roles`, 'info');
        return []; // User has no admin roles
      }
      
      // Check if user has full admin role
      const hasFullAdmin = userAdminRoles.some(role => role.isFullAdmin);
      if (hasFullAdmin) {
        log(`User ${discordUserId} has full admin access`, 'info');
        // Full admin can see all categories
        const allCategories = await this.getCategories();
        return allCategories.map(cat => cat.id);
      }
      
      // Get allowed categories from role permissions
      const allowedCategories = new Set<number>();
      for (const role of userAdminRoles) {
        const roleCategories = await this.getRoleCategoryPermissions(role.id);
        log(`Role ${role.roleName} allows categories: ${roleCategories.join(', ')}`, 'info');
        roleCategories.forEach(catId => allowedCategories.add(catId));
      }
      
      const finalCategories = Array.from(allowedCategories);
      log(`User ${discordUserId} final allowed categories: ${finalCategories.join(', ')}`, 'info');
      return finalCategories;
    } catch (error) {
      log(`Error getting user allowed categories for ${discordUserId}: ${error}`, 'error');
      return [];
    }
  }

  async canUserAccessCategory(discordUserId: string, categoryId: number): Promise<boolean> {
    try {
      const allowedCategories = await this.getUserAllowedCategories(discordUserId);
      return allowedCategories.includes(categoryId);
    } catch (error) {
      log(`Error checking category access for user ${discordUserId}, category ${categoryId}: ${error}`, 'error');
      return false;
    }
  }

  async isUserFullAdmin(discordUserId: string): Promise<boolean> {
    try {
      // Import bridge dynamically to avoid circular dependencies
      const { BridgeManager } = await import('./bot/bridge');
      const bridge = BridgeManager.getInstance();
      const discordBot = bridge.getDiscordBot();
      
      // Get user's roles from Discord
      const guild = discordBot.client.guilds.cache.first();
      if (!guild) {
        return false;
      }
      
      const member = await guild.members.fetch(discordUserId).catch(() => null);
      if (!member) {
        return false;
      }
      
      const userRoleIds = member.roles.cache.map(role => role.id);
      
      // Get all admin roles and check if user has full admin role
      const adminRoles = await this.getAdminRoles();
      return adminRoles.some(role => 
        userRoleIds.includes(role.discordRoleId) && role.isFullAdmin
      );
    } catch (error) {
      log(`Error checking full admin status for user ${discordUserId}: ${error}`, 'error');
      return false;
    }
  }
}

// Export the DatabaseStorage instance
export const storage = new DatabaseStorage();