import { sql } from 'drizzle-orm';
import { db, pool } from '@precios/db';

const limite = Number(process.argv[2] ?? 10);
const filtro = process.argv[3] ?? null;

const pesos = (centavos: number | null) =>
  centavos === null ? '—' : '$' + (centavos / 100).toLocaleString('es-AR', { minimumFractionDigits: 2 });

const { rows: resumen } = await pool.query(`
  SELECT (SELECT count(*) FROM products)       AS productos,
         (SELECT count(*) FROM prices)         AS capturas,
         (SELECT count(*) FROM categories)     AS categorias,
         (SELECT max(started_at) FROM scrape_runs) AS ultima
`);
const r = resumen[0];
console.log(`\nBase: ${r.productos} productos · ${r.capturas} capturas de precio · ${r.categorias} categorías`);
console.log(`Último scrapeo: ${r.ultima ? new Date(r.ultima).toLocaleString('es-AR') : 'nunca'}\n`);
console.log('─'.repeat(78));

const { rows } = await pool.query(
  `SELECT p.name, p.brand, p.content_value, p.content_unit, p.is_weighted,
          p.ean13, ps.external_id, ps.url,
          cp.price_cents, cp.promo_cents,
          (SELECT string_agg(a.name, ' > ' ORDER BY a.lvl)
             FROM (WITH RECURSIVE sube AS (
                     SELECT id, name, parent_id, 0 lvl FROM categories WHERE id = p.category_id
                     UNION ALL
                     SELECT c.id, c.name, c.parent_id, s.lvl-1 FROM categories c JOIN sube s ON c.id = s.parent_id
                   ) SELECT * FROM sube) a) AS categoria
     FROM products p
     JOIN product_sources ps ON ps.product_id = p.id
     JOIN current_prices  cp ON cp.product_id = p.id
    WHERE ($2::text IS NULL OR p.normalized_name LIKE '%'||lower($2)||'%')
    ORDER BY p.name
    LIMIT $1`,
  [limite, filtro],
);

rows.forEach((p: any, i: number) => {
  const envase = p.content_value
    ? `${Number(p.content_value)} ${p.content_unit}${p.is_weighted ? ' (por peso)' : ''}`
    : '—';
  // Precio por kilo/litro: sólo tiene sentido comparando envases distintos.
  let unitario = '';
  if (p.content_value && ['g', 'ml'].includes(p.content_unit)) {
    const factor = 1000 / Number(p.content_value);
    unitario = `   →  ${pesos(Math.round(p.price_cents * factor))} por ${p.content_unit === 'g' ? 'kg' : 'l'}`;
  }
  console.log(`\n[${String(i + 1).padStart(2)}] ${p.name}`);
  console.log(`     marca: ${p.brand ?? '—'}   envase: ${envase}`);
  console.log(`     categoría: ${p.categoria ?? '—'}`);
  console.log(`     precio: ${pesos(p.price_cents)}   promo: ${pesos(p.promo_cents)}${unitario}`);
  console.log(`     cod_interno: ${p.external_id}   EAN: ${p.ean13 ?? '(la fuente no lo publica)'}`);
  console.log(`     ${p.url}`);
});

console.log('\n' + '─'.repeat(78) + `\nMostrando ${rows.length} de ${r.productos}.\n`);
await pool.end();
