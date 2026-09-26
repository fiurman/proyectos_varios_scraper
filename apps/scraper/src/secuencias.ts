import '@precios/db/env';
import { pool } from '@precios/db';

/** Repone los contadores de id despues de restaurar una base.
 *
 *  `pg_restore --data-only` copia las filas pero no mueve las secuencias: los
 *  ids nuevos arrancan de uno y chocan con todo lo que se acaba de cargar. El
 *  sintoma no dice nada de eso —"duplicate key value violates unique
 *  constraint"— y aparece recien al primer insert, o sea a mitad del scrapeo.
 *
 *  Se corre despues de cada restore.
 *
 *   npm run secuencias
 */

async function main(): Promise<void> {
  // Solo las secuencias que pertenecen a una columna: las sueltas, como la de
  // revisiones del catalogo, no tienen un maximo del cual deducir su lugar.
  // Solo el esquema public: la tabla de migraciones de Drizzle vive en el suyo
  // y sus contadores los maneja ella.
  const { rows } = await pool.query<{ tabla: string; columna: string; secuencia: string }>(`
    select c.relname tabla, a.attname columna, s.relname secuencia
      from pg_class s
      join pg_namespace n on n.oid = s.relnamespace
      join pg_depend d on d.objid = s.oid and d.deptype = 'a'
      join pg_class c on c.oid = d.refobjid
      join pg_attribute a on a.attrelid = c.oid and a.attnum = d.refobjsubid
     where s.relkind = 'S' and n.nspname = 'public'
     order by c.relname
  `);

  for (const { tabla, columna, secuencia } of rows) {
    const { rows: [r] } = await pool.query<{ antes: string; ahora: string }>(
      `select (select last_value from ${secuencia})::text antes,
              setval('${secuencia}', coalesce((select max(${columna}) from ${tabla}), 0) + 1, false)::text ahora`,
    );
    const movida = r!.antes !== r!.ahora;
    console.log(`  ${secuencia.padEnd(30)} ${r!.antes.padStart(9)} -> ${r!.ahora.padStart(9)}${movida ? '' : '  (ya estaba bien)'}`);
  }

  if (rows.length === 0) console.log('  No hay secuencias que reponer.');
}

try {
  await main();
} finally {
  await pool.end();
}
