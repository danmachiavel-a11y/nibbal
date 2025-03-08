import { 
  User, InsertUser, Category, InsertCategory,
  Ticket, InsertTicket, Message, InsertMessage,
  BotConfig, InsertBotConfig
} from "@shared/schema";

export interface IStorage {
  // Bot config operations
  getBotConfig(): Promise<BotConfig | undefined>;
  updateBotConfig(config: Partial<InsertBotConfig>): Promise<BotConfig>;

  // User operations
  getUser(id: number): Promise<User | undefined>;
  getUserByTelegramId(telegramId: string): Promise<User | undefined>;
  getUserByDiscordId(discordId: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  banUser(id: number): Promise<void>;

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

  // Message operations
  createMessage(message: InsertMessage): Promise<Message>;
  getTicketMessages(ticketId: number): Promise<Message[]>;

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
  // Add new method for getting active tickets
  getActiveTicketByUserId(userId: number): Promise<Ticket | undefined>;
}

export class MemStorage implements IStorage {
  private users: Map<number, User>;
  private categories: Map<number, Category>;
  private tickets: Map<number, Ticket>;
  private messages: Map<number, Message>;
  private botConfig: BotConfig;
  private currentIds: { [key: string]: number };

  constructor() {
    this.users = new Map();
    this.categories = new Map();
    this.tickets = new Map();
    this.messages = new Map();
    this.currentIds = {
      users: 1,
      categories: 1,
      tickets: 1,
      messages: 1,
      botConfig: 1
    };
    // Initialize default bot config
    this.botConfig = {
      id: 1,
      welcomeMessage: "Welcome to the support bot! Please select a service:",
      welcomeImageUrl: null
    };
  }

  async getBotConfig(): Promise<BotConfig | undefined> {
    return this.botConfig;
  }

  async updateBotConfig(config: Partial<InsertBotConfig>): Promise<BotConfig> {
    this.botConfig = {
      ...this.botConfig,
      ...config,
      id: 1
    };
    return this.botConfig;
  }

  async getUser(id: number): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByTelegramId(telegramId: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(u => u.telegramId === telegramId);
  }

  async getUserByDiscordId(discordId: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(u => u.discordId === discordId);
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = this.currentIds.users++;
    const user = { 
      ...insertUser, 
      id,
      telegramId: insertUser.telegramId || null,
      discordId: insertUser.discordId || null,
      isBanned: insertUser.isBanned || false
    };
    this.users.set(id, user);
    return user;
  }

  async banUser(id: number): Promise<void> {
    const user = await this.getUser(id);
    if (user) {
      this.users.set(id, { ...user, isBanned: true });
    }
  }

  async getCategories(): Promise<Category[]> {
    return Array.from(this.categories.values())
      .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
  }

  async getCategory(id: number): Promise<Category | undefined> {
    const category = this.categories.get(id);
    console.log(`Retrieved category ${id}:`, JSON.stringify(category, null, 2));
    return category;
  }

  async createCategory(insertCategory: InsertCategory): Promise<Category> {
    const id = this.currentIds.categories++;

    // Base category data
    const category = {
      id,
      name: insertCategory.name,
      isSubmenu: insertCategory.isSubmenu || false,
      parentId: insertCategory.parentId || null,
      displayOrder: insertCategory.displayOrder || 0,
      newRow: insertCategory.newRow || false,

      // If it's a submenu, use empty values for these fields
      discordRoleId: insertCategory.isSubmenu ? "" : (insertCategory.discordRoleId || ""),
      discordCategoryId: insertCategory.isSubmenu ? "" : (insertCategory.discordCategoryId || ""),
      transcriptCategoryId: insertCategory.isSubmenu ? "" : (insertCategory.transcriptCategoryId || ""),
      questions: insertCategory.isSubmenu ? [] : (insertCategory.questions || []),
      serviceSummary: insertCategory.isSubmenu ? "" : (insertCategory.serviceSummary || "Our team is ready to assist you!"),
      serviceImageUrl: insertCategory.isSubmenu ? null : (insertCategory.serviceImageUrl || null),
    };

    this.categories.set(id, category);
    return category;
  }

