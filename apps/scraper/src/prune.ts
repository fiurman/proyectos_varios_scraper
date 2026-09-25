import { pool } from '@precios/db';

/** Poda los payloads crudos de las corridas viejas.
 *
 *  raw_scrape_items guarda el payload de cada producto en cada corrida, para
 *  poder reprocesar sin volver a scrapear. Pero durante el desarrollo se
 *  scrapea muchas veces al dia, y cada pasada duplica el catalogo entero: son
 *  ~3.4 KB por producto, asi que una corrida completa de las tres cadenas pesa
 *  mas de 50 MB. Guardar las ultimas N por cadena alcanza para lo que la tabla
 *  existe; el resto es lastre.
 *
 *  No toca products, prices ni el historial: solo el crudo de respaldo. */

const conservar = Number(process.argv[2] ?? 1);
if (!Number.isInteger(conservar) || conservar < 1) {
  console.error('Cuantas corridas conservar por cadena. Ej: npm run prune -- 2');
  process.exit(1);
}

// Las corridas que quedaron en 'running' son procesos que murieron: sin esto
// quedarian marcadas asi para siempre y se salvarian de la poda.
const { rowCount: colgadas } = await pool.query(
  `update scrape_runs set status='failed', finished_at=now(),
          error_message=coalesce(error_message,'proceso interrumpido')
    where status='running' and started_at < now() - interval '10 minutes'`,
);

const { rows: [antes] } = await pool.query<{ crudos: string; peso: string }>(
  `select count(*) crudos, pg_size_pretty(pg_total_relation_size('raw_scrape_items')) peso
     from raw_scrape_items`,
);

const { rowCount: borrados } = await pool.query(
  `delete from raw_scrape_items i
    where i.scrape_run_id in (
      select id from (
        select id, row_number() over (partition by chain order by started_at desc) n
          from scrape_runs where status = 'success'
      ) t where n > $1
      union all
      select id from scrape_runs where status <> 'success'
    )`,
  [conservar],
);

// Sin esto Postgres marca el espacio como reusable pero no lo devuelve al disco.
await pool.query('vacuum full raw_scrape_items');

const { rows: [despues] } = await pool.query<{ crudos: string; peso: string }>(
  `select count(*) crudos, pg_size_pretty(pg_total_relation_size('raw_scrape_items')) peso
     from raw_scrape_items`,
);

console.log(`Corridas colgadas marcadas como fallidas: ${colgadas}`);
console.log(`Crudos: ${antes!.crudos} (${antes!.peso})  ->  ${despues!.crudos} (${despues!.peso})`);
console.log(`Borrados: ${borrados}`);

const { rows: [db] } = await pool.query<{ t: string }>(
  `select pg_size_pretty(pg_database_size(current_database())) t`,
);
console.log(`Base: ${db!.t}`);

await pool.end();
