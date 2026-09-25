import { sql } from 'drizzle-orm';
import {
  pgTable, uuid, text, integer, bigint, timestamp, vector, unique,
} from 'drizzle-orm/pg-core';
import { products } from './products.js';

/** MODO FULL. Nada de este archivo viaja en el sync Light. */
export const productMedia = pgTable(
  'product_media',
  {
  id: uuid('id').primaryKey().defaultRandom(),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(), // 'thumbnail' | 'full' | 'nutritional'
  url: text('url').notNull(),
  width: integer('width'),
  height: integer('height'),
  bytes: integer('bytes'),
  checksum: text('checksum'), // evita re-descargar lo mismo
  revision: bigint('revision', { mode: 'number' })
    .notNull()
    .default(sql`nextval('global_revision_seq')`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Clave de upsert del scraper: la misma imagen no se duplica al re-scrapear.
  // Por url y no por kind porque un producto canonico puede tener foto de mas
  // de una cadena, y tener ambas es mejor que pisarlas entre si.
  (t) => [unique('uq_media_url').on(t.productId, t.url)],
);

/** Matching visual offline: para cuando la camara ve un producto sin codigo
 *  de barras visible o borroso. */
export const productVisualFeatures = pgTable(
  'product_visual_features',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),

    modelName: text('model_name').notNull(),    // 'mobilenet_v3' | 'clip_vit_b32'
    modelVersion: text('model_version').notNull(),
    embedding: vector('embedding', { dimensions: 512 }),

    // Hash perceptual: filtro barato y previo al embedding. Se compara en el
    // celular con una simple distancia de Hamming.
    phash: bigint('phash', { mode: 'bigint' }),

    sourceMediaId: uuid('source_media_id').references(() => productMedia.id, {
      onDelete: 'set null',
    }),
    revision: bigint('revision', { mode: 'number' })
      .notNull()
      .default(sql`nextval('global_revision_seq')`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Permite convivencia de varias versiones de modelo: al cambiar de modelo
  // cargas los embeddings nuevos al lado de los viejos, sin migracion destructiva.
  (t) => [unique('uq_visual_model').on(t.productId, t.modelName, t.modelVersion)],
);
