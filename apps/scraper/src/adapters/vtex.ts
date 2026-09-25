import type { ChainAdapter, SourceProduct } from './types.js';
import {
  isValidEan13, normalizeUnit, parseContentFromName, parsePriceToCents,
} from '../normalize.js';
import { anotarReintento } from '../reintentos.js';
import { traer } from '../traer.js';

export const UA = 'precios-varios/0.1 (proyecto personal de comparacion de precios)';

const DELAY_MS = 700;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** VTEX no entrega mas de 50 articulos por pedido y rechaza _from > 2500:
 *  quedan 2550 alcanzables por consulta, haga lo que haga la paginacion. */
const PAGE_SIZE = 50;
const MAX_OFFSET = 2500;
const ALCANCE = MAX_OFFSET + PAGE_SIZE;

/** Techo del rango de precios que usamos para partir categorias grandes.
 *  Nada en el catalogo se acerca, es solo el extremo abierto del intervalo. */
const PRECIO_TECHO = 10_000_000;

/** Piso de precio: pedimos solo lo que tiene precio.
 *
 *  Las cadenas publican miles de articulos sin precio —descatalogados, sin
 *  stock, mal cargados— que ya descartabamos al guardar, pero recien despues de
 *  bajarlos uno por uno. Medido en Disco: "Bowls, Ensaladeras y Fuentes" pasa
 *  de 4.498 articulos a 190 filtrando por precio. El 96% era viaje perdido.
 *
 *  Ademas arregla la particion: como esos articulos valen $0, el rango no se
 *  podia cortar por abajo y la categoria terminaba truncada en los 2.550 que
 *  deja ver VTEX, o sea que pagabamos el maximo y la traiamos incompleta. */
const PRECIO_PISO = 1;

/** El filtro `fq=P:[min TO max]`, ya escapado para la URL. */
const rangoPrecio = (min: number, max: number) =>
  `fq=P:%5B${min}%20TO%20${max}%5D`;

/** Cuantas veces reintentar un pedido que fallo, y cuanto esperar entre una y
 *  otra: 2, 4, 8, 16 y 32 segundos, casi un minuto en total.
 *
 *  Antes eran 3 intentos con esperas de 1,4 y 2,8 segundos. Se rendia a los
 *  cuatro segundos, y eso alcanza para un parpadeo pero no para un hipo de
 *  verdad: una corrida murio con un HTTP 500 que a los pocos segundos ya no
 *  estaba, despues de 11.671 productos. Tras miles de pedidos seguidos, hay que
 *  darle tiempo al otro lado a recuperarse. */
const REINTENTOS = 5;
const ESPERA_BASE_MS = 1000;

export interface VtexCategoria {
  id: number;
  name: string;
  children: VtexCategoria[] | null;
  /** La URL publica de la categoria. De ahi sale el slug que pide Intelligent
   *  Search, que filtra por nombre en la ruta y no por id. */
  url?: string | null;
}

interface VtexOferta {
  Price: number | null;
  PriceWithoutDiscount: number | null;
  IsAvailable: boolean;
}

export interface VtexItem {
  itemId: string;
  nameComplete?: string | null;
  name?: string | null;
  ean?: string | null;
  measurementUnit?: string | null;
  unitMultiplier?: number | null;
  images?: { imageUrl: string }[] | null;
  sellers?: { commertialOffer: VtexOferta }[] | null;
}

export interface VtexProducto {
  productId: string;
  productName: string;
  brand?: string | null;
  link?: string | null;
  linkText?: string | null;
  categories?: string[] | null;
  items?: VtexItem[] | null;
}

/** VTEX devuelve un 500 cada tanto sin motivo: el mismo pedido repetido anda.
 *  Sin reintento, un hipo suelto se lleva puesto el catalogo entero. */
