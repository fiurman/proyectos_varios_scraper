ALTER TABLE "products" ADD COLUMN "canonical_product_id" uuid;--> statement-breakpoint
ALTER TABLE "product_matches" ADD COLUMN "applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_canonical_product_id_products_id_fk" FOREIGN KEY ("canonical_product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_products_canonical" ON "products" USING btree ("canonical_product_id");