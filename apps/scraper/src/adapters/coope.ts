import type { ChainAdapter, SourceProduct } from './types.js';
import { normalizeUnit, parsePriceToCents, toCoopeUrlSlug } from '../normalize.js';
import { anotarReintento } from '../reintentos.js';
import { traer } from '../traer.js';

const UA = 'precios-varios/0.1 (proyecto personal de comparacion de precios)';

/** Pausa entre pedidos. Somos invitados en su servidor: de a uno y sin apuro. */
const DELAY_MS = 700;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** articulos/pagina devuelve 32 articulos cuando `modificado` es true (la carga
 *  inicial del listado) y 8 cuando es false (el scroll infinito). Siempre 32:
 *  mismo catalogo con la cuarta parte de los pedidos. */
const PAGE_SIZE = 32;

/** Tope de seguridad: ninguna hoja del arbol se acerca siquiera a esto, pero
 *  si el backend deja de devolver la pagina vacia no queremos girar de gratis. */
const MAX_PAGINAS = 40;

/** Criterios de orden del listado. En varias hojas la paginacion muere despues
 *  de la primera pagina, pero cada orden devuelve una ventana distinta de los
 *  mismos articulos: barriendo los seis se recupera la categoria completa.
 *  El 1 va primero porque es el que usa el sitio. */
const ORDENES = [1, 0, 2, 3, 4, 5];

/** Una tienda de la Cooperativa Obrera. Son dos sitios distintos —el super y
 *  la tienda de hogar— pero corren el mismo backend, con los mismos endpoints
 *  y las mismas rarezas: cambia el dominio y nada mas. */
export interface CoopeConfig {
  chain: string;
  displayName: string;
  /** Base de la API, sin barra final. */
  api: string;
  /** Dominio del sitio, para armar las URLs de producto. */
  web: string;
}

interface ApiEnvelope<T> {
  estado: number;
  mensaje: string;
  datos: T;
}

interface ApiArticulo {
  cod_interno: string;
  descripcion: string;
  precio: string;
  precio_promo: string | null;
  /** Precio de lista cuando hay una promo que ya viene aplicada en `precio`. */
  precio_anterior?: string | null;
  /** '1' cuando el articulo esta en alguna promocion, del tipo que sea. */
  existe_promo?: string | number | null;
  /** Cuantas unidades hay que llevar para el precio promocional. */
  cantidad_promo?: string | number | null;
  /** Ultimo dia de la promo, 'AAAA-MM-DD'. */
  vigencia_promo?: string | null;
  descripcion_promo?: string | null;
  gramaje: string | null;
  unimed_desc: string | null;
  marca_desc: string | null;
  id_categoria: string | null;
  imagen: string | null;
  tipo_articulo: string;
}

interface ApiCategoria {
  id_categoria: number;
  descripcion: string;
  hijos: ApiCategoria[];
}

interface ApiMarca {
  id_marca: string;
  marca_desc: string;
  /** Cuantos articulos de la categoria son de esta marca. */
  cantidad: string;
}

interface ApiPagina {
  cantidad_articulos: number;
  articulos: ApiArticulo[] | null;
  /** Las marcas presentes en la categoria, con su conteo. Vienen en la misma
   *  respuesta que los articulos y son la llave para sacarlos a todos. */
  marcas?: ApiMarca[] | null;
}

/** Una marca como la espera el filtro: objeto, no id suelto. Con el id pelado
 *  la API responde sin articulos y sin error, que fue lo que despisto. */
interface FiltroMarca {
  descripcion: string;
  id: string;
  valido: true;
}

/** Cuantas veces reintentar y cuanto esperar: 2, 4, 8, 16 y 32 segundos.
 *
 *  Este adapter no tenia reintentos. Zafo hasta ahora, pero una corrida de
 *  Carrefour murio por un HTTP 500 pasajero y aca el riesgo es el mismo: son
 *  cientos de pedidos seguidos contra un servidor que no controlamos. */
const REINTENTOS = 5;
const ESPERA_BASE_MS = 1000;

