import '@precios/db/env';
import { pool, db, currentPrices, productSources, stores } from '@precios/db';
import { and, eq, lt, sql } from 'drizzle-orm';
import { traer } from './traer.js';

/** Repesca los productos de La Coope que se caen del listado por categoria.
 *
 *  El listado esconde lo que no tiene stock *online*, pero la gondola no se
 *  entera: el yogur que la web da por agotado esta en el freezer de la
 *  sucursal, con su cartel de oferta puesto. Cuando eso pasa el producto deja
 *  de actualizarse y queda con el precio del ultimo dia que tuvo stock, sin la
 *  promo que le pusieron despues. En un ticket real eso fueron $126,90 de mas.
 *
 *  `articulo/detalle` si los devuelve, uno por uno. Son pocos —del orden de
 *  cien— asi que pedirlos de a uno sale barato.
 *
 *  Se consultan las dos APIs porque la cadena `cooperativa_obrera` junta los
 *  dos catalogos: el del super y el de Coope Hogar, que comparten SKU y
 *  sucursal fisica. Un codigo que no esta en una suele estar en la otra.
 *
 *   npm run repechaje          actualiza
 *   npm run repechaje -- ver   muestra sin tocar la base */

const APIS = [
  'https://api.lacoopeencasa.coop/api',
  'https://api.coopehogar.coop/api',
];
const UA = 'precios-varios/0.1 (proyecto personal de comparacion de precios)';
const CADENA = 'cooperativa_obrera';
const DELAY_MS = 400;

/** Cuanto tiene que hacer que no se lo ve para considerarlo caido del listado.
 *
 *  El refresco corre varias veces por dia, asi que un producto vivo se toca
 *  seguido. Un dia entero sin aparecer ya es que el listado dejo de traerlo. */
const HORAS = 20;

/** Tope por corrida. Si un dia falla el scrapeo entero, sin esto el repechaje
 *  intentaria el catalogo completo de a un pedido por vez. */
const MAX = 800;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Detalle {
  cod_interno?: string | number;
  precio?: string | number | null;
  precio_anterior?: string | number | null;
  existe_promo?: string | number | boolean | null;
  vigencia_promo?: string | null;
  descripcion_promo?: string | null;
}

const aCentavos = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};

/** El listado manda '1' y el detalle manda 'true'. Es la misma bandera. */
const hayPromo = (v: Detalle['existe_promo']): boolean =>
  v === true || v === 1 || v === '1' || v === 'true';

async function detalle(cod: string): Promise<Detalle | null> {
  for (const api of APIS) {
    try {
      const res = await traer(`${api}/articulo/detalle?cod_interno=${encodeURIComponent(cod)}`, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { estado?: number; datos?: unknown };
      // estado 2 es "no se encontraron valores": existe la ruta, no el articulo.
      if (body.estado === 1 && body.datos && !Array.isArray(body.datos)) {
        return body.datos as Detalle;
      }
    } catch {
      // Una API caida no tiene que voltear el repechaje: se prueba la otra.
    }
    await sleep(DELAY_MS);
  }
  return null;
}

async function main(): Promise<void> {
  const soloVer = (process.argv[2] ?? '') === 'ver';

  const [tienda] = await db.select({ id: stores.id }).from(stores).where(eq(stores.chain, CADENA));
  if (!tienda) throw new Error(`No existe la tienda ${CADENA}`);

  const corte = new Date(Date.now() - HORAS * 60 * 60 * 1000);
  const candidatos = await db
    .select({
      productId: currentPrices.productId,
      externalId: productSources.externalId,
      priceCents: currentPrices.priceCents,
      promoCents: currentPrices.promoCents,
    })
    .from(currentPrices)
    .innerJoin(productSources, and(
      eq(productSources.productId, currentPrices.productId),
      eq(productSources.chain, CADENA),
    ))
    .where(and(
      eq(currentPrices.storeId, tienda.id),
      lt(currentPrices.updatedAt, corte),
    ))
    .limit(MAX + 1);

  const hayMas = candidatos.length > MAX;
  const lista = candidatos.slice(0, MAX);
  console.log(`${lista.length} productos sin verse hace mas de ${HORAS}h${hayMas ? ` (hay mas de ${MAX}, se cortan aca)` : ''}\n`);
  if (lista.length === 0) return;

  let vivos = 0, perdidos = 0, actualizados = 0, promosNuevas = 0;

  for (const c of lista) {
    const d = await detalle(c.externalId);
    await sleep(DELAY_MS);
    if (!d) { perdidos++; continue; }
    vivos++;

    const pagas = aCentavos(d.precio);
    if (pagas === null) continue;
    const anterior = aCentavos(d.precio_anterior);
    // Igual que en el listado: la bandera sola no alcanza, el precio tiene que
    // bajar de verdad. Hay articulos marcados que valen lo mismo que siempre.
    const rebaja = hayPromo(d.existe_promo) && anterior !== null && anterior > pagas;
    const hasta = rebaja && d.vigencia_promo
      ? new Date(`${d.vigencia_promo}T23:59:59-03:00`)
      : null;

    if (rebaja && c.promoCents === null) promosNuevas++;
    if (soloVer) continue;

    await db.update(currentPrices)
      .set({
        priceCents: rebaja ? anterior : pagas,
        promoCents: rebaja ? pagas : null,
        promoLabel: d.descripcion_promo?.trim() || null,
        promoHasta: hasta,
        updatedAt: new Date(),
        revision: sql`nextval('global_revision_seq')`,
      })
      .where(and(
        eq(currentPrices.productId, c.productId),
        eq(currentPrices.storeId, tienda.id),
      ));
    actualizados++;
  }

  const modo = soloVer ? ' (modo ver: no se toco la base)' : '';
  console.log(`${vivos} siguen existiendo, ${perdidos} ya no responden`);
  console.log(`${actualizados} actualizados, ${promosNuevas} con una promo que no teniamos${modo}`);
}

try {
  await main();
} finally {
  await pool.end();
}
