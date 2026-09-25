/** Helpers genericos de normalizacion, compartidos por todos los adapters. */

/** Minusculas y sin tildes: lo que se indexa para la busqueda trigram. */
export function toNormalizedName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** "4790.00" -> 479000. Enteros siempre: los float con plata mienten. */
export function parsePriceToCents(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number.parseFloat(raw);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** Unifica las unidades que usa cada cadena a un juego chico y estable. */
const UNIT_MAP: Record<string, string> = {
  gr: 'g', grs: 'g', gramo: 'g', gramos: 'g', g: 'g',
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg',
  // La Coope expresa TODO el volumen en cm3: sin esta linea, sus casi 5.000
  // productos liquidos quedan sin unidad y no comparan contra ningun ml.
  ml: 'ml', cc: 'ml', cm3: 'ml', cmc: 'ml',
  l: 'l', lt: 'l', lts: 'l', litro: 'l', litros: 'l',
  un: 'un', uni: 'un', unid: 'un', unidad: 'un', unidades: 'un',
};

export function normalizeUnit(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Sacar la puntuacion: La Coope manda "ml." con punto en 61 articulos.
  return UNIT_MAP[toNormalizedName(raw).replace(/[^a-z0-9]/g, '')] ?? null;
}

/** Valida el digito verificador de un EAN-13. La Coope no publica codigos de
 *  barras, pero otras cadenas si: mejor rechazar basura en la puerta de entrada
 *  que descubrir codigos invalidos cuando la camara no matchea nada. */
export function isValidEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  const digits = [...code].map(Number) as number[];
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += digits[i]! * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === digits[12];
}

/** Convierte UN nombre de categoria en UN segmento de slug.
 *  Clave: La Coope usa "/" dentro de los nombres ("Yogures/Salud Activa",
 *  "Azucar/Edulcorante"). Si no lo sacamos, el slug finge una jerarquia que no
 *  existe y puede colisionar con una categoria hija real del mismo nombre. */
