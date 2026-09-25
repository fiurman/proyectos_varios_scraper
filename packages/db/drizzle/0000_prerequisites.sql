-- Extensiones. Nota: no hace falta uuid-ossp, gen_random_uuid() es nativo desde PG13.
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint

-- Secuencia global compartida por todas las tablas sincronizables.
-- Da un orden total de escrituras: el celular guarda "vengo hasta la revision N"
-- y pide solo lo que cambio desde entonces.
CREATE SEQUENCE IF NOT EXISTS global_revision_seq;
--> statement-breakpoint

-- Asigna una revision nueva en cada UPDATE. Sin esto, una fila modificada
-- conserva su revision vieja y el cliente nunca se entera del cambio.
CREATE OR REPLACE FUNCTION bump_revision() RETURNS trigger AS $$
BEGIN
  NEW.revision := nextval('global_revision_seq');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
