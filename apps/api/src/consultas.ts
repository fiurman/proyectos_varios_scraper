import { pool } from '@precios/db';

/** Una ficha de producto en una cadena concreta, con su precio de hoy. */
export interface Oferta {
  productId: string;
  cadena: string;
  tienda: string;
  nombre: string;
  ean13: string | null;
  precioCentavos: number;
  promoCentavos: number | null;
  url: string | null;
}

/** El mismo producto visto en todas las cadenas donde existe. */
export interface Grupo {
  id: string;
  nombre: string;
  marca: string | null;
  contenido: { valor: number; unidad: string } | null;
  ean13: string | null;
  /** Miniatura, si alguna cadena la publica. Vive en product_media y no en
   *  products porque no viaja en el sync Light. */
  imagen: string | null;
  /** Se vende por peso: el precio es por kilo y la cantidad es un peso, no
   *  un numero de unidades. Fiambreria, verduleria, carniceria. */
  porPeso: boolean;
  ofertas: Oferta[];
  masBarato: Oferta;
  ahorroCentavos: number;
}

interface FilaCruda {
  canon: string;
  product_id: string;
  nombre: string;
  marca: string | null;
  ean13: string | null;
  content_value: string | null;
  content_unit: string | null;
  chain: string;
  tienda: string;
  price_cents: number;
  promo_cents: number | null;
  url: string | null;
  imagen: string | null;
  is_weighted: boolean;
  orden: number;
}

/** El precio que paga la gente: si hay promo vigente, esa. */
const aPagar = (f: FilaCruda) => f.promo_cents ?? f.price_cents;

/** Agrupa las filas por producto canonico.
 *
 *  Un producto puede llegar por dos caminos: compartir EAN (entonces ya es una
 *  sola fila en products) o estar unido por un match aplicado (entonces son dos
 *  filas y una apunta a la otra). coalesce(canonical_product_id, id) unifica
 *  los dos casos en una sola clave. */
function agrupar(filas: FilaCruda[]): Grupo[] {
  const porCanon = new Map<string, FilaCruda[]>();
  for (const f of filas) {
    const g = porCanon.get(f.canon);
    if (g) g.push(f);
    else porCanon.set(f.canon, [f]);
  }

  const grupos: Grupo[] = [];
  for (const filasDelGrupo of porCanon.values()) {
    const ofertas: Oferta[] = filasDelGrupo
      .map((f) => ({
        productId: f.product_id,
        cadena: f.chain,
        tienda: f.tienda,
        nombre: f.nombre,
        ean13: f.ean13,
        precioCentavos: f.price_cents,
        promoCentavos: f.promo_cents,
        url: f.url,
      }))
      .sort((a, b) => (a.promoCentavos ?? a.precioCentavos) - (b.promoCentavos ?? b.precioCentavos));

    // El nombre y el gramaje los toma la ficha que tenga EAN: viene de una
    // fuente que publica datos estructurados, asi que suele ser la mas prolija.
    const referencia = filasDelGrupo.find((f) => f.ean13) ?? filasDelGrupo[0]!;
    const precios = filasDelGrupo.map(aPagar);

    grupos.push({
      id: referencia.canon,
      nombre: referencia.nombre,
      marca: referencia.marca,
      contenido: referencia.content_value && referencia.content_unit
        ? { valor: Number(referencia.content_value), unidad: referencia.content_unit }
        : null,
      ean13: referencia.ean13,
      imagen: filasDelGrupo.find((f) => f.imagen)?.imagen ?? null,
      porPeso: filasDelGrupo.some((f) => f.is_weighted),
      ofertas,
      masBarato: ofertas[0]!,
      ahorroCentavos: Math.max(...precios) - Math.min(...precios),
    });
  }

  // Primero lo que se puede comparar, y entre esos lo que mas ahorro tiene.
  return grupos.sort(
    (a, b) => b.ofertas.length - a.ofertas.length || b.ahorroCentavos - a.ahorroCentavos,
  );
}

/** Trae todas las ofertas de los grupos canonicos indicados. */
async function ofertasDe(canons: string[], cadena?: string): Promise<Grupo[]> {
  if (canons.length === 0) return [];

  const { rows } = await pool.query<FilaCruda>(
    `select coalesce(p.canonical_product_id, p.id) canon, p.id product_id,
            p.name nombre, p.brand marca, p.ean13, p.content_value, p.content_unit,
            st.chain, st.name tienda, cp.price_cents, cp.promo_cents, s.url,
            img.url imagen, p.is_weighted, 0 orden
       from products p
       join current_prices cp on cp.product_id = p.id
       join stores st on st.id = cp.store_id
       left join product_sources s on s.product_id = p.id and s.chain = st.chain
       left join lateral (
         select m.url from product_media m where m.product_id = p.id limit 1
       ) img on true
      where coalesce(p.canonical_product_id, p.id) = any($1::uuid[])
        and p.deleted_at is null
        and ($2::text is null or st.chain = $2)`,
    [canons, cadena ?? null],
  );
  return agrupar(rows);
}