export function toSlugSegment(name: string): string {
  return toNormalizedName(name)
    .replace(/[/\\]+/g, '-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Slug tal como lo arma La Coope para sus URLs: minusculas y espacios por
 *  guiones, CONSERVANDO acentos y ñ. Verificado contra su sitemap, que publica
 *  /listado/marca/cañuelas/4052/ y /listado/marca/verónica/4041/.
 *
 *  Ojo: no confundir con toSlugSegment(), que si saca los acentos porque sirve
 *  para claves internas nuestras. Aca la forma la dicta el sitio, no nosotros. */
export function toCoopeUrlSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[/\\]+/g, '-')   // una barra partiria el path de la URL
    .replace(/\s+/g, '-')
    // Un % suelto es una secuencia de escape invalida: el sitio responde 400.
    // Pasa seguido ("0% lactosa", "1% sachet"). El % va primero, si no
    // reencodearia los % que introducen las lineas siguientes.
    .replace(/%/g, '%25')
    .replace(/\?/g, '%3F')
    .replace(/#/g, '%23');
}

/** Saca el contenido del nombre cuando la fuente no lo publica aparte.
 *
 *  La Coope trae gramaje y unidad en campos propios; las cadenas VTEX no, y lo
 *  unico que hay es el nombre ("Azucar Molida 1 Kg Ledesma"). Sin esto no se
 *  puede calcular precio por kilo ni comparar 900ml contra 1L entre cadenas.
 *
 *  Si aparecen varias medidas nos quedamos con la de peso o volumen antes que
 *  con el conteo: en "30 Mts x 4 Un" el 4 son unidades, pero en "Yogur 120g x
 *  4" lo que importa para comparar es el gramaje. */
const RE_CONTENIDO = /(\d+(?:[.,]\d+)?)\s*(kgs?|kilos?|grs?|gramos?|g|mls?|cm3|cc|lts?|litros?|l|unid(?:ad(?:es)?)?|un)\b/gi;
const UNIDADES_DE_MEDIDA = new Set(['g', 'kg', 'ml', 'l']);

export function parseContentFromName(
  name: string,
): { value: number; unit: string } | null {
  const encontrados: { value: number; unit: string }[] = [];

  for (const m of toNormalizedName(name).matchAll(RE_CONTENIDO)) {
    const value = Number.parseFloat(m[1]!.replace(',', '.'));
    const unit = normalizeUnit(m[2]!);
    if (!unit || !Number.isFinite(value) || value <= 0) continue;
    encontrados.push({ value, unit });
  }

  return (
    encontrados.find((c) => UNIDADES_DE_MEDIDA.has(c.unit)) ?? encontrados[0] ?? null
  );
}

/** Palabras que aparecen en casi todos los nombres y no distinguen nada.
 *
 *  Ojo con "con" y "sin": parecen muletillas pero niegan, y sacarlas volvia
 *  identicos a "mani con piel" y "mani sin piel". Van tratadas como cualquier
 *  otro token.
 *
 *  La segunda mitad de la lista no la invente: sale de comparar los nombres de
 *  4.384 productos que DOS cadenas identifican con el mismo codigo de barras,
 *  o sea demostrablemente el mismo articulo. Las palabras que mas aparecen en
 *  uno y faltan en el otro son todas de envase: una cadena escribe "doypack" o
 *  "botella" y la otra no se molesta. */
const RUIDO = new Set([
  'para', 'por', 'del', 'los', 'las', 'sabor', 'tipo', 'pack',
  'grs', 'gramos', 'kgs', 'kilo', 'kilos', 'lts', 'litro', 'litros', 'cm3',
  'und', 'unidad', 'unidades',
  // Envase y presentacion, aprendidas de los pares verificados por EAN.
  'uni', 'botella', 'bolsa', 'pote', 'sobre', 'lata', 'doypack', 'aerosol',
  'repuesto', 'envase', 'caja', 'sachet', 'frasco', 'estuche', 'bidon', 'pouch',
]);

/** Tokens del nombre que efectivamente distinguen un producto de otro.
 *
 *  Saca marca, numeros, unidades y muletillas. Lo que queda es el sabor, la
 *  variante y el formato, que es justo donde se juega si dos fichas son el
 *  mismo producto: "actimel citrus" y "actimel frutilla" comparten casi todas
 *  las letras, y por eso la similitud trigram las confunde, pero no comparten
 *  el token que importa. */
export function nameTokens(name: string, brand?: string | null): Set<string> {
  const marca = new Set(
    brand ? toNormalizedName(brand).split(/[^a-z0-9]+/).filter(Boolean) : [],
  );

  const out = new Set<string>();
  for (const t of toNormalizedName(name).split(/[^a-z0-9]+/)) {
    if (t.length < 3 || /^\d+$/.test(t) || RUIDO.has(t) || marca.has(t)) continue;
    // Las cadenas lo escriben de las dos formas y es la misma palabra.
    out.add(t === 'yogurt' ? 'yogur' : t);
  }
  return out;
}

/** Interseccion sobre union. 1 = mismos tokens, 0 = ninguno en comun. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let comunes = 0;
  for (const t of a) if (b.has(t)) comunes++;
  return comunes / (a.size + b.size - comunes);
}

/** Que proporcion del nombre mas corto esta contenida en el mas largo.
 *
 *  Es mejor que jaccard para comparar catalogos distintos porque no castiga
 *  que una cadena sea mas verbosa que la otra, que es la diferencia mas comun
 *  entre ellas: "Yerba Mate Hierbas 500 Grs Playadito" contra "yerba mate
 *  playadito compuesta con hierbas 500grs" es el mismo producto, pero jaccard
 *  lo baja a 0.67 por las palabras de mas.
 *
 *  Medido contra 4.384 pares verificados por codigo de barras y 6.000 pares de
 *  productos distintos de la misma marca y gramaje: jaccard con umbral 0.70
 *  encuentra el 36% de los verdaderos, contencion con 0.80 encuentra el 63%.
 *
 *  Su punto flojo, a sabiendas: si el nombre corto esta entero adentro del
 *  largo, da 1.0 aunque el largo agregue una variante ("con palo" contra
 *  "suave con palo"). Es la mayor parte del 5,5% que se cuela. */
export function contencion(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let comunes = 0;
  for (const t of a) if (b.has(t)) comunes++;
  return comunes / Math.min(a.size, b.size);
}

/** Lleva gramaje y unidad a una base comparable: kg->g, l->ml.
 *  Sin esto "1 kg" y "1000 grs" parecen productos distintos. */
export function contenidoBase(
  value: number | string | null,
  unit: string | null,
): { valor: number; unidad: string } | null {
  if (value === null || unit === null) return null;
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(n) || n <= 0) return null;

  if (unit === 'kg') return { valor: n * 1000, unidad: 'g' };
  if (unit === 'l') return { valor: n * 1000, unidad: 'ml' };
  return { valor: n, unidad: unit };
}