  async updateCategory(id: number, updateData: Partial<InsertCategory>): Promise<Category | undefined> {
    const category = await this.getCategory(id);
    if (!category) return undefined;

    // Log the current state and update data
    console.log(`Updating category ${id}. Current data:`, JSON.stringify(category, null, 2));
    console.log("Update payload:", JSON.stringify(updateData, null, 2));

    const updatedCategory = {
      ...category,
      name: updateData.name || category.name,
      discordRoleId: updateData.discordRoleId || category.discordRoleId,
      discordCategoryId: updateData.discordCategoryId || category.discordCategoryId,
      // Only update transcriptCategoryId if it's a non-empty string
      transcriptCategoryId: updateData.transcriptCategoryId ? updateData.transcriptCategoryId : category.transcriptCategoryId,
      questions: Array.isArray(updateData.questions) ? updateData.questions : category.questions,
      serviceSummary: updateData.serviceSummary || category.serviceSummary,
      serviceImageUrl: updateData.serviceImageUrl === '' ? null : (updateData.serviceImageUrl || category.serviceImageUrl),
      displayOrder: updateData.displayOrder ?? category.displayOrder,
      newRow: updateData.newRow ?? category.newRow,
      parentId: updateData.parentId === undefined ? category.parentId : updateData.parentId,
      isSubmenu: updateData.isSubmenu === undefined ? category.isSubmenu : updateData.isSubmenu,
      isClosed: updateData.isClosed === undefined ? category.isClosed : updateData.isClosed // Fixed: Include isClosed in updates
    };

    // Log the final updated category
    console.log("Saving updated category:", JSON.stringify(updatedCategory, null, 2));

    this.categories.set(id, updatedCategory);
    return updatedCategory;
  }

  async deleteCategory(id: number): Promise<void> {
    this.categories.delete(id);
  }

  async createTicket(insertTicket: InsertTicket): Promise<Ticket> {
    const id = this.currentIds.tickets++;
    const ticket = {
      ...insertTicket,
      id,
      status: insertTicket.status || "open",
      discordChannelId: insertTicket.discordChannelId || null,
      claimedBy: insertTicket.claimedBy || null,
      amount: insertTicket.amount || null,
      answers: insertTicket.answers || null,
      userId: insertTicket.userId || null,
      categoryId: insertTicket.categoryId || null
    };
    this.tickets.set(id, ticket);
    return ticket;
  }

  async getTicket(id: number): Promise<Ticket | undefined> {
    return this.tickets.get(id);
  }

  async getTicketByDiscordChannel(channelId: string): Promise<Ticket | undefined> {
    return Array.from(this.tickets.values()).find(t => t.discordChannelId === channelId);
  }

  async updateTicketStatus(id: number, status: string, claimedBy?: string): Promise<void> {
    const ticket = await this.getTicket(id);
    if (ticket) {
      this.tickets.set(id, { 
        ...ticket, 
        status,
        claimedBy: claimedBy || null
      });
    }
  }

  async updateTicketAmount(id: number, amount: number): Promise<void> {
    const ticket = await this.getTicket(id);
    if (ticket) {
      this.tickets.set(id, { ...ticket, amount });
    }
  }

  async updateTicketDiscordChannel(id: number, channelId: string): Promise<void> {
    const ticket = await this.getTicket(id);
    if (ticket) {
      this.tickets.set(id, {
        ...ticket,
        discordChannelId: channelId
      });
    }
  }

  async getTicketsByCategory(categoryId: number): Promise<Ticket[]> {
    return Array.from(this.tickets.values()).filter(t => t.categoryId === categoryId);
  }

  async createMessage(insertMessage: InsertMessage): Promise<Message> {
    const id = this.currentIds.messages++;
    const message = {
      ...insertMessage,
      id,
      ticketId: insertMessage.ticketId || null,
      authorId: insertMessage.authorId || null
    };
    this.messages.set(id, message);
    return message;
  }

