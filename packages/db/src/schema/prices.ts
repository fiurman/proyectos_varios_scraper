import { sql } from 'drizzle-orm';
import {
  pgTable, uuid, integer, text, char, bigserial, bigint, timestamp, index, primaryKey,
} from 'drizzle-orm/pg-core';
import { products } from './products.js';
import { stores } from './stores.js';

/** Historial append-only. Nunca se hace UPDATE aca: cada scrapeo inserta.
 *  Es lo que permite responder "¿esto aumento?". */
export const prices = pgTable(
  'prices',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
    storeId: uuid('store_id').notNull().references(() => stores.id, { onDelete: 'cascade' }),

    priceCents: integer('price_cents').notNull(), // centavos enteros, jamas float
    promoCents: integer('promo_cents'),
    promoLabel: text('promo_label'),
    currency: char('currency', { length: 3 }).notNull().default('ARS'),

    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
    scrapeRunId: uuid('scrape_run_id'),
  },
  (t) => [index('idx_prices_lookup').on(t.productId, t.storeId, t.capturedAt.desc())],
);

/** Precio vigente desnormalizado: una fila por producto/sucursal.
 *  Es lo que el celular baja en modo Light. Se pisa en cada scrapeo. */
export const currentPrices = pgTable(
  'current_prices',
  {
    productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
    storeId: uuid('store_id').notNull().references(() => stores.id, { onDelete: 'cascade' }),
    priceCents: integer('price_cents').notNull(),
    promoCents: integer('promo_cents'),
    /** La etiqueta con la que la cadena anuncia la promo: "- 25%", "2x1".
     *
     *  Se guarda aunque `promoCents` sea null. Las campañas de La Coope aplican
     *  el descuento sobre el precio y dejan el promocional igual, asi que sin
     *  esto un producto rebajado parece estar a precio normal — y el descuento
     *  de empleado, que no acumula con promociones, se le sumaria encima. */
    promoLabel: text('promo_label'),
    /** Hasta cuando rige, cuando la cadena lo publica. */
    promoHasta: timestamp('promo_hasta', { withTimezone: true }),
    /** Cuantas unidades hay que llevar para que valga `promoCents`.
     *
     *  Null o 1 es la promo comun: el precio rebajado vale desde la primera.
     *  2 o mas es una promo por cantidad —"Llevando 2"— donde el precio de
     *  gondola sigue siendo `priceCents` si te llevas una sola. Sin esto la
     *  Coca-Cola de 1,5 L figuraba a $3.600 cuando llevando una sale $4.190. */
    promoDesde: integer('promo_desde'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revision: bigint('revision', { mode: 'number' })
      .notNull()
      .default(sql`nextval('global_revision_seq')`),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.storeId] }),
    index('idx_current_prices_revision').on(t.revision),
  ],
);
