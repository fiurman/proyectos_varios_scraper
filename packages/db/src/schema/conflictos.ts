import { pgTable, uuid, text, integer, timestamp, unique, index } from 'drizzle-orm/pg-core';
import { products } from './products.js';

/** Codigos de barras que dos productos distintos se disputan.
 *
 *  Pasa porque las cadenas cargan mal: Disco empezo a reportar para sus
 *  galletitas de dulce de leche el mismo EAN que Carrefour usa para las de
 *  chocolate. Una de las dos se equivoco, y no es algo que podamos arreglar
 *  desde afuera.
 *
 *  Lo que si podemos es no dejar que nos rompa: el scraper conserva el codigo
 *  que ya tenia el producto, ignora el nuevo y anota el choque aca. Guardamos
 *  los dos nombres para que despues se pueda mirar la fila y decidir de un
 *  vistazo cual de las dos cadenas tiene razon.
 *
 *  Mismo criterio que product_matches: lo dudoso se registra con su contexto
 *  en vez de decidirse solo o descartarse en silencio. */
export const eanConflictos = pgTable(
  'ean_conflictos',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    ean13: text('ean13').notNull(),

    /** El producto que reclama el codigo en esta corrida. */
    productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
    chain: text('chain').notNull(),
    externalId: text('external_id').notNull(),

    /** El producto que ya lo tenia y se queda con el. */
    poseedorProductId: uuid('poseedor_product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),

    // Los nombres copiados al momento del choque: sin esto hay que cruzar
    // tres tablas para entender si son el mismo producto o dos distintos.
    nombreNuevo: text('nombre_nuevo').notNull(),
    nombrePoseedor: text('nombre_poseedor').notNull(),

    /** Cuantas corridas seguidas lo reportaron. Uno puede ser un error de un
     *  dia; veinte es que la cadena lo tiene mal cargado de verdad. */
    veces: integer('veces').notNull().default(1),

    resueltoEn: timestamp('resuelto_en', { withTimezone: true }),
    vistoEn: timestamp('visto_en', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Una fila por disputa, no una por corrida.
    unique('uq_conflicto').on(t.ean13, t.productId),
    index('idx_conflictos_sin_resolver').on(t.resueltoEn),
  ],
);
