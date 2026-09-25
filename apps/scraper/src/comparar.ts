import { pool } from '@precios/db';
import { toNormalizedName } from './normalize.js';

/** Busca un producto y muestra su precio en cada cadena.
 *
 *  npm run comparar -- yerba              las dos cadenas, comparando
 *  npm run comparar -- yerba disco        solo Disco
 *  npm run comparar -- yerba coope        solo La Coope
 *
 *  El agrupador es coalesce(canonical_product_id, id): los productos que
 *  comparten EAN ya son una sola fila, y los que unimos por match apuntan a su
 *  canonico. Filtrar por cadena no necesita ningun match: sale de stores. */

const CADENAS: Record<string, string> = {
  coope: 'cooperativa_obrera',
  disco: 'disco',
};

const [termino, cadenaArg] = process.argv.slice(2);
if (!termino) {
  console.error('Falta el termino. Ej: npm run comparar -- yerba');
  process.exit(1);
}
const chain = cadenaArg ? CADENAS[cadenaArg] : undefined;
if (cadenaArg && !chain) {
  console.error(`Cadena desconocida: ${cadenaArg}. Opciones: ${Object.keys(CADENAS).join(', ')}`);
  process.exit(1);
}

interface Fila {
  canon: string;
  name: string;
  chain: string;
  tienda: string;
  price_cents: number;
  content_value: string | null;
  content_unit: string | null;
}

const { rows } = await pool.query<Fila>(
  `with encontrados as (
     select distinct coalesce(p.canonical_product_id, p.id) canon
       from products p
      where p.normalized_name like $1 and p.deleted_at is null
   )
   select coalesce(p.canonical_product_id, p.id) canon, p.name, st.chain,
          st.name tienda, cp.price_cents, p.content_value, p.content_unit
     from products p
     join current_prices cp on cp.product_id = p.id
     join stores st on st.id = cp.store_id
    where coalesce(p.canonical_product_id, p.id) in (select canon from encontrados)
      and ($2::text is null or st.chain = $2)
    order by canon, cp.price_cents`,
  [`%${toNormalizedName(termino)}%`, chain ?? null],
);

const grupos = new Map<string, Fila[]>();
for (const f of rows) {
  const g = grupos.get(f.canon);
  if (g) g.push(f);
  else grupos.set(f.canon, [f]);
}

// Primero lo comparable: si un producto esta en las dos cadenas, eso es lo que
// vino a buscar el usuario.
const ordenados = [...grupos.values()].sort((a, b) => b.length - a.length);

const plata = (c: number) => `$${(c / 100).toFixed(2)}`;
let comparables = 0;

for (const g of ordenados.slice(0, 15)) {
  const gramaje = g[0]!.content_value
    ? ` (${Number(g[0]!.content_value)}${g[0]!.content_unit})`
    : '';
  console.log(`\n${g[0]!.name}${gramaje}`);

  const barato = Math.min(...g.map((f) => f.price_cents));
  for (const f of g) {
    const marca = f.price_cents === barato && g.length > 1 ? ' <- mas barato' : '';
    console.log(`   ${f.tienda.padEnd(18)} ${plata(f.price_cents).padStart(11)}${marca}`);
  }
  if (g.length > 1) {
    comparables++;
    const caro = Math.max(...g.map((f) => f.price_cents));
    console.log(`   diferencia: ${plata(caro - barato)} (${(((caro - barato) / barato) * 100).toFixed(0)}%)`);
  }
}

console.log(`\n${grupos.size} productos, ${comparables} comparables entre cadenas.`);
await pool.end();