export async function buscar(
  termino: string,
  opts: { cadena?: string; limite: number },
): Promise<Grupo[]> {
  // Cada palabra por separado: "yerba playadito" no aparece literal en
  // "yerba mate playadito 1kg", pero las dos palabras si estan.
  const palabras = termino.split(/\s+/).filter((w) => w.length >= 2);
  if (palabras.length === 0) return [];
  const patrones = palabras.map((w) => `%${w}%`);

  // Ordenamos por word_similarity y NO por similarity.
  //
  // similarity() compara las cadenas enteras, asi que castiga los nombres
  // largos: "mayonesa natura 475 g" da 0.41 y "mayonesa natura con limon
  // doypack 500grs" da 0.22, aunque las dos contengan lo buscado igual de
  // bien. Como La Coope usa nombres mucho mas descriptivos que las cadenas
  // VTEX, sus productos quedaban sistematicamente abajo del limite y no
  // aparecian nunca. word_similarity mide si lo buscado esta como palabra
  // adentro del nombre, sin importar el largo del resto: da 1.0 para ambos.
  const { rows } = await pool.query<{ canon: string }>(
    `select coalesce(p.canonical_product_id, p.id) canon,
            max(word_similarity($1, p.normalized_name)) sim,
            count(distinct s.chain) cadenas,
            min(length(p.name)) largo
       from products p
       join product_sources s on s.product_id = p.id
      where p.deleted_at is null and p.normalized_name like all($2::text[])
      group by 1
      order by sim desc, cadenas desc, largo asc
      limit $3`,
    // Pedimos de mas para poder intercalar despues sin quedarnos cortos.
    [termino, patrones, opts.limite * 4],
  );

  const grupos = await ofertasDe(rows.map((r) => r.canon), opts.cadena);
  const orden = new Map(rows.map((r, i) => [r.canon, i]));
  grupos.sort((a, b) => (orden.get(a.id) ?? 0) - (orden.get(b.id) ?? 0));

  return intercalar(grupos, opts.limite);
}

/** Reparte los resultados entre cadenas para que ninguna acapare la cabeza.
 *
 *  Buscando "mayonesa" hay decenas de grupos que existen en Carrefour y Disco,
 *  y todos puntuan igual de bien. Ordenados solo por relevancia llenan las
 *  primeras veinte posiciones y los productos que solo estan en La Coope no
 *  aparecen nunca, aunque el usuario este parado justamente ahi.
 *
 *  Agrupamos por combinacion de cadenas y vamos tomando uno de cada grupo por
 *  vuelta. Adentro de cada uno se respeta el orden de relevancia. */
function intercalar(grupos: Grupo[], limite: number): Grupo[] {
  const cohortes = new Map<string, Grupo[]>();
  for (const g of grupos) {
    const clave = [...new Set(g.ofertas.map((o) => o.cadena))].sort().join('+');
    const cohorte = cohortes.get(clave);
    if (cohorte) cohorte.push(g);
    else cohortes.set(clave, [g]);
  }

  const listas = [...cohortes.values()];
  const salida: Grupo[] = [];
  for (let vuelta = 0; salida.length < limite; vuelta++) {
    let hubo = false;
    for (const lista of listas) {
      const g = lista[vuelta];
      if (!g) continue;
      hubo = true;
      salida.push(g);
      if (salida.length === limite) break;
    }
    if (!hubo) break; // se acabaron todas las cohortes
  }
  return salida;
}

export async function porEan(ean13: string): Promise<Grupo | null> {
  const { rows } = await pool.query<{ canon: string }>(
    `select coalesce(p.canonical_product_id, p.id) canon
       from products p where p.ean13 = $1 and p.deleted_at is null limit 1`,
    [ean13],
  );
  if (rows.length === 0) return null;
  return (await ofertasDe([rows[0]!.canon]))[0] ?? null;
}

export async function porId(id: string): Promise<Grupo | null> {
  const { rows } = await pool.query<{ canon: string }>(
    `select coalesce(p.canonical_product_id, p.id) canon
       from products p where p.id = $1 and p.deleted_at is null limit 1`,
    [id],
  );
  if (rows.length === 0) return null;
  return (await ofertasDe([rows[0]!.canon]))[0] ?? null;
}

export interface PuntoHistorico {
  fecha: string;
  cadena: string;
  precioCentavos: number;
  promoCentavos: number | null;
}

export async function historial(id: string, dias: number): Promise<PuntoHistorico[]> {
  const { rows } = await pool.query<PuntoHistorico>(
    `select pr.captured_at fecha, st.chain cadena,
            pr.price_cents "precioCentavos", pr.promo_cents "promoCentavos"
       from prices pr
       join products p on p.id = pr.product_id
       join stores st on st.id = pr.store_id
      where coalesce(p.canonical_product_id, p.id) = (
              select coalesce(p2.canonical_product_id, p2.id) from products p2 where p2.id = $1)
        and pr.captured_at > now() - ($2 || ' days')::interval
      order by pr.captured_at`,
    [id, dias],
  );
  return rows;
}

export async function cadenas(): Promise<unknown[]> {
  const { rows } = await pool.query(
    `select st.chain cadena, st.name nombre, count(cp.product_id) productos,
            max(cp.updated_at) actualizado
       from stores st left join current_prices cp on cp.store_id = st.id
      group by st.id, st.chain, st.name order by 3 desc`,
  );
  return rows;
}
