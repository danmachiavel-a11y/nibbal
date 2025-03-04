import { pgTable, text, serial, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const botConfig = pgTable("bot_config", {
  id: serial("id").primaryKey(),
  welcomeMessage: text("welcome_message").default("Welcome to the support bot! Please select a service:"),
  welcomeImageUrl: text("welcome_image_url"),
});

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").unique(),
  discordId: text("discord_id").unique(),
  username: text("username").notNull(),
  isBanned: boolean("is_banned").default(false),
});

export const categories = pgTable("categories", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  discordRoleId: text("discord_role_id").notNull(),
  discordCategoryId: text("discord_category_id").notNull(),
  questions: text("questions").array().notNull(),
  serviceSummary: text("service_summary").default("Our team is ready to assist you!"),
  serviceImageUrl: text("service_image_url"),
});

export const tickets = pgTable("tickets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id),
  categoryId: integer("category_id").references(() => categories.id),
  status: text("status").notNull(), // open, claimed, closed
  discordChannelId: text("discord_channel_id"),
  claimedBy: text("claimed_by"), // Discord user ID
  amount: integer("amount"),
  answers: text("answers").array(),
});

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  ticketId: integer("ticket_id").references(() => tickets.id),
  content: text("content").notNull(),
  authorId: integer("author_id").references(() => users.id),
  platform: text("platform").notNull(), // telegram or discord
  timestamp: timestamp("timestamp").notNull(),
});

export const insertUserSchema = createInsertSchema(users).omit({ id: true });
export const insertCategorySchema = createInsertSchema(categories).omit({ id: true });
export const insertTicketSchema = createInsertSchema(tickets).omit({ id: true });
export const insertMessageSchema = createInsertSchema(messages).omit({ id: true });
export const insertBotConfigSchema = createInsertSchema(botConfig).omit({ id: true });

export type User = typeof users.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Ticket = typeof tickets.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type BotConfig = typeof botConfig.$inferSelect;

export type InsertUser = z.infer<typeof insertUserSchema>;
export type InsertCategory = z.infer<typeof insertCategorySchema>;
export type InsertTicket = z.infer<typeof insertTicketSchema>;
export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type InsertBotConfig = z.infer<typeof insertBotConfigSchema>;