import '@precios/db/env';
import { pool } from '@precios/db';

/** Chequeo rapido de que la base esta y tiene lo que tiene que tener.
 *
 *  Sirve para dos cosas: verificar la conexion despues de mudar la base, y que
 *  la tarea programada falle en un minuto si algo esta mal en vez de a las dos
 *  horas, a mitad del refresco.
 *
 *   npm run comprobar
 */

const MINIMOS: Record<string, number> = {
  stores: 1,
  products: 1000,
  current_prices: 1000,
};

async function main(): Promise<void> {
  const { rows } = await pool.query<{ tabla: string; filas: string }>(`
    select 'stores' tabla, count(*)::text filas from stores
    union all select 'categories', count(*)::text from categories
    union all select 'products', count(*)::text from products
    union all select 'product_sources', count(*)::text from product_sources
    union all select 'current_prices', count(*)::text from current_prices
    union all select 'product_matches', count(*)::text from product_matches
    union all select 'promos_bancarias', count(*)::text from promos_bancarias
    order by 1
  `);

  let flojo = false;
  for (const { tabla, filas } of rows) {
    const n = Number(filas);
    const minimo = MINIMOS[tabla];
    // Una tabla vacia donde deberia haber miles significa que la mudanza
    // quedo a medias, y eso no se nota mirando si la conexion "anda".
    const mal = minimo !== undefined && n < minimo;
    if (mal) flojo = true;
    console.log(`  ${tabla.padEnd(18)} ${String(n).padStart(8)}${mal ? `  <-- esperaba al menos ${minimo}` : ''}`);
  }

  const { rows: [extra] } = await pool.query<{ ext: string }>(
    `select string_agg(extname, ', ' order by extname) ext from pg_extension`,
  );
  console.log(`  extensiones        ${extra!.ext}`);

  if (flojo) {
    console.error('\nHay tablas con menos datos de los esperados.');
    process.exitCode = 1;
  }
}

try {
  await main();
} finally {
  await pool.end();
}
