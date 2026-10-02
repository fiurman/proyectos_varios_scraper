CREATE TABLE "estado_scraper" (
	"clave" text PRIMARY KEY NOT NULL,
	"valor" jsonb NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL
);
