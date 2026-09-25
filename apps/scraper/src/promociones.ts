import '@precios/db/env';
import { pool, db, currentPrices, productSources, stores } from '@precios/db';
import { and, eq, sql } from 'drizzle-orm';
import { traer } from './traer.js';

/** Campañas de La Coope: el "Ahorron" y las tandas que publican con el.
 *
 *  Existe aparte del scrapeo porque los productos de campaña ya los bajamos por
 *  su categoria, pero con el precio ya rebajado y sin ninguna marca: el filet de
 *  merluza figura a $9.862,50 y parece precio normal, cuando en realidad es
 *  $13.150 menos el 25% que anuncia la campaña.
 *
 *  Eso importa por dos motivos. Uno, que se pueda ver "antes $13.150" en vez de
 *  un precio pelado. Y dos, que el descuento de empleado no acumula con
 *  promociones, asi que sin la marca se lo estariamos sumando encima.
 *
 *  Las campañas se piden por un id que rota. No hay indice: se barren los ids
 *  alrededor de los que ya conocemos, que en la practica viven en un rango
 *  corto y consecutivo —82844, 82845 y 82846 estaban vivos al escribir esto—.
 *
 *   npm run promociones            las busca y actualiza precios
 *   npm run promociones -- ver     las muestra sin tocar la base */

const API = 'https://api.lacoopeencasa.coop/api';
const UA = 'precios-varios/0.1 (proyecto personal de comparacion de precios)';
const CADENA = 'cooperativa_obrera';
const DELAY_MS = 800;
const PAGE_SIZE = 200;

/** Desde donde barrer y cuanto mirar mas alla del ultimo id vivo.
 *
 *  Se barre una ventana en vez de guardar solo el mayor e ir sumando: si un dia
 *  no corremos, o si los ids saltan para atras, un puntero que solo avanza deja
 *  de ver las campañas nuevas y no se entera nunca. */
const SEMILLA = 82844;
const MARGEN = 30;

/** Criterios de orden del listado.
 *
 *  La paginacion de la campaña muere antes de tiempo —82844 declara 722
 *  articulos y corta en 370— pero cada orden devuelve una ventana distinta de
 *  los mismos articulos. Es la misma rareza que ya tiene su listado por
 *  categoria, y se resuelve igual: barriendo los ordenes y uniendo. */
const ORDENES = [1, 0, 2, 3, 4, 5];
const MAX_PAGINAS = 40;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ArtPromo {
  cod_interno: string | number;
  descripcion: string;
  precio: string | number | null;
  precio_anterior: string | number | null;
  precio_promo: string | number | null;
  descripcion_promo: string | null;
  descuento_porcentaje_promo: string | number | null;
  vigencia_promo: string | null;
  id_promocion: number | null;
  existe_promo: number | null;
}

async function pedir(
  idPromo: number, pagina: number, cant: number, orden = 1,
): Promise<{ articulos: ArtPromo[]; total: number }> {
  const body = {
    id_relacion: String(idPromo), tipo_relacion: '3', descripcion: 'ahorron', pagina, orden,
    filtros: {
      preciomenor: -1, preciomayor: -1, categoria: [], marca: [],
      tipo_seleccion: 'filtro', tipo_relacion: '3', filtros_gramaje: [],
      filtros_descuento: [], termino: '', cant_articulos: cant,
      ofertas: false, modificado: true, primer_filtro: '',
    },
  };
  const res = await traer(`${API}/articulos/pagina_filtros`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { datos?: { articulos?: ArtPromo[]; cantidad_articulos?: number } };
  return {
    articulos: json.datos?.articulos ?? [],
    total: json.datos?.cantidad_articulos ?? 0,
  };
}

const aCentavos = (v: string | number | null): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};

async function main(): Promise<void> {
  const soloVer = (process.argv[2] ?? '') === 'ver';

  const [tienda] = await db.select({ id: stores.id }).from(stores).where(eq(stores.chain, CADENA));
  if (!tienda) throw new Error(`No existe la tienda ${CADENA}`);

  // Barrido: se prueba cada id con una sola consulta que solo cuenta.
  const vivas: { id: number; total: number }[] = [];
  for (let id = SEMILLA - 5; id <= SEMILLA + MARGEN; id++) {
    try {
      const { total } = await pedir(id, 0, 1);
      if (total > 0) vivas.push({ id, total });
    } catch {
      // Un id que no responde no es un error: la mayoria no existe.
    }
    await sleep(DELAY_MS);
  }

  if (vivas.length === 0) {
    console.error('No encontre ninguna campaña viva. ¿Cambio el rango de ids?');
    process.exitCode = 1;
    return;
  }
  console.log(`${vivas.length} campañas vivas: ${vivas.map((v) => `${v.id} (${v.total})`).join(', ')}\n`);

  let vistos = 0;
  let actualizados = 0;
  const sinCasar: string[] = [];

  const yaVistos = new Set<string>();

  for (const campana of vivas) {
    for (const orden of ORDENES) {
      // Se avanza por lo que devuelve, no por lo que se pide: `cant_articulos`
      // no se respeta —la API corta en 32— y calcular las paginas con el numero
      // pedido saltea el resto.
      let pagina = 0;
      let vacias = 0;
      while (pagina < MAX_PAGINAS && yaVistos.size < campana.total + 1000) {
      const { articulos } = await pedir(campana.id, pagina, PAGE_SIZE, orden);
      await sleep(DELAY_MS);
      pagina++;
      if (articulos.length === 0) { vacias++; break; }
      if (vacias > 0) break;

      for (const a of articulos) {
        const clave = `${campana.id}:${a.cod_interno}`;
        if (yaVistos.has(clave)) continue;
        yaVistos.add(clave);
        vistos++;
        const etiqueta = a.descripcion_promo?.trim() || null;
        const pagas = aCentavos(a.precio);
        const lista = aCentavos(a.precio_anterior);
        if (pagas === null) continue;

        // Sin precio anterior no hay rebaja que mostrar: puede ser un combo,
        // donde el beneficio no esta en el precio unitario.
        const hayRebaja = lista !== null && lista > pagas;
        const hasta = a.vigencia_promo ? new Date(`${a.vigencia_promo}T23:59:59-03:00`) : null;

        if (soloVer) continue;

        const [fuente] = await db.select({ productId: productSources.productId })
          .from(productSources)
          .where(and(
            eq(productSources.chain, CADENA),
            eq(productSources.externalId, String(a.cod_interno)),
          ));
        if (!fuente) {
          if (sinCasar.length < 8) sinCasar.push(a.descripcion.slice(0, 40));
          continue;
        }

        const r = await db.update(currentPrices)
          .set({
            priceCents: hayRebaja ? lista : pagas,
            promoCents: hayRebaja ? pagas : null,
            promoLabel: etiqueta,
            promoHasta: hasta,
            updatedAt: new Date(),
            revision: sql`nextval('global_revision_seq')`,
          })
          .where(and(
            eq(currentPrices.productId, fuente.productId),
            eq(currentPrices.storeId, tienda.id),
          ))
          .returning({ id: currentPrices.productId });
        if (r.length > 0) actualizados++;
      }
      }
    }
  }

  if (soloVer) {
    console.log(`${vistos} articulos en campaña (modo ver: no se toco la base)`);
    return;
  }
  console.log(`${vistos} articulos en campaña, ${actualizados} actualizados.`);
  if (sinCasar.length > 0) {
    console.warn(`  ! algunos no estan en nuestro catalogo: ${sinCasar.join(', ')}`);
  }
}

try {
  await main();
} finally {
  await pool.end();
}
