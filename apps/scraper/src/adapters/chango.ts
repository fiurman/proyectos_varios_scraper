import type { ChainAdapter, SourceProduct } from './types.js';
import {
  UA, toSourceProduct,
  type VtexCategoria, type VtexProducto,
} from './vtex.js';
import { anotarReintento } from '../reintentos.js';
import { traer } from '../traer.js';

/** Chango Mas (masonline.com.ar), con precios de Bahia Blanca.
 *
 *  Es VTEX como Disco y Carrefour, pero no usa la misma API. La vieja
 *  —catalog_system— devuelve un precio generico que resulta ser el de Buenos
 *  Aires: verificado contra el CP 1425, da identico. Los precios reales de acá
 *  salen de Intelligent Search pasandole un `regionId`, y en Chango Mas ese
 *  regionId corresponde a sucursales de Bahia de verdad, sobre Sarmiento —a
 *  diferencia de Carrefour, donde el mismo codigo postal devuelve locales de
 *  Merlo y Mar del Plata que solo envian hasta acá.
 *
 *  Lo que se pierde en el cambio: Intelligent Search no acepta filtrar por
 *  rango de precio, asi que no se pueden partir las categorias gigantes. No
 *  deberia doler —el arbol tiene 2.640 hojas para 62.000 productos, unos 23 por
 *  hoja— pero las que se pasen del tope se avisan en el log en vez de quedar
 *  truncadas en silencio. */

const HOST = 'www.masonline.com.ar';
const CP_BAHIA = '8000';
const PAGE_SIZE = 50;
/** Intelligent Search corta en el producto 2550, igual que la API vieja. */
const TOPE = 2550;
const DELAY_MS = 700;
const REINTENTOS = 5;
const ESPERA_BASE_MS = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Rubros que no van al changuito.
 *
 *  Medido sobre el catalogo entero: sacando esto quedan ~36.500 productos de
 *  los 62.000. Bazar y Cocina (6.113) y Libreria y Arte (5.062) se van aunque
 *  suenen a hogar: son ollas y cuadernos, no las toallas y sabanas que si
 *  interesan para comparar con Coope Hogar. */
const FUERA = [
  'Pequeños electrodomésticos', 'Informática', 'Climatización', 'Audio',
  'TV y Video', 'Celulares y Telefonía',
  'Jugueteria', 'Deportes', 'Patio y Jardín',
  'Herramientas, Pinturería y Refacciones', 'Neumáticos', 'Navidad',
  'Bazar y Cocina', 'Librería y Arte',
];

