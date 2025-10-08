-- Create junction table for many-to-many relationship between categories and submenus
CREATE TABLE "category_submenu_relations" (
	"id" serial PRIMARY KEY NOT NULL,
	"category_id" integer NOT NULL,
	"submenu_id" integer NOT NULL,
	"display_order" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now()
);

-- Add foreign key constraints
ALTER TABLE "category_submenu_relations" ADD CONSTRAINT "category_submenu_relations_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "category_submenu_relations" ADD CONSTRAINT "category_submenu_relations_submenu_id_categories_id_fk" FOREIGN KEY ("submenu_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;

-- Add unique constraint to prevent duplicate relations
ALTER TABLE "category_submenu_relations" ADD CONSTRAINT "category_submenu_relations_category_submenu_unique" UNIQUE("category_id", "submenu_id");

-- Create indexes for better performance
CREATE INDEX "category_submenu_relations_category_id_idx" ON "category_submenu_relations" ("category_id");
CREATE INDEX "category_submenu_relations_submenu_id_idx" ON "category_submenu_relations" ("submenu_id");

-- Migrate existing data: for each category with a parentId, create a relation
INSERT INTO "category_submenu_relations" ("category_id", "submenu_id", "display_order")
SELECT 
    c.id as category_id,
    c.parent_id as submenu_id,
    c.display_order
FROM "categories" c
WHERE c.parent_id IS NOT NULL AND c.is_submenu = false;

-- Note: We keep the parentId column for backward compatibility during transition
-- It will be removed in a future migration once we're confident the new system works
