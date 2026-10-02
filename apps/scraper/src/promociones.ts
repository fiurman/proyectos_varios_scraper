import '@precios/db/env';
import {
  pool, db, currentPrices, estadoScraper, productSources, stores,
} from '@precios/db';
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

/** Desde donde barrer.
 *
 *  Antes esto era `SEMILLA = 82844` y `MARGEN = 30`, o sea una ventana fija de
 *  36 ids escrita a mano. Se rompio solo: los ids de campaña avanzan con el
 *  tiempo y la ventana se queda donde estaba. Medido el 2026-10-02, las
 *  campañas vivas estaban entre 83090 y 83345 —216 ids mas alla del final de la
 *  ventana— y el barrido no encontraba nada.
 *
 *  Ahora la ventana arranca en el ultimo id vivo que guardamos y camina para
 *  adelante hasta encontrar un hueco largo. Se corre sola con las campañas. */

/** Solo para la primera corrida, cuando no hay nada guardado todavia. */
const SEMILLA_INICIAL = 82844;
const CLAVE_ESTADO = 'promo_ids_coope';

/** Cuanto mirar para atras del id vivo mas chico que conocemos. Las campañas
 *  pueden aparecer abajo de la ultima que vimos. */
const MARGEN_ATRAS = 60;

/** Cuantos ids seguidos sin nada hacen falta para dar por terminada la busqueda.
 *
 *  Medido el 2026-10-02: las campañas vivas estaban en 83090, 83166, 83256,
 *  83296, 83325, 83334 y 83345. El hueco mas grande entre dos vivas fue de 90
 *  ids, y desde la semilla vieja hasta la primera viva habia 246. Con 400 se
 *  recupera incluso de una ventana vieja de varias semanas sin partir al medio
 *  un grupo de campañas. */
const HUECO_PARA_CORTAR = 400;

/** Tope duro de ids por corrida. Sin esto, una API que empieza a devolver 0
 *  para todo haria un barrido infinito. */
const MAX_IDS_POR_CORRIDA = 1500;

/** Cuantas consultas de sondeo en paralelo.
 *
 *  Solo para el sondeo, que es una consulta por id que no trae articulos. El
 *  recorrido de cada campaña sigue siendo de a una con su pausa. Cuatro medido
 *  contra la API el 2026-10-02: 860 ids sin un solo error de red. */
const SONDEOS_EN_PARALELO = 4;

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

/** Los ids vivos de la ultima corrida, o la semilla si es la primera vez. */
async function idsConocidos(): Promise<number[]> {
  try {
    const [fila] = await db.select({ valor: estadoScraper.valor })
      .from(estadoScraper)
      .where(eq(estadoScraper.clave, CLAVE_ESTADO));
    const v = fila?.valor as { vivos?: unknown } | undefined;
    const vivos = Array.isArray(v?.vivos)
      ? v!.vivos.filter((x): x is number => typeof x === 'number' && Number.isInteger(x))
      : [];
    return vivos.length > 0 ? vivos : [SEMILLA_INICIAL];
  } catch {
    // Si la tabla todavia no existe (migracion sin aplicar), se arranca de la
    // semilla en vez de fallar. Es memoria, no un dato imprescindible.
    return [SEMILLA_INICIAL];
  }
}

async function guardarIdsVivos(vivos: number[]): Promise<void> {
  const valor = { vivos, visto: new Date().toISOString() };
  await db.insert(estadoScraper)
    .values({ clave: CLAVE_ESTADO, valor })
    .onConflictDoUpdate({
      target: estadoScraper.clave,
      set: { valor, actualizadoEn: new Date() },
    });
}

/** Sondea un id: devuelve cuantos articulos declara, o 0 si no existe. */
async function sondear(id: number): Promise<number> {
  try {
    const { total } = await pedir(id, 0, 1);
    return total;
  } catch {
    // Un id que no responde no es un error: la mayoria no existe.
    return 0;
  }
}

/** Busca las campañas vivas caminando para adelante.
 *
 *  Arranca un poco antes del id vivo mas chico que conocemos y avanza. Cada vez
 *  que encuentra una viva, extiende el horizonte: asi un grupo de campañas
 *  desparramado no se corta a la mitad. Se detiene cuando pasa `HUECO_PARA_CORTAR`
 *  ids sin encontrar nada, o al llegar al tope duro. */
async function buscarCampanas(): Promise<{ id: number; total: number }[]> {
  const conocidos = await idsConocidos();
  const desde = Math.min(...conocidos) - MARGEN_ATRAS;

  const vivas: { id: number; total: number }[] = [];
  let horizonte = Math.max(...conocidos) + HUECO_PARA_CORTAR;
  let probados = 0;
  let id = desde;

  while (id <= horizonte && probados < MAX_IDS_POR_CORRIDA) {
    // De a tandas en paralelo: son consultas que no traen articulos, y de a una
    // con la pausa de siempre un barrido de mil ids tarda trece minutos.
    const tanda: number[] = [];
    for (let i = 0; i < SONDEOS_EN_PARALELO && id <= horizonte && probados < MAX_IDS_POR_CORRIDA; i++) {
      tanda.push(id);
      id++;
      probados++;
    }

    const totales = await Promise.all(tanda.map(sondear));
    for (let i = 0; i < tanda.length; i++) {
      const total = totales[i]!;
      if (total > 0) {
        const vivo = tanda[i]!;
        vivas.push({ id: vivo, total });
        // Encontramos una: vale la pena mirar mas alla.
        horizonte = Math.max(horizonte, vivo + HUECO_PARA_CORTAR);
      }
    }
    await sleep(DELAY_MS);
  }

  const hasta = Math.min(id - 1, horizonte);
  console.log(`Sondeados ${probados} ids (${desde} a ${hasta}).`);
  if (probados >= MAX_IDS_POR_CORRIDA) {
    console.warn(`  ! se corto por el tope de ${MAX_IDS_POR_CORRIDA} ids.`);
  }
  return vivas.sort((a, b) => b.total - a.total);
}

async function main(): Promise<void> {
  const soloVer = (process.argv[2] ?? '') === 'ver';

  const [tienda] = await db.select({ id: stores.id }).from(stores).where(eq(stores.chain, CADENA));
  if (!tienda) throw new Error(`No existe la tienda ${CADENA}`);

  const vivas = await buscarCampanas();

  if (vivas.length === 0) {
    // Esto NO es un error. Que no haya ninguna campaña es un estado legitimo:
    // las campañas se terminan y puede no haber ninguna hoy. Antes esto hacia
    // `process.exitCode = 1`, y como el refresco trataba la falla como fatal, se
    // perdia la noche entera de scrapeo por no haber promociones que etiquetar.
    console.warn(
      'Ninguna campaña viva en el rango barrido. No es un error: puede no haber' +
      ' ninguna hoy. Si se repite varios dias, correr `npm run promociones -- ver`' +
      ' para ver el rango que se probo.',
    );
    return;
  }
  console.log(`${vivas.length} campañas vivas: ${vivas.map((v) => `${v.id} (${v.total})`).join(', ')}\n`);

  if (!soloVer) await guardarIdsVivos(vivas.map((v) => v.id));

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