async function pedir<T>(url: string): Promise<T> {
  let ultimo: unknown;
  for (let intento = 1; intento <= REINTENTOS; intento++) {
    try {
      const res = await traer(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (err) {
      ultimo = err;
      if (intento < REINTENTOS) {
        const espera = ESPERA_BASE_MS * 2 ** intento;
        anotarReintento(espera);
        await sleep(espera);
      }
    }
  }
  throw ultimo;
}

interface Region { id: string; sellers: { id: string }[] }

/** Intelligent Search no manda `IsAvailable`, que es el campo con el que el
 *  mapeo compartido decide si un producto se vende. Trae `AvailableQuantity`,
 *  pero viene en cero hasta para los que estan a la venta: comprobado contra la
 *  API vieja, los 43 productos en comun tenian `IsAvailable: true` y cantidad
 *  cero. La señal que si sirve es tener precio — de hecho, pidiendo con
 *  `regionId` la API ya devuelve solo lo vendible en esa region.
 *
 *  Sin esto el adapter descarta el catalogo entero en silencio. */
function marcarDisponibles(p: VtexProducto): void {
  for (const it of p.items ?? []) {
    for (const s of it.sellers ?? []) {
      const o = s.commertialOffer as { Price: number | null; IsAvailable: boolean } | undefined;
      if (o) o.IsAvailable = (o.Price ?? 0) > 0;
    }
  }
}
interface Busqueda { products: VtexProducto[]; recordsFiltered?: number }

/** El slug de la categoria sale de su URL publica; Intelligent Search filtra
 *  por nombre y no por id, asi que sin esto no hay forma de pedirla. */
function slug(c: VtexCategoria): string | null {
  const u = c.url ?? '';
  const partes = u.replace(/^https?:\/\/[^/]+\//, '').split('/').filter(Boolean);
  return partes.at(-1) ?? null;
}

interface Hoja { facetas: string; nombre: string }

/** Las hojas del arbol como rutas "category-1/almacen/category-2/aceites". */
function* hojas(
  nodos: VtexCategoria[],
  fuera: Set<string>,
  prefijo: string[] = [],
): Generator<Hoja> {
  for (const n of nodos) {
    if (prefijo.length === 0 && fuera.has(n.name)) continue;
    const s = slug(n);
    if (!s) continue;
    const camino = [...prefijo, s];
    const hijos = n.children ?? [];
    if (hijos.length === 0) {
      yield {
        facetas: camino.map((p, i) => `category-${i + 1}/${p}`).join('/'),
        nombre: n.name,
      };
    } else {
      yield* hojas(hijos, fuera, camino);
    }
  }
}

export class ChangoMasAdapter implements ChainAdapter {
  readonly chain = 'chango_mas';
  readonly displayName = 'Chango Mas';

  private readonly fuera: Set<string>;

  constructor(fuera: string[] = FUERA) {
    this.fuera = new Set(fuera);
  }

  async *fetchProducts({ limit }: { limit: number }): AsyncGenerator<SourceProduct> {
    const regiones = await pedir<Region[]>(
      `https://${HOST}/api/checkout/pub/regions?country=ARG&postalCode=${CP_BAHIA}`,
    );
    const region = regiones[0]?.id;
    if (!region) throw new Error(`No hay region para el CP ${CP_BAHIA}`);
    console.log(`  Precios de Bahia Blanca (${regiones[0]!.sellers.length} sucursales).`);
    await sleep(DELAY_MS);

    const arbol = await pedir<VtexCategoria[]>(
      `https://${HOST}/api/catalog_system/pub/category/tree/5`,
    );
    await sleep(DELAY_MS);

    // Se sondea cada raiz antes de entrar: el arbol arrastra categorias muertas
    // —"(Old)", "Categoria Mercadolibre", las de marketing como "Sin Tacc"— que
    // no tienen un solo producto pero si decenas de hojas cada una. Sin esto el
    // recorrido gasta un pedido y su espera por cada hoja vacia. Sondear las
    // 117 raices cuesta mucho menos que recorrer las hojas de las muertas.
    const vivas: VtexCategoria[] = [];
    for (const raiz of arbol) {
      if (this.fuera.has(raiz.name)) continue;
      const s = slug(raiz);
      if (!s) continue;
      try {
        const res = await pedir<Busqueda>(
          `https://${HOST}/api/io/_v/api/intelligent-search/product_search/` +
            `category-1/${s}?count=1&page=1&regionId=${region}`,
        );
        await sleep(DELAY_MS);
        if ((res.recordsFiltered ?? 0) > 0) vivas.push(raiz);
      } catch {
        // Una raiz que no responde al sondeo se intenta igual: puede ser un
        // hipo suelto, y perderla entera seria peor que gastar los pedidos.
        vivas.push(raiz);
      }
    }
    console.log(`  ${vivas.length} de ${arbol.length} categorias raiz tienen productos.`);

    const vistos = new Set<string>();
    const salteadas: string[] = [];
    const truncadas: string[] = [];
    let emitidos = 0;
    // Contadores del recorrido: sin esto, una corrida que trae menos de lo
    // esperado no dice por donde se perdio.
    let hojasVistas = 0;
    let hojasVacias = 0;
    let paginas = 0;
    let descartados = 0;

    for (const hoja of hojas(vivas, this.fuera)) {
      if (emitidos >= limit) return;
      hojasVistas++;
      let deLaHoja = 0;

      // Cada categoria en su propio try: perder una gondola es molesto, perder
      // el resto del catalogo por esa gondola es absurdo.
      try {
        for (let pagina = 1; ; pagina++) {
          const desde = (pagina - 1) * PAGE_SIZE;
          if (desde >= TOPE) {
            truncadas.push(hoja.nombre);
            break;
          }

          const url =
            `https://${HOST}/api/io/_v/api/intelligent-search/product_search/` +
            `${hoja.facetas}?count=${PAGE_SIZE}&page=${pagina}&regionId=${region}`;
          const res = await pedir<Busqueda>(url);
          await sleep(DELAY_MS);
          paginas++;

          const lote = res.products ?? [];
          if (lote.length === 0) break;

          for (const p of lote) {
            marcarDisponibles(p);
            for (const it of p.items ?? []) {
              if (emitidos >= limit) return;
              if (vistos.has(it.itemId)) continue;
              vistos.add(it.itemId);
              const producto = toSourceProduct(p, it, HOST);
              if (producto === null) { descartados++; continue; }
              yield producto;
              emitidos++;
              deLaHoja++;
            }
          }

          if (lote.length < PAGE_SIZE) break;
        }
        if (deLaHoja === 0) hojasVacias++;
      } catch (err) {
        salteadas.push(hoja.nombre);
        console.warn(`  ! "${hoja.nombre}" quedo afuera: ${String(err).slice(0, 110)}`);
      }
    }

    console.log(
      `  ${hojasVistas} hojas (${hojasVacias} sin productos), ${paginas} paginas pedidas` +
        `, ${descartados} articulos descartados.`,
    );

    if (truncadas.length > 0) {
      console.warn(
        `  ! ${truncadas.length} categorias cortadas en ${TOPE}: ${truncadas.slice(0, 5).join(', ')}` +
          `${truncadas.length > 5 ? ', ...' : ''}`,
      );
    }
    if (salteadas.length > 0) {
      console.warn(`  ! ${salteadas.length} categorias sin bajar: ${salteadas.slice(0, 6).join(', ')}`);
    }
  }
}