/** Repite el pedido ante un fallo pasajero, esperando cada vez mas. */
async function conReintentos<T>(que: string, hacer: () => Promise<T>): Promise<T> {
  let ultimo: unknown;

  for (let intento = 1; intento <= REINTENTOS; intento++) {
    try {
      return await hacer();
    } catch (err) {
      ultimo = err;
      if (intento < REINTENTOS) {
        const espera = ESPERA_BASE_MS * 2 ** intento;
        anotarReintento(espera);
        await sleep(espera);
      }
    }
  }
  throw new Error(`${que}: ${String(ultimo)}`);
}

async function apiGet<T>(api: string, path: string): Promise<T> {
  return conReintentos(path, async () => {
    const res = await traer(`${api}/${path}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`respondio HTTP ${res.status}`);
    const body = (await res.json()) as ApiEnvelope<T>;
    if (body.estado !== 1) throw new Error(body.mensaje);
    return body.datos;
  });
}

async function apiPost<T>(api: string, path: string, body: unknown): Promise<T> {
  return conReintentos(path, async () => {
    const res = await traer(`${api}/${path}`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`respondio HTTP ${res.status}`);
    const parsed = (await res.json()) as ApiEnvelope<T>;
    if (parsed.estado !== 1) throw new Error(parsed.mensaje);
    return parsed.datos;
  });
}

/** Cuerpo que espera articulos/pagina para listar una categoria completa.
 *  Todos los campos son obligatorios aunque no filtremos por ninguno: el
 *  backend valida la forma entera, no campo por campo. */
function filtrosDeCategoria(marca: FiltroMarca[] = []) {
  return {
    preciomenor: -1,
    preciomayor: -1,
    marca,
    categoria: [],
    tipo_seleccion: 'categoria',
    filtros_gramaje: [],
    filtros_descuento: [],
    cant_articulos: PAGE_SIZE,
    ofertas: false,
    // Sin esto la respuesta trae las facetas (marcas, gramajes, precios) pero
    // `articulos` viene vacio. Es el flag que distingue "primera carga".
    modificado: true,
    primer_filtro: marca.length > 0 ? 'marca' : '',
  };
}

/** El filtro quiere la marca en minusculas y sin nada que no sea letra o
 *  numero, igual que en la URL del sitio: "PRIMER PRECIO" -> "primerprecio". */
function comoFiltro(m: ApiMarca): FiltroMarca {
  return {
    descripcion: m.marca_desc.toLowerCase().replace(/[^a-z0-9]/gi, ''),
    id: String(m.id_marca),
    valido: true,
  };
}

/** Aplana el arbol de categorias a id -> ['Almacen','Desayuno','Yerba'] */
function flattenCategories(nodes: ApiCategoria[], prefix: string[] = []): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const node of nodes) {
    const path = [...prefix, node.descripcion];
    out.set(node.id_categoria, path);
    for (const [k, v] of flattenCategories(node.hijos ?? [], path)) out.set(k, v);
  }
  return out;
}

/** 'AAAA-MM-DD' -> fin de ese dia. La promo vale todo el ultimo dia, no hasta
 *  las 00:00: tomarlo como instante la daria por vencida una jornada antes. */
function parseVigencia(v: string | null | undefined): Date | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T23:59:59-03:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Llevando 2" -> 2. Respaldo para cuando la API manda la etiqueta pero no
 *  `cantidad_promo`, que pasa segun por donde se pida el articulo. */
function desdeLaEtiqueta(etiqueta: string | null | undefined): number {
  const m = /(?:llevando|llev[aá]|x)\s*(\d+)/i.exec(etiqueta ?? '');
  const n = m ? Number(m[1]) : 0;
  return Number.isFinite(n) && n > 1 ? n : 0;
}

function toSourceProduct(
  a: ApiArticulo,
  categories: Map<number, string[]>,
  web: string,
): SourceProduct | null {
  const precio = parsePriceToCents(a.precio);
  if (precio === null) return null; // sin precio no nos sirve

  // La Coope marca las promociones de dos formas distintas y hay que leer las
  // dos, porque casi todas son de la segunda.
  //
  // La clasica baja `precio_promo` por debajo de `precio`: un 2x1 a mitad de
  // precio. Esa la veniamos tomando.
  //
  // La de campaña —el "Ahorron"— ya viene aplicada: manda `precio` con el
  // descuento hecho, `precio_promo` igual a `precio`, y el precio de lista
  // aparte en `precio_anterior`. Mirando solo los dos primeros el producto
  // parece no estar en oferta, asi que entraba al catalogo con la rebaja
  // disfrazada de precio normal. Costaba plata de verdad: el descuento de
  // empleado no acumula con promociones, y se lo sumabamos encima. Medido
  // sobre una muestra del arbol, se nos escapaban 30 de cada 31 promociones.
  //
  // `existe_promo` sola no alcanza para marcar: hay articulos con la bandera
  // encendida y ningun precio distinto. Se exige que el precio baje de verdad.
  const promoListado = parsePriceToCents(a.precio_promo);
  const anterior = parsePriceToCents(a.precio_anterior);
  const enCampana = String(a.existe_promo ?? '') === '1';

  let priceCents = precio;
  let promoCents: number | null = null;
  if (promoListado !== null && promoListado < precio) {
    promoCents = promoListado;
  } else if (enCampana && anterior !== null && anterior > precio) {
    priceCents = anterior;
    promoCents = precio;
  }

  // La etiqueta se guarda venga o no con rebaja en el precio.
  const promoLabel = a.descripcion_promo?.trim() || null;
  const promoHasta = promoCents !== null ? parseVigencia(a.vigencia_promo) : null;
  // "Llevando 2": el precio promocional es por unidad pero recien vale desde
  // esa cantidad. Guardado sin esto, una sola botella figuraba al precio de a
  // dos y el total prometia menos de lo que cobra la caja.
  const desde = Number(a.cantidad_promo ?? 0) || desdeLaEtiqueta(a.descripcion_promo) || 1;
  const promoDesde = promoCents !== null && Number.isFinite(desde) && desde > 1
    ? Math.round(desde)
    : null;

  const idCat = a.id_categoria ? Number(a.id_categoria) : null;

  return {
    externalId: a.cod_interno,
    // La Coope no publica codigo de barras. Otras cadenas si lo haran.
    ean13: null,
    name: a.descripcion,
    brand: a.marca_desc,
    contentValue: a.gramaje ? Number.parseFloat(a.gramaje) : null,
    contentUnit: normalizeUnit(a.unimed_desc),
    // tipo_articulo '2' = se vende por peso variable (fiambreria, carniceria)
    isWeighted: a.tipo_articulo === '2',
    priceCents,
    promoCents,
    promoLabel,
    promoDesde,
    promoHasta,
    categoryPath: (idCat !== null ? categories.get(idCat) : undefined) ?? [],
    imageUrl: a.imagen,
    url: `https://${web}/producto/${toCoopeUrlSlug(a.descripcion)}/${a.cod_interno}`,
    raw: a,
  };
}

interface Recorrido {
  categories: Map<number, string[]>;
  vistos: Set<string>;
  emitidos: number;
  limit: number;
}

export class CoopeAdapter implements ChainAdapter {
  readonly chain: string;
  readonly displayName: string;
  private readonly api: string;
  private readonly web: string;

  constructor(cfg: CoopeConfig) {
    this.chain = cfg.chain;
    this.displayName = cfg.displayName;
    this.api = cfg.api;
    this.web = cfg.web;
  }

  async *fetchProducts({ limit }: { limit: number }): AsyncGenerator<SourceProduct> {
    const tree = await apiGet<ApiCategoria[]>(this.api, 'categorias/arbol');
    await sleep(DELAY_MS);

    const ctx: Recorrido = {
      categories: flattenCategories(tree),
      vistos: new Set<string>(),
      emitidos: 0,
      limit,
    };

    for (const raiz of tree) {
      if (ctx.emitidos >= ctx.limit) return;
      yield* this.recorrerCategoria(raiz, ctx);
    }
  }

  private async pedirPagina(
    idCategoria: number,
    pagina: number,
    orden: number,
    marca: FiltroMarca[] = [],
  ): Promise<ApiPagina> {
    const datos = await apiPost<ApiPagina>(this.api, 'articulos/pagina', {
      id_busqueda: idCategoria,
      pagina,
      orden,
      filtros: filtrosDeCategoria(marca),
    });
    await sleep(DELAY_MS);
    return datos;
  }

  /** Solo pedimos las hojas del arbol.
   *
   *  Una categoria con hijas informa en cantidad_articulos el total de su rama,
   *  pero su listado devuelve una sola pagina recortada: "Papeles" declara 40 y
   *  entrega 32, y de las 9 servilletas de su hija aparece una. En las hojas, en
   *  cambio, el total declarado es fiable y sirve para saber cuando terminamos. */
  private async *recorrerCategoria(
    cat: ApiCategoria,
    ctx: Recorrido,
  ): AsyncGenerator<SourceProduct> {
    const hijos = cat.hijos ?? [];
    if (hijos.length > 0) {
      for (const hijo of hijos) {
        if (ctx.emitidos >= ctx.limit) return;
        yield* this.recorrerCategoria(hijo, ctx);
      }
      return;
    }

    const enLaHoja = new Set<string>();
    let declarados = Number.POSITIVE_INFINITY;
    let marcas: ApiMarca[] = [];

    /** Emite lo que traiga una consulta y anota lo visto. Devuelve false
     *  cuando hay que cortar por haber llegado al limite pedido. */
    const emitir = async function* (
      this: CoopeAdapter,
      lote: ApiArticulo[],
    ): AsyncGenerator<SourceProduct, boolean> {
      for (const a of lote) {
        enLaHoja.add(a.cod_interno);
        if (ctx.emitidos >= ctx.limit) return false;
        if (ctx.vistos.has(a.cod_interno)) continue; // cae en varias ramas
        ctx.vistos.add(a.cod_interno);

        const producto = toSourceProduct(a, ctx.categories, this.web);
        if (producto === null) continue;

        yield producto;
        ctx.emitidos++;
      }
      return true;
    }.bind(this);

    // La categoria entera va en un try: si no responde ni con los reintentos,
    // se anota y el recorrido sigue con la siguiente. Perder una gondola es
    // molesto; perder el resto del catalogo por esa gondola no tiene sentido.
    try {
      // Un orden alcanza para la mayoria de las hojas; el barrido completo solo
      // se paga en las que cortan la paginacion temprano.
      for (const orden of ORDENES) {
        let pagina = 0;

        while (pagina < MAX_PAGINAS) {
          const datos = await this.pedirPagina(cat.id_categoria, pagina, orden);
          declarados = datos.cantidad_articulos;
          if (datos.marcas?.length) marcas = datos.marcas;
          const lote = datos.articulos ?? [];
          if (lote.length === 0) break;
          pagina++;

          const sigue = yield* emitir(lote);
          if (!sigue) return;
        }

        if (enLaHoja.size >= declarados) break;
      }

      // El listado de una categoria no se puede enumerar entero: se estanca
      // bastante antes de lo que declara, y el propio sitio tampoco pasa de
      // ahi —midiendolo, "Dulces" entrega 64 de 148 en el navegador—. Pero la
      // misma respuesta trae las marcas presentes con su conteo, y filtrando
      // por cada una ningun subconjunto llega al tope. Con eso la categoria
      // sale completa: 148 de 148.
      if (enLaHoja.size < declarados && marcas.length > 0) {
        for (const marca of marcas) {
          if (enLaHoja.size >= declarados) break;
          const datos = await this.pedirPagina(cat.id_categoria, 0, 1, [comoFiltro(marca)]);
          const sigue = yield* emitir(datos.articulos ?? []);
          if (!sigue) return;
        }
      }
    } catch (err) {
      console.warn(`  ! "${cat.descripcion}" quedo afuera: ${String(err).slice(0, 110)}`);
      return;
    }

    if (enLaHoja.size < declarados) {
      console.warn(`  ! "${cat.descripcion}": declara ${declarados} y listo ${enLaHoja.size}.`);
    }
  }
}
