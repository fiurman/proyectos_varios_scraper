import { pool } from '@precios/db';

/** Vuelca los matches aceptados a products.canonical_product_id.
 *
 *  No fusiona ni borra nada: cada producto conserva su fila, su historial y sus
 *  precios, y solo queda apuntando a cual es el canonico del par. Por eso
 *  `npm run apply -- deshacer` alcanza para volver atras. */

const deshacer = (process.argv[2] ?? '') === 'deshacer';

async function aplicar(): Promise<void> {
  // Reconciliar primero: si un match se borro o se rechazo despues de haberse
  // aplicado, su puntero quedo colgado apuntando a un par que ya no existe.
  // Recalcular el matcher es normal, asi que esto tiene que autocorregirse.
  const { rowCount: huerfanos } = await pool.query(
    `update products p set canonical_product_id = null, updated_at = now()
      where p.canonical_product_id is not null
        and not exists (select 1 from product_matches m
                         where m.product_id = p.id and m.applied_at is not null)`,
  );
  if (huerfanos) console.log(`Punteros huerfanos limpiados: ${huerfanos}`);

  const { rows: [previo] } = await pool.query<{ pendientes: string }>(
    `select count(*) pendientes from product_matches
      where status in ('auto','confirmado') and applied_at is null`,
  );
  console.log(`Matches aceptados sin aplicar: ${previo!.pendientes}`);

  const { rowCount: apuntados } = await pool.query(
    `update products p
        set canonical_product_id = m.match_product_id, updated_at = now()
       from product_matches m
      where m.product_id = p.id
        and m.status in ('auto','confirmado')
        and m.applied_at is null
        and p.id <> m.match_product_id`,
  );

  await pool.query(
    `update product_matches set applied_at = now(), updated_at = now()
      where status in ('auto','confirmado') and applied_at is null`,
  );

  console.log(`Productos apuntados a su canonico: ${apuntados}`);

  // Un grupo no puede tener dos productos de la misma cadena.
  //
  // Si los tiene, alguno matcheo mal: son productos distintos que se parecen
  // de nombre. La pasta Colgate "luminous white" y la "luminous white carbon"
  // cayeron juntas, y la app mostraba dos renglones de Cooperativa con precios
  // distintos —cobrando el mas barato, que era el del producto equivocado—.
  //
  // Se queda uno solo si se distingue claro del otro; si estan parejos se
  // sueltan todos. Contra un canonico que dice "charcoal", el nombre "white"
  // puntua mas alto que "white carbon", que es el correcto: el parecido de
  // texto no alcanza para decidir y elegir igual sale mal la mitad de las
  // veces. Un producto sin comparacion es honesto; el precio de otro producto
  // no lo es.
  const MARGEN = 0.08;
  const { rowCount: soltados } = await pool.query(
    `with delGrupo as (
       select p.id,
              coalesce(p.canonical_product_id, p.id) canon,
              ps.chain,
              p.canonical_product_id is null esCanonico,
              similarity(p.normalized_name, c.normalized_name) parecido
         from products p
         join product_sources ps on ps.product_id = p.id
         join products c on c.id = coalesce(p.canonical_product_id, p.id)
        where p.deleted_at is null
     ),
     ordenados as (
       select id, canon, chain, esCanonico, parecido,
              row_number() over (
                partition by canon, chain
                order by esCanonico desc, parecido desc, id
              ) puesto,
              count(*) over (partition by canon, chain) cuantos,
              max(parecido) filter (where not esCanonico)
                over (partition by canon, chain) mejor,
              nth_value(parecido, 2) over (
                partition by canon, chain
                order by esCanonico desc, parecido desc, id
                rows between unbounded preceding and unbounded following
              ) segundo
         from delGrupo
     )
     update products p
        set canonical_product_id = null, updated_at = now()
       from ordenados o
      where o.id = p.id
        and p.canonical_product_id is not null
        and o.cuantos > 1
        and not o.esCanonico
        -- Se suelta el que no quedo primero, y tambien el primero cuando el
        -- segundo le pisa los talones: ahi no hay forma de saber cual es.
        and (o.puesto > 1 or coalesce(o.mejor - o.segundo, 1) < ${MARGEN})`,
  );
  if (soltados) console.log(`Sueltos por duplicar cadena en su grupo: ${soltados}`);
}

async function revertir(): Promise<void> {
  const { rowCount: limpiados } = await pool.query(
    `update products p set canonical_product_id = null, updated_at = now()
       from product_matches m
      where m.product_id = p.id and m.applied_at is not null`,
  );
  await pool.query(`update product_matches set applied_at = null, updated_at = now()
                     where applied_at is not null`);
  console.log(`Punteros borrados: ${limpiados}`);
}

try {
  if (deshacer) await revertir();
  else await aplicar();

  const { rows: [estado] } = await pool.query<{ con_canonico: string }>(
    `select count(*) con_canonico from products where canonical_product_id is not null`,
  );
  console.log(`Total de productos con canonico: ${estado!.con_canonico}`);
} finally {
  await pool.end();
}
