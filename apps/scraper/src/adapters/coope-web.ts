import { chromium, type Browser, type Page } from 'playwright';
import type { ChainAdapter, SourceProduct } from './types.js';

/** La Coope scrapeada desde el sitio, con un navegador de verdad.
 *
 *  El sitio es una aplicacion Angular: el HTML que llega no trae ni un precio,
 *  todo lo pinta el JavaScript. Por eso no alcanza con bajar la pagina, hay
 *  que ejecutarla. Playwright abre Chromium, carga el listado y se lee lo que
 *  la pagina termino recibiendo.
 *
 *  Se navega el sitio como lo navega una persona: se abre cada categoria en
 *  /listado/categoria/<slug>/<id>/ y se baja hasta el final. Cuando el listado
 *  se estanca antes de lo que declara —pasa seguido, y le pasa tambien al
 *  sitio— se abren sus marcas, que es como esta armado el filtro lateral.
 */

const WEB = 'https://www.lacoopeencasa.coop';
const DELAY_MS = 400;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ArtWeb {
  cod_interno: string;
  descripcion: string;
  precio: string;
  precio_promo: string | null;
  precio_anterior?: string | null;
  existe_promo?: string | number | boolean | null;
  cantidad_promo?: string | number | null;
  vigencia_promo?: string | null;
  descripcion_promo?: string | null;
  gramaje: string | null;
  unimed_desc: string | null;
  marca_desc: string | null;
  id_categoria: string | null;
  imagen: string | null;
  tipo_articulo: string;
}

interface Categoria {
  id_categoria: number;
  descripcion: string;
  hijos: Categoria[];
}

