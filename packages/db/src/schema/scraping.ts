import { pgTable, uuid, text, integer, bigserial, jsonb, timestamp } from 'drizzle-orm/pg-core';

export const scrapeRuns = pgTable('scrape_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  chain: text('chain').notNull(),
  status: text('status').notNull(), // running | success | failed
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  itemsFound: integer('items_found').default(0),
  errorMessage: text('error_message'),
});

/** Payload crudo tal como vino. Si manana queres extraer un campo que hoy
 *  ignoras, lo reprocesas de aca en vez de volver a scrapear todo el sitio. */
export const rawScrapeItems = pgTable('raw_scrape_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  scrapeRunId: uuid('scrape_run_id').notNull().references(() => scrapeRuns.id, { onDelete: 'cascade' }),
  sourceUrl: text('source_url'),
  payload: jsonb('payload').notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
});
