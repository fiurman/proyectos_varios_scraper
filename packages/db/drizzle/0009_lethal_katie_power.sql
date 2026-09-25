ALTER TABLE "promos_bancarias" ADD COLUMN "excluye" text[];--> statement-breakpoint
ALTER TABLE "promos_bancarias" ADD COLUMN "excluye_texto" text;--> statement-breakpoint
ALTER TABLE "promos_bancarias" ADD COLUMN "medios_pago" text;--> statement-breakpoint
ALTER TABLE "promos_bancarias" ADD COLUMN "solo_online" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "promos_bancarias" ADD COLUMN "tope_periodo" text;