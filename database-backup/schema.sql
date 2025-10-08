CREATE TABLE "bot_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"welcome_message" text DEFAULT 'Welcome to the support bot! Please select a service:',
	"welcome_image_url" text
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"discord_role_id" text NOT NULL,
	"discord_category_id" text NOT NULL,
	"transcript_category_id" text,
	"questions" text[] NOT NULL,
	"service_summary" text DEFAULT 'Our team is ready to assist you!',
	"service_image_url" text,
	"display_order" integer DEFAULT 0,
	"new_row" boolean DEFAULT false,
	"parent_id" integer,
	"is_submenu" boolean DEFAULT false,
	"is_closed" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_id" integer,
	"content" text NOT NULL,
	"author_id" integer,
	"platform" text NOT NULL,
	"timestamp" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"category_id" integer,
	"status" text NOT NULL,
	"discord_channel_id" text,
	"claimed_by" text,
	"amount" integer,
	"answers" text[],
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"telegram_id" text,
	"discord_id" text,
	"username" text NOT NULL,
	"is_banned" boolean DEFAULT false,
	"telegram_username" text,
	"telegram_name" text,
	CONSTRAINT "users_telegram_id_unique" UNIQUE("telegram_id"),
	CONSTRAINT "users_discord_id_unique" UNIQUE("discord_id")
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;