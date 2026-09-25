import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, pool } from './client.js';

const here = dirname(fileURLToPath(import.meta.url));

await migrate(db, { migrationsFolder: resolve(here, '../drizzle') });
console.log('Migraciones aplicadas.');
await pool.end();
