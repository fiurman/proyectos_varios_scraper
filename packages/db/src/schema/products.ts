import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  pgTable, uuid, text, varchar, numeric, boolean, jsonb, bigint, timestamp, index,
} from 'drizzle-orm/pg-core';
import { categories } from './categories.js';

/** Nucleo del modo LIGHT: todo lo de esta tabla viaja al celular.
 *  Lo pesado (imagenes, embeddings) vive en tablas aparte a proposito. */
export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // NULL a proposito: frutas, verduras, fiambreria y carniceria no tienen EAN.
    // Es justamente el caso que despues resuelve el matching visual.
    ean13: varchar('ean13', { length: 13 }).unique(),
    internalSku: text('internal_sku'),

    // Apunta al producto que hace de canonico cuando dos fichas de cadenas
    // distintas son el mismo articulo y no hay EAN que lo pruebe. Cuando si lo
    // hay, el scraper ya las guarda en una sola fila y esto queda NULL.
    //
    // Es un puntero, no una fusion: aplicar un match es un UPDATE, deshacerlo
    // tambien. El producto original conserva su historial y sus precios.
    // El tipo explicito rompe la recursion: la columna apunta a la tabla que
    // la contiene y TS no puede inferirla sola.
    canonicalProductId: uuid('canonical_product_id')
      .references((): AnyPgColumn => products.id, { onDelete: 'set null' }),

    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(), // minusculas y sin tildes
    brand: text('brand'),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),

    // Contenido desglosado, no como texto libre: permite calcular precio por
    // unidad y comparar 900ml contra 1L.
    contentValue: numeric('content_value', { precision: 10, scale: 3 }),
    contentUnit: text('content_unit'), // 'g' | 'ml' | 'un' | 'kg' | 'l'
    isWeighted: boolean('is_weighted').notNull().default(false),

    // Valvula de escape: campos nuevos sin migracion (sin_tacc, organico, ...).
    attributes: jsonb('attributes').notNull().default(sql`'{}'::jsonb`),

    // Motor del sync incremental. El trigger la actualiza en cada UPDATE.
    revision: bigint('revision', { mode: 'number' })
      .notNull()
      .default(sql`nextval('global_revision_seq')`),
    deletedAt: timestamp('deleted_at', { withTimezone: true }), // tombstone
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_products_revision').on(t.revision),
    index('idx_products_category').on(t.categoryId),
    index('idx_products_canonical').on(t.canonicalProductId),
  ],
);