  async getTicketMessages(ticketId: number): Promise<Message[]> {
    return Array.from(this.messages.values())
      .filter(m => m.ticketId === ticketId)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  async updateTicketPayment(id: number, amount: number, claimedBy: string): Promise<void> {
    const ticket = await this.getTicket(id);
    if (ticket) {
      this.tickets.set(id, {
        ...ticket,
        amount,
        status: "paid",
        claimedBy,
        completedAt: new Date()
      });
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
    // Get all paid tickets claimed by this user
    const userTickets = Array.from(this.tickets.values())
      .filter(t => t.claimedBy === discordId && t.status === "paid");

    // Calculate total earnings and ticket count
    const totalEarnings = userTickets.reduce((sum, ticket) => sum + (ticket.amount || 0), 0);
    const ticketCount = userTickets.length;

    // Group tickets by category and calculate stats
    const categoryMap = new Map<number, { earnings: number; ticketCount: number }>();

    for (const ticket of userTickets) {
      const stats = categoryMap.get(ticket.categoryId!) || { earnings: 0, ticketCount: 0 };
      stats.earnings += ticket.amount || 0;
      stats.ticketCount += 1;
      categoryMap.set(ticket.categoryId!, stats);
    }

    // Get category names and build final stats
    const categoryStats = await Promise.all(
      Array.from(categoryMap.entries()).map(async ([categoryId, stats]) => {
        const category = await this.getCategory(categoryId);
        return {
          categoryId,
          categoryName: category?.name || "Unknown Category",
          earnings: stats.earnings,
          ticketCount: stats.ticketCount
        };
      })
    );

    return {
      totalEarnings,
      ticketCount,
      categoryStats
    };
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
    // Get all paid tickets claimed by this user
    const userTickets = Array.from(this.tickets.values())
      .filter(t => t.claimedBy === discordId && t.status === "paid" && t.completedAt);

    // Filter tickets by time period
    const now = new Date();
    let periodStart = new Date(0); // Default to all time
    let periodEnd = now;

    if (period === 'week') {
      // Get start of current week (Sunday)
      periodStart = new Date(now);
      periodStart.setDate(now.getDate() - now.getDay());
      periodStart.setHours(0, 0, 0, 0);
    } else if (period === 'month') {
      // Get start of current month
      periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    }

    const filteredTickets = userTickets.filter(ticket => 
      ticket.completedAt! >= periodStart && ticket.completedAt! <= periodEnd
    );

    // Calculate total earnings and ticket count for the period
    const totalEarnings = filteredTickets.reduce((sum, ticket) => sum + (ticket.amount || 0), 0);
    const ticketCount = filteredTickets.length;

    // Group tickets by category and calculate stats
    const categoryMap = new Map<number, { earnings: number; ticketCount: number }>();

    for (const ticket of filteredTickets) {
      const stats = categoryMap.get(ticket.categoryId!) || { earnings: 0, ticketCount: 0 };
      stats.earnings += ticket.amount || 0;
      stats.ticketCount += 1;
      categoryMap.set(ticket.categoryId!, stats);
    }

    // Get category names and build final stats
    const categoryStats = await Promise.all(
      Array.from(categoryMap.entries()).map(async ([categoryId, stats]) => {
        const category = await this.getCategory(categoryId);
        return {
          categoryId,
          categoryName: category?.name || "Unknown Category",
          earnings: stats.earnings,
          ticketCount: stats.ticketCount
        };
      })
    );

    return {
      totalEarnings,
      ticketCount,
      categoryStats,
      periodStart,
      periodEnd
    };
  }

  async getAllWorkerStats(): Promise<Array<{
    discordId: string;
    username: string;
    totalEarnings: number;
    ticketCount: number;
  }>> {
    // Get all paid tickets
    const paidTickets = Array.from(this.tickets.values())
      .filter(t => t.status === "paid" && t.claimedBy);

    // Group tickets by worker (claimedBy)
    const workerMap = new Map<string, { totalEarnings: number; ticketCount: number }>();

    for (const ticket of paidTickets) {
      const stats = workerMap.get(ticket.claimedBy!) || { totalEarnings: 0, ticketCount: 0 };
      stats.totalEarnings += ticket.amount || 0;
      stats.ticketCount += 1;
      workerMap.set(ticket.claimedBy!, stats);
    }

    // Convert to array and sort by earnings
    return Array.from(workerMap.entries()).map(([discordId, stats]) => ({
      discordId,
      username: discordId, // In a real app, you'd get the username from Discord
      totalEarnings: stats.totalEarnings,
      ticketCount: stats.ticketCount
    })).sort((a, b) => b.totalEarnings - a.totalEarnings);
  }
  async getAllWorkerStatsByPeriod(period: 'week' | 'month' | 'all'): Promise<Array<{
    discordId: string;
    username: string;
    totalEarnings: number;
    ticketCount: number;
    periodStart: Date;
    periodEnd: Date;
  }>> {
    // Get all paid tickets
    const paidTickets = Array.from(this.tickets.values())
      .filter(t => t.status === "paid" && t.claimedBy && t.completedAt);

    // Filter tickets by time period
    const now = new Date();
    let periodStart = new Date(0); // Default to all time
    let periodEnd = now;

    if (period === 'week') {
      // Get start of current week (Sunday)
      periodStart = new Date(now);
      periodStart.setDate(now.getDate() - now.getDay());
      periodStart.setHours(0, 0, 0, 0);
    } else if (period === 'month') {
      // Get start of current month
      periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    }

    const filteredTickets = paidTickets.filter(ticket => 
      ticket.completedAt! >= periodStart && ticket.completedAt! <= periodEnd
    );

    // Group tickets by worker (claimedBy)
    const workerMap = new Map<string, { totalEarnings: number; ticketCount: number }>();

    for (const ticket of filteredTickets) {
      const stats = workerMap.get(ticket.claimedBy!) || { totalEarnings: 0, ticketCount: 0 };
      stats.totalEarnings += ticket.amount || 0;
      stats.ticketCount += 1;
      workerMap.set(ticket.claimedBy!, stats);
    }

    // Convert to array and sort by earnings
    return Array.from(workerMap.entries()).map(([discordId, stats]) => ({
      discordId,
      username: discordId, // In a real app, you'd get the username from Discord
      totalEarnings: stats.totalEarnings,
      ticketCount: stats.ticketCount,
      periodStart,
      periodEnd
    })).sort((a, b) => b.totalEarnings - a.totalEarnings);
  }

  async getUserStatsByDateRange(discordId: string, startDate: Date, endDate: Date) {
    const userTickets = Array.from(this.tickets.values())
      .filter(t => t.claimedBy === discordId && 
                   t.status === "paid" && 
                   t.completedAt &&
                   t.completedAt >= startDate &&
                   t.completedAt <= endDate);

    const totalEarnings = userTickets.reduce((sum, ticket) => sum + (ticket.amount || 0), 0);
    const ticketCount = userTickets.length;

    const categoryMap = new Map<number, { earnings: number; ticketCount: number }>();

    for (const ticket of userTickets) {
      const stats = categoryMap.get(ticket.categoryId!) || { earnings: 0, ticketCount: 0 };
      stats.earnings += ticket.amount || 0;
      stats.ticketCount += 1;
      categoryMap.set(ticket.categoryId!, stats);
    }

    const categoryStats = await Promise.all(
      Array.from(categoryMap.entries()).map(async ([categoryId, stats]) => {
        const category = await this.getCategory(categoryId);
        return {
          categoryId,
          categoryName: category?.name || "Unknown Category",
          earnings: stats.earnings,
          ticketCount: stats.ticketCount
        };
      })
    );

    return {
      totalEarnings,
      ticketCount,
      categoryStats,
      periodStart: startDate,
      periodEnd: endDate
    };
  }

  async getAllWorkerStatsByDateRange(startDate: Date, endDate: Date) {
    const paidTickets = Array.from(this.tickets.values())
      .filter(t => t.status === "paid" && 
                   t.claimedBy && 
                   t.completedAt &&
                   t.completedAt >= startDate &&
                   t.completedAt <= endDate);

    const workerMap = new Map<string, { totalEarnings: number; ticketCount: number }>();

    for (const ticket of paidTickets) {
      const stats = workerMap.get(ticket.claimedBy!) || { totalEarnings: 0, ticketCount: 0 };
      stats.totalEarnings += ticket.amount || 0;
      stats.ticketCount += 1;
      workerMap.set(ticket.claimedBy!, stats);
    }

    return Array.from(workerMap.entries()).map(([discordId, stats]) => ({
      discordId,
      username: discordId,
      totalEarnings: stats.totalEarnings,
      ticketCount: stats.ticketCount,
      periodStart: startDate,
      periodEnd: endDate
    })).sort((a, b) => b.totalEarnings - a.totalEarnings);
  }
  async getActiveTicketByUserId(userId: number): Promise<Ticket | undefined> {
    return Array.from(this.tickets.values()).find(t => 
      t.userId === userId && 
      t.status !== "closed" && 
      t.status !== "deleted"
    );
  }
}

export const storage = new MemStorage();