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
    return Array.from(this.categories.values());
  }

  async getCategory(id: number): Promise<Category | undefined> {
    return this.categories.get(id);
  }

  async createCategory(insertCategory: InsertCategory): Promise<Category> {
    const id = this.currentIds.categories++;
    const category = { 
      ...insertCategory, 
      id,
      serviceSummary: insertCategory.serviceSummary || "Our team is ready to assist you!",
      serviceImageUrl: insertCategory.serviceImageUrl || null
    };
    this.categories.set(id, category);
    return category;
  }

  async updateCategory(id: number, updateData: Partial<InsertCategory>): Promise<Category | undefined> {
    const category = await this.getCategory(id);
    if (!category) return undefined;

    const updatedCategory = {
      ...category,
      ...updateData,
      id // Ensure ID remains unchanged
    };
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
}

export const storage = new MemStorage();