CREATE TABLE "ean_conflictos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ean13" text NOT NULL,
	"product_id" uuid NOT NULL,
	"chain" text NOT NULL,
	"external_id" text NOT NULL,
	"poseedor_product_id" uuid NOT NULL,
	"nombre_nuevo" text NOT NULL,
	"nombre_poseedor" text NOT NULL,
	"veces" integer DEFAULT 1 NOT NULL,
	"resuelto_en" timestamp with time zone,
	"visto_en" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_conflicto" UNIQUE("ean13","product_id")
);
--> statement-breakpoint
ALTER TABLE "ean_conflictos" ADD CONSTRAINT "ean_conflictos_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ean_conflictos" ADD CONSTRAINT "ean_conflictos_poseedor_product_id_products_id_fk" FOREIGN KEY ("poseedor_product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_conflictos_sin_resolver" ON "ean_conflictos" USING btree ("resuelto_en");