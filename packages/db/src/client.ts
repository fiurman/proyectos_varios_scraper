import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { requireDatabaseUrl } from './env.js';
import * as schema from './schema/index.js';

export const pool = new Pool({ connectionString: requireDatabaseUrl() });

/** Unico punto de acceso a la base. api y scraper importan de aca:
 *  mudar la base a un host remoto es cambiar DATABASE_URL, nada mas. */
export const db = drizzle(pool, { schema });

export type Db = typeof db;
