import { pool } from '@precios/db';

/** Sync incremental para el modo LIGHT del celular.
 *
 *  Cada fila de products y current_prices tiene una `revision` que sale de una
 *  secuencia global y que un trigger sube en cada UPDATE. El celular guarda la
 *  ultima revision que vio y pide solo lo que cambio desde entonces, sin
 *  importar cuando fue ni cuantas veces corrio el scraper.
 *
 *  La secuencia es global y no por tabla a proposito: una sola marca de agua
 *  ordena los cambios de todas las tablas entre si. */

const TOPE = 5000;

export interface Lote {
  productos: unknown[];
  precios: unknown[];
  /** Marca de agua para el proximo pedido. */
  revision: number;
  /** Si quedan mas cambios, el cliente vuelve a pedir enseguida. */
  hayMas: boolean;
}

export async function cambiosDesde(desde: number, limite: number): Promise<Lote> {
  const tope = Math.min(limite, TOPE);

  const { rows: productos } = await pool.query(
    `select p.id, p.ean13, p.name nombre, p.brand marca, p.category_id "categoriaId",
            p.content_value "contenidoValor", p.content_unit "contenidoUnidad",
            p.is_weighted "porPeso", p.canonical_product_id "canonicoId",
            p.revision, p.deleted_at "borradoEn"
       from products p where p.revision > $1 order by p.revision limit $2`,
    [desde, tope],
  );

  const { rows: precios } = await pool.query(
    `select cp.product_id "productoId", st.chain cadena,
            cp.price_cents "precioCentavos", cp.promo_cents "promoCentavos", cp.revision
       from current_prices cp join stores st on st.id = cp.store_id
      where cp.revision > $1 order by cp.revision limit $2`,
    [desde, tope],
  );

  // La marca de agua avanza solo hasta donde llegamos en AMBAS tablas: si una
  // se corto por el tope, subirla mas se saltearia cambios de la otra.
  const ultima = (filas: { revision: number }[], corto: boolean) =>
    corto ? filas[filas.length - 1]!.revision : Number.POSITIVE_INFINITY;

  const cortoP = productos.length === tope;
  const cortoC = precios.length === tope;
  const candidatas = [
    ultima(productos as { revision: number }[], cortoP),
    ultima(precios as { revision: number }[], cortoC),
  ].filter(Number.isFinite);

  const maximo = Math.max(
    desde,
    ...(productos as { revision: number }[]).map((r) => r.revision),
    ...(precios as { revision: number }[]).map((r) => r.revision),
  );

  return {
    productos,
    precios,
    revision: candidatas.length > 0 ? Math.min(...candidatas) : maximo,
    hayMas: cortoP || cortoC,
  };
}

export async function revisionActual(): Promise<number> {
  const { rows } = await pool.query<{ v: string }>(
    `select last_value v from global_revision_seq`,
  );
  return Number(rows[0]!.v);
}
