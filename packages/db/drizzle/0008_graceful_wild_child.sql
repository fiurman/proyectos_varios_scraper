CREATE TABLE "promos_bancarias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain" text NOT NULL,
	"slug" text NOT NULL,
	"banco" text NOT NULL,
	"porcentaje" integer,
	"porcentaje_min" integer,
	"porcentaje_max" integer,
	"dias" smallint[] NOT NULL,
	"tope_cents" integer,
	"tope_mensual" boolean DEFAULT false NOT NULL,
	"texto" text NOT NULL,
	"condiciones" text,
	"url" text NOT NULL,
	"activa" boolean DEFAULT true NOT NULL,
	"vista_en" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_promo_cadena_slug" UNIQUE("chain","slug")
);
--> statement-breakpoint
CREATE INDEX "idx_promos_activas" ON "promos_bancarias" USING btree ("chain","activa");