import '@precios/db/env';
import { pool } from '@precios/db';

/** Lista los codigos de barras que dos productos se disputan.
 *
 *  Cuando una cadena reporta un EAN que ya pertenece a otro producto nuestro,
 *  el scraper conserva el que estaba, ignora el nuevo y anota el choque. Esto
 *  los muestra para poder decidir a mano cual de las dos cadenas tiene razon.
 *
 *  npm run conflictos              los sin resolver
 *  npm run conflictos -- todos     tambien los ya marcados */

const todos = (process.argv[2] ?? '') === 'todos';

interface Fila {
  ean13: string;
  chain: string;
  external_id: string;
  veces: number;
  nombre_nuevo: string;
  nombre_poseedor: string;
  cadena_poseedor: string | null;
  visto_en: Date;
}

const { rows } = await pool.query<Fila>(
  `select c.ean13, c.chain, c.external_id, c.veces,
          c.nombre_nuevo, c.nombre_poseedor, c.visto_en,
          (select s.chain from product_sources s
            where s.product_id = c.poseedor_product_id limit 1) cadena_poseedor
     from ean_conflictos c
    ${todos ? '' : 'where c.resuelto_en is null'}
    order by c.veces desc, c.visto_en desc`,
);

if (rows.length === 0) {
  console.log('Sin conflictos de codigo de barras.');
} else {
  console.log(`${rows.length} ${rows.length === 1 ? 'conflicto' : 'conflictos'}:\n`);

  for (const f of rows) {
    const dia = f.visto_en.toLocaleDateString('es-AR');
    console.log(`  ${f.ean13}   visto ${f.veces}x, ultima el ${dia}`);
    console.log(`     lo reclama  ${f.chain} (${f.external_id}): ${f.nombre_nuevo.slice(0, 56)}`);
    console.log(`     lo conserva ${f.cadena_poseedor ?? '?'}: ${f.nombre_poseedor.slice(0, 56)}`);
    console.log();
  }

  console.log('Si los nombres describen el MISMO producto, una de las dos cadenas');
  console.log('tiene mal el codigo. Si son distintos, el conflicto es real y el');
  console.log('criterio actual —conservar el primero— es el correcto.');
}

await pool.end();