async function apiGet<T>(api: string, path: string): Promise<T> {
  let ultimo: unknown;

  for (let intento = 1; intento <= REINTENTOS; intento++) {
    try {
      const res = await traer(`${api}/${path}`, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`${path} respondio HTTP ${res.status}`);
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

interface Pagina {
  items: VtexProducto[];
  /** Total de la consulta, que VTEX manda en el header `resources: 0-49/2969`. */
  total: number;
}

async function pedirPagina(api: string, query: string, desde: number): Promise<Pagina> {
  const path = `products/search?${query}&_from=${desde}&_to=${desde + PAGE_SIZE - 1}`;
  let ultimo: unknown;

  for (let intento = 1; intento <= REINTENTOS; intento++) {
    try {
      const res = await traer(`${api}/${path}`, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`${path} respondio HTTP ${res.status}`);
      const items = (await res.json()) as VtexProducto[];
      const total = Number(res.headers.get('resources')?.split('/')[1] ?? items.length);
      return { items, total: Number.isFinite(total) ? total : items.length };
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

/** Una tienda VTEX. La plataforma es la misma para todas las cadenas: cambia
 *  el host y nada mas. Disco, Jumbo, Carrefour y Dia corren sobre esto. */
export interface VtexConfig {
  chain: string;
  displayName: string;
  /** Dominio, sin protocolo ni barra final. */
  host: string;
  /** Ids de las categorias raiz a recorrer. Sin esto se baja el arbol entero,
   *  que en algunas cadenas incluye electro, indumentaria y jugueteria: rubros
   *  que no van al changuito y multiplican por diez la corrida. */
  raices?: number[];
  /** Ramas a saltear, a cualquier profundidad. Para cuando una raiz que si
   *  interesa trae adentro rubros que no. */
  excluir?: number[];
}

/** Las hojas del arbol, con el camino de ids que espera el filtro fq=C:/a/b/c/
 *
 *  `excluidas` corta ramas enteras a cualquier profundidad. Hace falta porque
 *  las raices son demasiado gruesas para decidir: "Hogar y textil" de Disco
 *  mezcla repasadores y sabanas —que si son changuito— con ropa interior,
 *  calzado y guardapolvos, que no. */
function* hojas(
  nodes: VtexCategoria[],
  excluidas: Set<number> | null = null,
  prefijo: number[] = [],
): Generator<{ ids: number[]; nombre: string }> {
  for (const n of nodes) {
    if (excluidas?.has(n.id)) continue;
    const ids = [...prefijo, n.id];
    const hijos = n.children ?? [];
    if (hijos.length === 0) yield { ids, nombre: n.name };
    else yield* hojas(hijos, excluidas, ids);
  }
}

/** De ["/Almacen/Desayuno/Azucar/", "/Almacen/Desayuno/", "/Almacen/"] al
 *  camino mas profundo, que es el que describe mejor al producto. */
function categoryPath(categorias: string[] | null | undefined): string[] {
  const caminos = (categorias ?? []).map((c) => c.split('/').filter(Boolean));
  caminos.sort((a, b) => b.length - a.length);
  return caminos[0] ?? [];
}

export function toSourceProduct(p: VtexProducto, it: VtexItem, host: string): SourceProduct | null {
  const oferta = it.sellers?.[0]?.commertialOffer;
  if (!oferta?.IsAvailable) return null; // sin stock no hay precio que registrar

  // En VTEX `Price` es lo que se paga hoy. Cuando hay descuento lo guardamos
  // como promo y dejamos el de lista en priceCents, igual que en La Coope.
  const pagado = parsePriceToCents(oferta.Price);
  if (pagado === null) return null;
  const lista = parsePriceToCents(oferta.PriceWithoutDiscount);
  const hayDescuento = lista !== null && lista > pagado;

  const nombre = it.nameComplete || it.name || p.productName;

  // Los productos por peso traen la medida en el item; el resto hay que
  // sacarla del nombre, porque VTEX no la publica en un campo propio.
  const unidadMedida = normalizeUnit(it.measurementUnit);
  const porPeso = (it.measurementUnit ?? 'un') !== 'un';
  const contenido =
    parseContentFromName(nombre) ??
    (porPeso && unidadMedida && it.unitMultiplier
      ? { value: it.unitMultiplier, unit: unidadMedida }
      : null);

  return {
    externalId: it.itemId,
    ean13: it.ean && isValidEan13(it.ean) ? it.ean : null,
    name: nombre,
    brand: p.brand ?? null,
    contentValue: contenido?.value ?? null,
    contentUnit: contenido?.unit ?? null,
    isWeighted: porPeso,
    priceCents: hayDescuento ? lista : pagado,
    promoCents: hayDescuento ? pagado : null,
    promoLabel: null,
    promoDesde: null,
    promoHasta: null,
    categoryPath: categoryPath(p.categories),
    imageUrl: it.images?.[0]?.imageUrl ?? null,
    url: p.link ?? (p.linkText ? `https://${host}/${p.linkText}/p` : null),
    raw: { producto: p.productId, item: it },
  };
}

interface Recorrido {
  vistos: Set<string>;
  emitidos: number;
  limit: number;
}

export class VtexAdapter implements ChainAdapter {
  readonly chain: string;
  readonly displayName: string;
  private readonly host: string;
  private readonly api: string;
  private readonly raices: Set<number> | null;
  private readonly excluidas: Set<number> | null;

  constructor(cfg: VtexConfig) {
    this.chain = cfg.chain;
    this.displayName = cfg.displayName;
    this.host = cfg.host;
    this.api = `https://${cfg.host}/api/catalog_system/pub`;
    this.raices = cfg.raices ? new Set(cfg.raices) : null;
    this.excluidas = cfg.excluir ? new Set(cfg.excluir) : null;
  }

  async *fetchProducts({ limit }: { limit: number }): AsyncGenerator<SourceProduct> {
    const todas = await apiGet<VtexCategoria[]>(this.api, 'category/tree/5');
    await sleep(DELAY_MS);

    const arbol = this.raices ? todas.filter((c) => this.raices!.has(c.id)) : todas;
    if (this.raices && arbol.length !== this.raices.size) {
      console.warn(
        `  ! El arbol trajo ${arbol.length} de las ${this.raices.size} raices configuradas.`,
      );
    }

    const ctx: Recorrido = { vistos: new Set<string>(), emitidos: 0, limit };
    const salteadas: string[] = [];

    for (const hoja of hojas(arbol, this.excluidas)) {
      if (ctx.emitidos >= ctx.limit) return;

      // Cada categoria en su propio try. Si una no responde ni con los cinco
      // reintentos, se anota y se sigue con la siguiente: perder una gondola
      // es molesto, perder el resto del catalogo por esa gondola es absurdo.
      // Fue lo que paso: un HTTP 500 en Mundo Bebe corto Carrefour a los
      // 11.671 productos con el catalogo casi terminado.
      try {
        // La categoria sola sirve de base para partir por precio; para pedir
        // productos va siempre con el piso, asi no viajan los que no tienen
        // precio.
        const categoria = `fq=C:/${hoja.ids.join('/')}/`;
        const query = `${categoria}&${rangoPrecio(PRECIO_PISO, PRECIO_TECHO)}`;
        const primera = await pedirPagina(this.api, query, 0);
        await sleep(DELAY_MS);

        // Casi todas las hojas entran enteras; solo las gigantes (galletitas
        // dulces, vinos tintos) hay que partirlas para pasar el tope de VTEX.
        if (primera.total > ALCANCE) {
          yield* this.recorrerPorPrecio(hoja, categoria, PRECIO_PISO, PRECIO_TECHO, ctx);
        } else {
          yield* this.paginar(query, primera, ctx);
        }
      } catch (err) {
        salteadas.push(hoja.nombre);
        console.warn(`  ! "${hoja.nombre}" quedo afuera: ${String(err).slice(0, 110)}`);
      }
    }

    if (salteadas.length > 0) {
      console.warn(
        `  ! ${salteadas.length} categorias sin bajar: ${salteadas.slice(0, 6).join(', ')}` +
          `${salteadas.length > 6 ? ', ...' : ''}`,
      );
    }
  }

  /** Parte el rango de precios al medio hasta que cada pedazo entre en el tope.
   *  Los extremos se pisan (P:[0 TO 1000] y P:[1000 TO 2000] comparten el 1000),
   *  pero el set de vistos ya deduplica por SKU. */
  private async *recorrerPorPrecio(
    hoja: { ids: number[]; nombre: string },
    base: string,
    min: number,
    max: number,
    ctx: Recorrido,
  ): AsyncGenerator<SourceProduct> {
    if (ctx.emitidos >= ctx.limit) return;

    const query = `${base}&${rangoPrecio(min, max)}`;
    const primera = await pedirPagina(this.api, query, 0);
    await sleep(DELAY_MS);

    if (primera.total > ALCANCE) {
      const medio = Math.floor((min + max) / 2);
      if (medio > min) {
        yield* this.recorrerPorPrecio(hoja, base, min, medio, ctx);
        yield* this.recorrerPorPrecio(hoja, base, medio, max, ctx);
        return;
      }
      // Mas de 2550 articulos al mismo precio exacto: no hay por donde partir.
      console.warn(
        `  ! "${hoja.nombre}" tiene ${primera.total} articulos a $${min}: entran ${ALCANCE}.`,
      );
    }

    yield* this.paginar(query, primera, ctx);
  }

  private async *paginar(
    query: string,
    primera: Pagina,
    ctx: Recorrido,
  ): AsyncGenerator<SourceProduct> {
    let desde = 0;
    let lote = primera.items;

    while (lote.length > 0) {
      for (const p of lote) {
        // Un producto puede tener varios SKU (500ml y 1L): cada uno es una
        // fila distinta, con su propio codigo de barras y su propio precio.
        for (const it of p.items ?? []) {
          if (ctx.emitidos >= ctx.limit) return;
          if (ctx.vistos.has(it.itemId)) continue; // aparece en varias categorias
          ctx.vistos.add(it.itemId);

          const producto = toSourceProduct(p, it, this.host);
          if (producto === null) continue;

          yield producto;
          ctx.emitidos++;
        }
      }

      if (lote.length < PAGE_SIZE) return;
      desde += PAGE_SIZE;
      if (desde > MAX_OFFSET) return;

      lote = (await pedirPagina(this.api, query, desde)).items;
      await sleep(DELAY_MS);
    }
  }
}
