import { pgTable, uuid, text, timestamp, unique, index } from 'drizzle-orm/pg-core';
import { products } from './products.js';

/** Un producto canonico puede existir en varias cadenas, cada una con su
 *  codigo interno. Esta tabla es lo que permite decir "la yerba Playadito 1kg
 *  es el 281332 en La Coope y el 99887 en otra cadena", y por lo tanto
 *  comparar precios entre supermercados.
 *
 *  Tambien es el lugar natural donde aterriza el EAN cuando la fuente si lo
 *  expone: no todas las cadenas tienen API, y las que scrapeemos por HTML
 *  suelen publicar el codigo de barras en la ficha del producto. */
export const productSources = pgTable(
  'product_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),

    chain: text('chain').notNull(),          // 'cooperativa_obrera'
    externalId: text('external_id').notNull(), // cod_interno en esa cadena
    url: text('url'),
    rawName: text('raw_name'),               // nombre tal cual lo da la fuente

    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Clave de upsert del scraper: una fila por producto y cadena.
    unique('uq_source_external').on(t.chain, t.externalId),
    index('idx_sources_product').on(t.productId),
  ],
);
