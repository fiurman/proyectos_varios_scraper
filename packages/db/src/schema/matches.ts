import { pgTable, uuid, text, numeric, timestamp, unique, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { products } from './products.js';

/** Candidatos a ser el mismo producto en dos cadenas distintas.
 *
 *  Cuando una fuente publica EAN-13 el cruce es trivial y lo resuelve el
 *  scraper al persistir. La Coope no lo publica, asi que sus 6.084 productos
 *  hay que emparejarlos contra los de una cadena que si lo tenga, comparando
 *  marca, gramaje y nombre. Eso es heuristica, no un hecho: por eso el par vive
 *  aca con su score y su estado, y no fusionado dentro de products.
 *
 *  Mantenerlo separado permite recalcular el matcher entero sin tocar el
 *  catalogo, revisar a mano lo dudoso, y mas adelante dejar que los usuarios
 *  confirmen o corrijan pares desde la app escaneando el codigo de barras. */
export const productMatches = pgTable(
  'product_matches',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** El producto sin EAN (hoy, La Coope). */
    productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
    /** El producto con EAN contra el que lo emparejamos. */
    matchProductId: uuid('match_product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),

    /** Copia del EAN al momento del match: si despues se corrige el catalogo,
     *  queda registro de contra que codigo se habia emparejado. */
    ean13: text('ean13'),

    /** Jaccard de tokens del nombre, 0 a 1. */
    score: numeric('score', { precision: 4, scale: 3 }).notNull(),
    /** Como se llego al par, para poder descartar por estrategia al recalcular. */
    strategy: text('strategy').notNull(),

    /** 'auto' score alto | 'pendiente' a revisar | 'confirmado' | 'rechazado'.
     *  Nada de esto toca products: aplicar un match es un paso aparte. */
    status: text('status').notNull().default('pendiente'),

    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    /** Cuando se volco a products.canonical_product_id. NULL = todavia no. */
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Un solo par por combinacion: el matcher se puede correr las veces que sea.
    unique('uq_match_par').on(t.productId, t.matchProductId),
    index('idx_matches_producto').on(t.productId),
    index('idx_matches_status').on(t.status),
    check('ck_match_no_self', sql`${t.productId} <> ${t.matchProductId}`),
    check('ck_match_status', sql`${t.status} in ('auto','pendiente','confirmado','rechazado')`),
  ],
);
