import { pgTable, text, serial, integer, boolean, timestamp, bigint } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { relations } from "drizzle-orm";
import { z } from "zod";

export const botConfig = pgTable("bot_config", {
  id: serial("id").primaryKey(),
  welcomeMessage: text("welcome_message").default("Welcome to the support bot! Please select a service:"),
  welcomeImageUrl: text("welcome_image_url"),
  telegramToken: text("telegram_token"),
  discordToken: text("discord_token"),
  revoltToken: text("revolt_token"),
  telegramRevoltToken: text("telegram_revolt_token"), // Separate Telegram token when using Revolt
  adminTelegramIds: text("admin_telegram_ids").array().default([]),
  adminDiscordIds: text("admin_discord_ids").array().default([]),
  adminRevoltIds: text("admin_revolt_ids").array().default([]),
  activeProvider: text("active_provider").default("discord"), // "discord" or "revolt"
});

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").unique(),
  discordId: text("discord_id").unique(),
  revoltId: text("revolt_id").unique(),
  username: text("username").notNull(),
  isBanned: boolean("is_banned").default(false),
  banReason: text("ban_reason"),
  bannedAt: timestamp("banned_at"),
  bannedBy: text("banned_by"),
  telegramUsername: text("telegram_username"),
  telegramName: text("telegram_name"),
  revoltUsername: text("revolt_username"),
});

// Forward declare the categories type to resolve circular reference
const categoriesConfig = {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  // Discord fields
  discordRoleId: text("discord_role_id").default(""),
  discordCategoryId: text("discord_category_id").default(""),
  transcriptCategoryId: text("transcript_category_id"),
  // Revolt fields
  revoltRoleId: text("revolt_role_id").default(""),
  revoltCategoryId: text("revolt_category_id").default(""),
  revoltTranscriptCategoryId: text("revolt_transcript_category_id"),
  // Shared fields
  questions: text("questions").array().notNull(),
  serviceSummary: text("service_summary").default("Our team is ready to assist you!"),
  serviceImageUrl: text("service_image_url"),
  displayOrder: integer("display_order").default(0),
  newRow: boolean("new_row").default(false),
  parentId: integer("parent_id"),
  isSubmenu: boolean("is_submenu").default(false),
  isClosed: boolean("is_closed").default(false),
};

export const categories = pgTable("categories", categoriesConfig);

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
  revoltChannelId: text("revolt_channel_id"),
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
  telegramUserId: text("telegram_user_id").notNull(),
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
  telegramId: text("telegram_id").notNull(), // Keep as text for compatibility
  state: text("state").notNull(), // JSON serialized state
  timestamp: timestamp("timestamp").defaultNow().notNull(),
  isActive: boolean("is_active").default(true).notNull(),
});

export const insertUserSchema = createInsertSchema(users).omit({ id: true });
export const insertCategorySchema = createInsertSchema(categories).omit({ id: true });
export const insertTicketSchema = createInsertSchema(tickets).omit({ id: true });
export const insertMessageSchema = createInsertSchema(messages).omit({ id: true });
export const insertBotConfigSchema = createInsertSchema(botConfig).omit({ id: true });
export const insertMessageQueueSchema = createInsertSchema(messageQueue).omit({ id: true });
export const insertUserStateSchema = createInsertSchema(userStates).omit({ id: true });

export type User = typeof users.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Ticket = typeof tickets.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type BotConfig = typeof botConfig.$inferSelect;
export type MessageQueue = typeof messageQueue.$inferSelect;
export type UserState = typeof userStates.$inferSelect;

export type InsertUser = z.infer<typeof insertUserSchema>;
export type InsertCategory = z.infer<typeof insertCategorySchema>;
export type InsertTicket = z.infer<typeof insertTicketSchema>;
export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type InsertBotConfig = z.infer<typeof insertBotConfigSchema>;
export type InsertMessageQueue = z.infer<typeof insertMessageQueueSchema>;
export type InsertUserState = z.infer<typeof insertUserStateSchema>;

// Add new type for date range filtering
export type DateRangeFilter = {
  startDate: Date;
  endDate: Date;
} | {
  period: 'week' | 'month' | 'all';
};