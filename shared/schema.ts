import { pgTable, text, serial, integer, boolean, timestamp, bigint, unique, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { relations } from "drizzle-orm";
import { z } from "zod";

export const botConfig = pgTable("bot_config", {
  id: serial("id").primaryKey(),
  welcomeMessage: text("welcome_message").default("Welcome to the support bot! Please select a service:"),
  welcomeImageUrl: text("welcome_image_url"),
  telegramToken: text("telegram_token"),
  discordToken: text("discord_token"),
  adminTelegramIds: text("admin_telegram_ids").array().default([]),
  adminDiscordIds: text("admin_discord_ids").array().default([]),
});

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").unique(), // Changed from bigint to text
  discordId: text("discord_id").unique(),
  username: text("username").notNull(),
  isBanned: boolean("is_banned").default(false),
  banReason: text("ban_reason"),
  bannedAt: timestamp("banned_at"),
  bannedBy: text("banned_by"),
  telegramUsername: text("telegram_username"),
  telegramName: text("telegram_name"),
});

// Forward declare the categories type to resolve circular reference
const categoriesConfig = {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  discordRoleId: text("discord_role_id").default(""),
  discordCategoryId: text("discord_category_id").default(""),
  transcriptCategoryId: text("transcript_category_id"), // Added transcript category ID
  questions: text("questions").array().notNull(),
  serviceSummary: text("service_summary").default("Our team is ready to assist you!"),
  serviceImageUrl: text("service_image_url"),
  displayOrder: integer("display_order").default(0),
  newRow: boolean("new_row").default(false),
  parentId: integer("parent_id"),
  isSubmenu: boolean("is_submenu").default(false),
  isClosed: boolean("is_closed").default(false), // Added isClosed field
};

export const categories = pgTable("categories", categoriesConfig);

// Junction table for many-to-many relationship between categories and submenus
export const categorySubmenuRelations = pgTable("category_submenu_relations", {
  id: serial("id").primaryKey(),
  categoryId: integer("category_id").notNull().references(() => categories.id, { onDelete: "cascade" }),
  submenuId: integer("submenu_id").notNull().references(() => categories.id, { onDelete: "cascade" }),
  displayOrder: integer("display_order").default(0),
  createdAt: timestamp("created_at").defaultNow()
}, (table) => ({
  // Unique constraint to prevent duplicate relations
  categorySubmenuUnique: unique("category_submenu_relations_category_submenu_unique").on(table.categoryId, table.submenuId),
  // Indexes for better performance
  categoryIdIdx: index("category_submenu_relations_category_id_idx").on(table.categoryId),
  submenuIdIdx: index("category_submenu_relations_submenu_id_idx").on(table.submenuId)
}));

// Define the self-referential relation using relations
export const categoriesRelations = relations(categories, ({ one }) => ({
  parent: one(categories, {
    fields: [categories.parentId],
    references: [categories.id],
  }),
}));

export const tickets = pgTable("tickets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id),
  categoryId: integer("category_id").references(() => categories.id),
  status: text("status").notNull(),
  discordChannelId: text("discord_channel_id"),
  claimedBy: text("claimed_by"),
  amount: integer("amount"),
  answers: text("answers").array(),
  completedAt: timestamp("completed_at"),
});

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  ticketId: integer("ticket_id").references(() => tickets.id),
  content: text("content").notNull(),
  authorId: integer("author_id").references(() => users.id),
  platform: text("platform").notNull(),
  timestamp: timestamp("timestamp").notNull(),
  attachments: text("attachments").array(),
  rawAttachmentData: text("raw_attachment_data"),
  senderName: text("sender_name"), // Added to store the display name of the sender
});

// Define message queue table for offline message processing
export const messageQueue = pgTable("message_queue", {
  id: serial("id").primaryKey(),
  telegramUserId: text("telegram_user_id").notNull(), // Changed from bigint to text
  messageType: text("message_type").notNull(), // 'text', 'photo', 'command'
  content: text("content"), // Message text or serialized command data
  photoId: text("photo_id"), // For photo messages
  commandName: text("command_name"), // For commands
  timestamp: timestamp("timestamp").defaultNow().notNull(),
  processed: boolean("processed").default(false).notNull(),
  processingAttempts: integer("processing_attempts").default(0).notNull(),
  lastAttempt: timestamp("last_attempt"),
});

// User state persistence to survive app restarts
export const userStates = pgTable("user_states", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id),
  telegramId: text("telegram_id").notNull(), // Changed from bigint to text
  state: text("state").notNull(), // JSON serialized state
  timestamp: timestamp("timestamp").defaultNow().notNull(),
  isActive: boolean("is_active").default(true).notNull(),
});

// Persistent earnings tracking - this table will NEVER be deleted
export const earningsLedger = pgTable("earnings_ledger", {
  id: serial("id").primaryKey(),
  workerId: text("worker_id").notNull(), // Discord ID of the worker
  ticketId: integer("ticket_id").references(() => tickets.id), // Optional reference to original ticket
  categoryId: integer("category_id").references(() => categories.id), // Preserve category info
  amount: integer("amount").notNull(), // Earnings amount
  type: text("type").notNull(), // 'ticket_payment', 'adjustment', 'bonus', 'deduction'
  reason: text("reason"), // Reason for the earnings entry
  status: text("status").notNull().default('confirmed'), // 'confirmed', 'pending', 'cancelled'
  createdAt: timestamp("created_at").defaultNow().notNull(),
  confirmedAt: timestamp("confirmed_at"), // When the earnings were confirmed
  confirmedBy: text("confirmed_by"), // Who confirmed the earnings
  notes: text("notes"), // Additional notes
});

