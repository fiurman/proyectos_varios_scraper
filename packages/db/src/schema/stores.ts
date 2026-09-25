import { pgTable, uuid, text, numeric, boolean, timestamp } from 'drizzle-orm/pg-core';

/** Sucursales. Existe desde el dia 1 aunque arranquemos con una sola cadena:
 *  agregarla despues obligaria a migrar toda la tabla de precios. */
export const stores = pgTable('stores', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  chain: text('chain').notNull(),
  name: text('name').notNull(),
  address: text('address'),
  latitude: numeric('latitude', { precision: 9, scale: 6 }),
  longitude: numeric('longitude', { precision: 9, scale: 6 }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
