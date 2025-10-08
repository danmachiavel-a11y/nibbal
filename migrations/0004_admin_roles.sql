CREATE TABLE "admin_roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"role_name" text NOT NULL,
	"discord_role_id" text NOT NULL,
	"is_full_admin" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "admin_roles_role_name_unique" UNIQUE("role_name"),
	CONSTRAINT "admin_roles_discord_role_id_unique" UNIQUE("discord_role_id")
);
--> statement-breakpoint
CREATE TABLE "role_category_permissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"role_id" integer NOT NULL,
	"category_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "role_category_permissions_role_category_unique" UNIQUE("role_id","category_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "role_category_permissions_role_category_unique" ON "role_category_permissions" ("role_id","category_id");
--> statement-breakpoint
CREATE INDEX "role_category_permissions_role_id_idx" ON "role_category_permissions" ("role_id");
--> statement-breakpoint
CREATE INDEX "role_category_permissions_category_id_idx" ON "role_category_permissions" ("category_id");
--> statement-breakpoint
ALTER TABLE "role_category_permissions" ADD CONSTRAINT "role_category_permissions_role_id_admin_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."admin_roles"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "role_category_permissions" ADD CONSTRAINT "role_category_permissions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;
