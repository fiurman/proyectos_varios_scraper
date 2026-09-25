CREATE TABLE "product_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"match_product_id" uuid NOT NULL,
	"ean13" text,
	"score" numeric(4, 3) NOT NULL,
	"strategy" text NOT NULL,
	"status" text DEFAULT 'pendiente' NOT NULL,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_match_par" UNIQUE("product_id","match_product_id"),
	CONSTRAINT "ck_match_no_self" CHECK ("product_matches"."product_id" <> "product_matches"."match_product_id"),
	CONSTRAINT "ck_match_status" CHECK ("product_matches"."status" in ('auto','pendiente','confirmado','rechazado'))
);
--> statement-breakpoint
ALTER TABLE "product_matches" ADD CONSTRAINT "product_matches_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_matches" ADD CONSTRAINT "product_matches_match_product_id_products_id_fk" FOREIGN KEY ("match_product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_matches_producto" ON "product_matches" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "idx_matches_status" ON "product_matches" USING btree ("status");