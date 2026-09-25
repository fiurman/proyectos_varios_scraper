/** Contrato que debe cumplir cada cadena de supermercados.
 *
 *  La Coope tiene API JSON; otras cadenas habra que scrapearlas con Playwright
 *  leyendo el HTML. Da igual: mientras el adapter produzca SourceProduct, el
 *  resto del pipeline (normalizar, persistir, precios) no cambia ni una linea.
 */
export interface SourceProduct {
  /** Codigo del producto en ESA cadena. Unico por cadena, no entre cadenas. */
  externalId: string;

  /** Codigo de barras. null cuando la fuente no lo publica (caso La Coope).
   *  Las cadenas que scrapeemos por HTML suelen si tenerlo en la ficha. */
  ean13: string | null;

  name: string;
  brand: string | null;

  /** Contenido desglosado: 1000 + 'g'. Permite comparar 900ml contra 1L. */
  contentValue: number | null;
  contentUnit: string | null;
  isWeighted: boolean;

  priceCents: number;
  promoCents: number | null;
  promoLabel: string | null;

  /** Desde cuantas unidades vale `promoCents`. Null o 1 es la promo comun.
   *
   *  "Llevando 2" publica el precio de a dos como si fuera el unitario: la
   *  Coca-Cola de 1,5 L figura a $3.600 cuando llevando una sale $4.190. */
  promoDesde: number | null;

  /** Hasta cuando rige la promo, si la fuente lo publica.
   *
   *  Sirve para mostrar "hasta el martes", pero sobre todo para no arrastrar
   *  una rebaja vencida: un precio viejo marcado como oferta miente dos veces,
   *  en el numero y en la etiqueta. */
  promoHasta: Date | null;

  /** De la categoria mas general a la mas especifica. */
  categoryPath: string[];

  imageUrl: string | null;
  url: string | null;

  /** Payload crudo, para reprocesar sin volver a pedirle nada al sitio. */
  raw: unknown;
}

export interface ChainAdapter {
  /** Identificador estable. Es la clave junto con externalId. */
  readonly chain: string;
  readonly displayName: string;

  /** Generador: permite cortar en cualquier momento sin bajar todo el catalogo. */
  fetchProducts(opts: { limit: number }): AsyncGenerator<SourceProduct>;
}