// Earnings adjustments table for manual corrections
export const earningsAdjustments = pgTable("earnings_adjustments", {
  id: serial("id").primaryKey(),
  workerId: text("worker_id").notNull(), // Discord ID of the worker
  amount: integer("amount").notNull(), // Positive for additions, negative for deductions
  reason: text("reason").notNull(), // Reason for adjustment
  type: text("type").notNull().default('manual'), // 'manual', 'correction', 'bonus', 'deduction'
  createdBy: text("created_by").notNull(), // Who made the adjustment
  createdAt: timestamp("created_at").defaultNow().notNull(),
  approvedBy: text("approved_by"), // Who approved the adjustment
  approvedAt: timestamp("approved_at"), // When it was approved
  status: text("status").notNull().default('pending'), // 'pending', 'approved', 'rejected'
  notes: text("notes"), // Additional notes
});

// Worker earnings summary table for quick lookups
export const workerEarningsSummary = pgTable("worker_earnings_summary", {
  id: serial("id").primaryKey(),
  workerId: text("worker_id").notNull().unique(), // Discord ID of the worker
  totalEarnings: integer("total_earnings").notNull().default(0), // Total confirmed earnings
  totalTickets: integer("total_tickets").notNull().default(0), // Total tickets completed
  lastEarningDate: timestamp("last_earning_date"), // Last earning date
  lastUpdated: timestamp("last_updated").defaultNow().notNull(),
});

// Admin roles table for Discord role-based permissions
export const adminRoles = pgTable("admin_roles", {
  id: serial("id").primaryKey(),
  roleName: text("role_name").notNull().unique(), // Human-readable role name (e.g., "UberEats Admin")
  discordRoleId: text("discord_role_id").notNull().unique(), // Discord role ID
  isFullAdmin: boolean("is_full_admin").default(false), // Can access all categories
  createdAt: timestamp("created_at").defaultNow().notNull(),
  createdBy: text("created_by").notNull(), // Who created this role
});

// Junction table for role-category permissions (many-to-many)
export const roleCategoryPermissions = pgTable("role_category_permissions", {
  id: serial("id").primaryKey(),
  roleId: integer("role_id").notNull().references(() => adminRoles.id, { onDelete: "cascade" }),
  categoryId: integer("category_id").notNull().references(() => categories.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  // Unique constraint to prevent duplicate permissions
  roleCategoryUnique: unique("role_category_permissions_role_category_unique").on(table.roleId, table.categoryId),
  // Indexes for better performance
  roleIdIdx: index("role_category_permissions_role_id_idx").on(table.roleId),
  categoryIdIdx: index("role_category_permissions_category_id_idx").on(table.categoryId)
}));

export const insertUserSchema = createInsertSchema(users).omit({ id: true });
export const insertCategorySchema = createInsertSchema(categories).omit({ id: true });
export const insertTicketSchema = createInsertSchema(tickets).omit({ id: true });
export const insertMessageSchema = createInsertSchema(messages).omit({ id: true });
export const insertBotConfigSchema = createInsertSchema(botConfig).omit({ id: true });
export const insertMessageQueueSchema = createInsertSchema(messageQueue).omit({ id: true });
export const insertUserStateSchema = createInsertSchema(userStates).omit({ id: true });
export const insertEarningsLedgerSchema = createInsertSchema(earningsLedger).omit({ id: true });
export const insertEarningsAdjustmentSchema = createInsertSchema(earningsAdjustments).omit({ id: true });
export const insertWorkerEarningsSummarySchema = createInsertSchema(workerEarningsSummary).omit({ id: true });
export const insertAdminRoleSchema = createInsertSchema(adminRoles).omit({ id: true });
export const insertRoleCategoryPermissionSchema = createInsertSchema(roleCategoryPermissions).omit({ id: true });

export type User = typeof users.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Ticket = typeof tickets.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type BotConfig = typeof botConfig.$inferSelect;
export type MessageQueue = typeof messageQueue.$inferSelect;
export type UserState = typeof userStates.$inferSelect;
export type EarningsLedger = typeof earningsLedger.$inferSelect;
export type EarningsAdjustment = typeof earningsAdjustments.$inferSelect;
export type WorkerEarningsSummary = typeof workerEarningsSummary.$inferSelect;
export type AdminRole = typeof adminRoles.$inferSelect;
export type RoleCategoryPermission = typeof roleCategoryPermissions.$inferSelect;

export type InsertUser = z.infer<typeof insertUserSchema>;
export type InsertCategory = z.infer<typeof insertCategorySchema>;
export type InsertTicket = z.infer<typeof insertTicketSchema>;
export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type InsertBotConfig = z.infer<typeof insertBotConfigSchema>;
export type InsertMessageQueue = z.infer<typeof insertMessageQueueSchema>;
export type InsertUserState = z.infer<typeof insertUserStateSchema>;
export type InsertEarningsLedger = z.infer<typeof insertEarningsLedgerSchema>;
export type InsertEarningsAdjustment = z.infer<typeof insertEarningsAdjustmentSchema>;
export type InsertWorkerEarningsSummary = z.infer<typeof insertWorkerEarningsSummarySchema>;
export type InsertAdminRole = z.infer<typeof insertAdminRoleSchema>;
export type InsertRoleCategoryPermission = z.infer<typeof insertRoleCategoryPermissionSchema>;

// Add new type for date range filtering
export type DateRangeFilter = {
  startDate: Date;
  endDate: Date;
} | {
  period: 'week' | 'month' | 'all';
};