/** El slug que usa el sitio en la URL de una categoria. */
function slug(desc: string): string {
  return desc
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function hojas(nodos: Categoria[], ruta: string[] = []): { id: number; desc: string; ruta: string[] }[] {
  const out: { id: number; desc: string; ruta: string[] }[] = [];
  for (const n of nodos ?? []) {
    const r = [...ruta, n.descripcion];
    if (!n.hijos?.length) out.push({ id: n.id_categoria, desc: n.descripcion, ruta: r });
    else out.push(...hojas(n.hijos, r));
  }
  return out;
}

/** "Llevando 2" -> 2. Respaldo para cuando la API manda la etiqueta pero no
 *  `cantidad_promo`, que pasa segun por donde se pida el articulo. */
function desdeLaEtiqueta(etiqueta: string | null | undefined): number {
  const m = /(?:llevando|llev[aá]|x)\s*(\d+)/i.exec(etiqueta ?? '');
  const n = m ? Number(m[1]) : 0;
  return Number.isFinite(n) && n > 1 ? n : 0;
}

export class CoopeWebAdapter implements ChainAdapter {
  readonly chain = 'cooperativa_obrera';
  readonly displayName = 'Cooperativa Obrera';

  async *fetchProducts({ limit }: { limit: number }): AsyncGenerator<SourceProduct> {
    // COOPE_VISIBLE=1 abre la ventana y va mas despacio, para poder mirar el
    // recorrido. Sin eso corre oculto, que es como tiene que ir en el cron.
    const verlo = process.env.COOPE_VISIBLE === '1';
    const navegador = await chromium.launch({
      headless: !verlo,
      slowMo: verlo ? 300 : 0,
    });
    try {
      yield* this.recorrer(navegador, limit, verlo);
    } finally {
      await navegador.close();
    }
  }

  private async *recorrer(
    navegador: Browser,
    limit: number,
    verlo: boolean,
  ): AsyncGenerator<SourceProduct> {
    const ctx = await navegador.newContext({
      viewport: { width: 1366, height: 1000 },
      // Sin imagenes el listado carga mucho mas rapido y no perdemos nada: la
      // URL de la foto viaja en los datos, no en el pixel descargado.
      serviceWorkers: 'block',
    });
    // Oculto se bloquean las imagenes y carga mucho mas rapido: la URL de la
    // foto viaja en los datos, no en el pixel. Con ventana se dejan pasar, si
    // no se ve un listado vacio y no se entiende nada de lo que esta haciendo.
    if (!verlo) {
      await ctx.route('**/*.{png,jpg,jpeg,webp,gif,svg,woff,woff2}', (r) => r.abort());
    }

    const pagina = await ctx.newPage();

    // Lo que la pagina recibe se va juntando aca: es la misma informacion que
    // termina dibujada, sin tener que leerla del DOM. Leer el DOM daria el
    // precio ya formateado y perderiamos el resto de los campos.
    const recibidos = new Map<string, ArtWeb>();
    const rutas = new Map<number, string[]>();

    pagina.on('response', async (res) => {
      if (!/\/api\/articulos\/pagina/.test(res.url())) return;
      try {
        const j = (await res.json()) as { datos?: { articulos?: ArtWeb[] | null } };
        for (const a of j?.datos?.articulos ?? []) recibidos.set(String(a.cod_interno), a);
      } catch {
        // Una respuesta que no es JSON no es un error: se ignora.
      }
    });

    const arbol = await this.arbol(pagina);
    for (const h of hojas(arbol)) rutas.set(h.id, h.ruta);

    const emitidos = new Set<string>();
    let cuantos = 0;

    for (const hoja of hojas(arbol)) {
      if (cuantos >= limit) break;
      recibidos.clear();

      try {
        await this.abrirCategoria(pagina, hoja);
      } catch (err) {
        console.warn(`  ! "${hoja.desc}" quedo afuera: ${String(err).slice(0, 100)}`);
        continue;
      }

      for (const a of recibidos.values()) {
        if (cuantos >= limit) break;
        if (emitidos.has(a.cod_interno)) continue;
        emitidos.add(a.cod_interno);

        const p = this.aProducto(a, rutas);
        if (p === null) continue;
        yield p;
        cuantos++;
      }
    }
  }

  /** El arbol de categorias sale de la misma pagina, no de un pedido aparte:
   *  el menu lo necesita para dibujarse, asi que ya esta cargado. */
  private async arbol(pagina: Page): Promise<Categoria[]> {
    const esperando = pagina.waitForResponse(
      (r) => /\/api\/categorias\/arbol/.test(r.url()),
      { timeout: 60_000 },
    );
    await pagina.goto(`${WEB}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const res = await esperando;
    const j = (await res.json()) as { datos?: Categoria[] };
    return j.datos ?? [];
  }

  /** Abre la categoria y baja hasta que el listado deja de crecer. Si aun asi
   *  quedo corto, recorre las marcas del filtro lateral. */
  private async abrirCategoria(
    pagina: Page,
    hoja: { id: number; desc: string },
  ): Promise<void> {
    await pagina.goto(`${WEB}/listado/categoria/${slug(hoja.desc)}/${hoja.id}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await this.bajarHastaElFinal(pagina);

    const declarados = await this.declarados(pagina);
    const tengo = await this.enPantalla(pagina);
    if (declarados === null || tengo >= declarados) return;

    for (const m of await this.marcas(pagina)) {
      await pagina.goto(
        `${WEB}/listado/categoria/${slug(hoja.desc)}/${hoja.id}/_marca--${m.slug}-${m.id}/`,
        { waitUntil: 'domcontentloaded', timeout: 60_000 },
      );
      await this.bajarHastaElFinal(pagina);
      await sleep(DELAY_MS);
    }
  }

  private async bajarHastaElFinal(pagina: Page): Promise<void> {
    let antes = -1;
    for (let vuelta = 0; vuelta < 40; vuelta++) {
      const ahora = await this.enPantalla(pagina);
      if (ahora === antes) return;
      antes = ahora;
      await pagina.keyboard.press('End').catch(() => {});
      await pagina.mouse.wheel(0, 6000).catch(() => {});
      await sleep(900);
    }
  }

  private enPantalla(pagina: Page): Promise<number> {
    return pagina
      .$$eval('a[href^="/producto/"]', (as) =>
        new Set(as.map((a) => a.getAttribute('href')?.split('/').pop())).size)
      .catch(() => 0);
  }

  /** "148 productos" del encabezado del listado. */
  private async declarados(pagina: Page): Promise<number | null> {
    const texto = await pagina
      .locator('text=/\\d+\\s+(productos|articulos|resultados)/i')
      .first()
      .textContent({ timeout: 5_000 })
      .catch(() => null);
    const m = texto ? /(\d+)/.exec(texto) : null;
    return m ? Number(m[1]) : null;
  }

  /** Las marcas del filtro lateral, con el id que va en la URL. */
  private async marcas(pagina: Page): Promise<{ slug: string; id: string }[]> {
    return pagina
      .$$eval('a[href*="_marca--"]', (as) => {
        const out: { slug: string; id: string }[] = [];
        for (const a of as) {
          const m = /_marca--([a-z0-9]+)-(\d+)/i.exec(a.getAttribute('href') ?? '');
          if (m) out.push({ slug: m[1]!, id: m[2]! });
        }
        return out;
      })
      .catch(() => []);
  }

  private aProducto(a: ArtWeb, rutas: Map<number, string[]>): SourceProduct | null {
    const centavos = (v: string | null | undefined): number | null => {
      if (v === null || v === undefined) return null;
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
    };

    const precio = centavos(a.precio);
    if (precio === null) return null;

    const promoListado = centavos(a.precio_promo);
    const anterior = centavos(a.precio_anterior);
    const enCampana = String(a.existe_promo ?? '') === '1' || a.existe_promo === true;

    let priceCents = precio;
    let promoCents: number | null = null;
    if (promoListado !== null && promoListado < precio) {
      promoCents = promoListado;
    } else if (enCampana && anterior !== null && anterior > precio) {
      priceCents = anterior;
      promoCents = precio;
    }

    const hasta = promoCents !== null && a.vigencia_promo
      ? new Date(`${a.vigencia_promo.slice(0, 10)}T23:59:59-03:00`)
      : null;

    // "Llevando 2" publica el precio de a dos como si fuera el unitario.
    const desde = Number(a.cantidad_promo ?? 0) || desdeLaEtiqueta(a.descripcion_promo) || 1;
    const promoDesde = promoCents !== null && Number.isFinite(desde) && desde > 1
      ? Math.round(desde)
      : null;

    const idCat = a.id_categoria ? Number(a.id_categoria) : null;

    return {
      externalId: a.cod_interno,
      ean13: null,
      name: a.descripcion,
      brand: a.marca_desc,
      contentValue: a.gramaje ? Number.parseFloat(a.gramaje) : null,
      contentUnit: a.unimed_desc,
      isWeighted: a.tipo_articulo === '2',
      priceCents,
      promoCents,
      promoLabel: a.descripcion_promo?.trim() || null,
      promoDesde,
      promoHasta: hasta && !Number.isNaN(hasta.getTime()) ? hasta : null,
      categoryPath: (idCat !== null ? rutas.get(idCat) : undefined) ?? [],
      imageUrl: a.imagen,
      url: `${WEB}/producto/${slug(a.descripcion)}/${a.cod_interno}`,
      raw: a,
    };
  }
}
