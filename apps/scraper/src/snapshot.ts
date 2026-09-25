import { createWriteStream } from 'node:fs';
import { mkdir, writeFile, stat, readdir, unlink } from 'node:fs/promises';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { QueryResultRow } from 'pg';
import { pool } from '@precios/db';

/** Genera el catalogo que baja el celular, como archivos estaticos.
 *
 *  No hay servidor en produccion: el telefono busca y escanea contra su copia
 *  local, y lo unico que necesita de afuera es ponerse al dia. Eso es un
 *  archivo, no un servicio. Se sube a un bucket o CDN y listo.
 *
 *  Genera dos cosas:
 *    manifiesto.json     que revision hay y que archivos bajar
 *    completo-<rev>.json.gz   el catalogo entero, para instalar de cero
 *
 *  Los incrementales salen del mismo endpoint que ya usa la API: cualquier
 *  cliente que guarde su ultima revision pide solo lo que cambio. */

// Sin argumento, la raiz del repo. Anclado al modulo y no al cwd porque npm
// corre los scripts de workspace parado en apps/scraper, y un 'snapshot'
// relativo terminaria enterrado ahi adentro.
const SALIDA = process.argv[2]
  ? path.resolve(process.argv[2])
  : fileURLToPath(new URL('../../../snapshot/', import.meta.url));

interface Conteos { [tabla: string]: number }

async function filas<T extends QueryResultRow>(sql: string): Promise<T[]> {
  const { rows } = await pool.query<T>(sql);
  return rows;
}

async function escribirGz(destino: string, datos: unknown): Promise<number> {
  await pipeline(
    Readable.from([JSON.stringify(datos)]),
    createGzip({ level: 9 }),
    createWriteStream(destino),
  );
  return (await stat(destino)).size;
}

const kb = (b: number) => `${(b / 1024).toFixed(0)} KB`;

/** Los rubros que las promos bancarias excluyen, reconocidos por el nombre de
 *  la categoria.
 *
 *  Se resuelve mirando la ruta entera —raiz y descendientes— y no solo la raiz,
 *  porque cada cadena arma su arbol distinto: en La Coope la carne cuelga de
 *  "Frescos > Carniceria" y en Carrefour hay una raiz "Carnes y pescados".
 *
 *  Un producto puede caer en varios: "Bazar y Textil" es bazar y textil a la
 *  vez, y una promo que excluya cualquiera de los dos lo deja afuera. Eso peca
 *  de conservador —excluye de mas— que es el lado correcto para equivocarse:
 *  promete menos reintegro del que podria salir, no mas. */
/** Raices que son "compras de supermercado" para las promos bancarias.
 *
 *  Corta seco: si el producto cuelga de una de estas, entra en la promo y no se
 *  mira nada mas. Sin esta regla, una palabra suelta en un nivel profundo
 *  contamina —"Limpieza > Ropa > Prelavados" hacia pasar al quitamanchas Vanish
 *  por textil, y "Almacen > Conservas" al atun en lata por pescaderia—. */
const SUPERMERCADO =
  /almacen|bebida|limpieza|perfumer|farmacia|desayuno|merienda|kiosco|panader|mascota|frutas y (?:verdura|hortaliza)|lacteos/i;

/** Rubros reconocidos por el nombre de la raiz. */
const POR_RAIZ: [string, RegExp][] = [
  ['carne', /carnes?\b/i],
  ['pescado', /pescad|marisco/i],
  ['hogar', /hogar|casa y jard|linea blanca|herramient|climatiz|movilidad|mueble/i],
  ['tecnologia', /tecnolog|electro|inform|celular|telefon/i],
  ['bazar', /bazar/i],
  ['textil', /textil|blanquer|indumentar|calzado/i],
  ['regaleria', /regaler|juguet|cotill/i],
];

/** Dentro de una raiz que no es de supermercado, el segundo nivel todavia puede
 *  delatar el mostrador: "Frescos" es ambiguo, "Frescos > Carniceria" no. */
const POR_NIVEL2: [string, RegExp][] = [
  ['carne', /carnicer|carnes?\b|pollo|cerdo|vacun|achura|embutido/i],
  ['pescado', /pescad|marisco/i],
];

const sinTildes = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/** El descuento de empleado de La Coope no es parejo: 15% para la marca propia
 *  y para frutas y verduras, 10% para todo lo demas.
 *
 *  Sacado de tres tickets reales, donde la cuenta cierra al centavo. No es por
 *  alicuota de IVA aunque el ticket lo agrupe asi: la leche Cooperativa y la de
 *  La Serenisima tienen las dos IVA 0 y reciben 15% y 10%; la papa y la carne
 *  tienen las dos IVA 10,5 y reciben 15% y 10%. */
const MARCAS_PROPIAS = /^(cooperativa|ecoop)$/i;
const VERDULERIA = /^frescos > frutas y hortalizas/i;

export function descuentoEmpleado(marca: string | null, ruta: string): 10 | 15 {
  if (marca && MARCAS_PROPIAS.test(marca.trim())) return 15;
  if (VERDULERIA.test(ruta)) return 15;
  return 10;
}

/** Los rubros de una ruta "Raiz > Nivel2 > ...", separados por coma. */
function rubrosDe(ruta: string): string {
  const partes = sinTildes(ruta).split(' > ');
  const raiz = partes[0] ?? '';
  if (!raiz || SUPERMERCADO.test(raiz)) return '';

  const encontrados = new Set(
    POR_RAIZ.filter(([, re]) => re.test(raiz)).map(([k]) => k),
  );
  const nivel2 = partes[1] ?? '';
  for (const [k, re] of POR_NIVEL2) if (re.test(nivel2)) encontrados.add(k);

  return [...encontrados].join(',');
}

async function main(): Promise<void> {
  await mkdir(SALIDA, { recursive: true });

  const [fila] = await filas<{ rev: string }>(
    'select last_value rev from global_revision_seq',
  );
  const revision = Number(fila!.rev);

  // Solo lo que viaja en modo Light: texto y numeros. Nada de imagenes ni
  // embeddings, que viven en tablas aparte y se bajan aparte.
  const tiendas = await filas(
    `select id, slug, chain cadena, name nombre from stores where is_active`,
  );
  const categorias = await filas(
    `select id, slug, name nombre, parent_id "padreId" from categories`,
  );
  // La URL de la miniatura si viaja, aunque la foto no: son 112 caracteres que
  // comprimen muy bien —comparten todo el prefijo— y sin ellas el celular no
  // puede mostrar ninguna imagen ni teniendo wifi. Lo pesado sigue afuera: los
  // bytes de la foto se bajan solo cuando hay que dibujarla.
  // La ruta completa de cada categoria, de la raiz a la hoja. Es lo que se mira
  // para decidir a que rubro pertenece un producto.
  const rutas = new Map<string, string>(
    (await filas<{ id: string; ruta: string }>(
      `with recursive sube as (
         select c.id, c.name::text ruta, c.parent_id from categories c
         union all
         select s.id, c.name || ' > ' || s.ruta, c.parent_id
           from sube s join categories c on c.id = s.parent_id
       )
       select id, ruta from sube where parent_id is null`,
    )).map((r) => [r.id, r.ruta]),
  );

  const productos = await filas(
    `select p.id, p.ean13, p.name nombre, p.brand marca, p.category_id "categoriaId",
            p.content_value "contenidoValor", p.content_unit "contenidoUnidad",
            p.is_weighted "porPeso", p.canonical_product_id "canonicoId",
            img.url imagen, p.revision,
            -- El descuento de empleado es un beneficio de La Coope: calcularlo
            -- para las demas no significa nada, y ensucia. Un producto vive en
            -- una sola cadena, asi que alcanza con preguntar por la suya.
            exists (
              select 1 from product_sources ps
               where ps.product_id = p.id and ps.chain = 'cooperativa_obrera'
            ) "esCoope"
       from products p
       left join lateral (
         select m.url from product_media m where m.product_id = p.id limit 1
       ) img on true
      where p.deleted_at is null
        -- Un producto sin precio en ninguna tienda activa no le sirve a nadie:
        -- son los que solo existian en una cadena que sacamos de circulacion.
        and exists (
          select 1 from current_prices cp
            join stores st on st.id = cp.store_id and st.is_active
           where cp.product_id = p.id
        )`,
  );
  const precios = await filas(
    `select cp.product_id "productoId", st.chain cadena,
            cp.price_cents "precioCentavos", cp.promo_cents "promoCentavos",
            cp.promo_label "promoEtiqueta", cp.promo_hasta "promoHasta",
            cp.promo_desde "promoDesde", cp.revision
       from current_prices cp join stores st on st.id = cp.store_id
      where st.is_active`,
  );

  // Las promos bancarias viajan con el catalogo: son siete filas de texto, no
  // mueven la aguja del tamaño, y sin ellas la pantalla de promociones no
  // andaria sin conexion —que es justo donde se la consulta, adentro del super.
  const promos = await filas(
    `select chain cadena, slug, banco, porcentaje,
            porcentaje_min "porcentajeMin", porcentaje_max "porcentajeMax",
            dias, tope_cents "topeCents", tope_periodo "topePeriodo",
            excluye, excluye_texto "excluyeTexto",
            medios_pago "mediosPago", solo_online "soloOnline",
            texto, condiciones, url
       from promos_bancarias where activa
      order by coalesce(porcentaje, porcentaje_max) desc, banco`,
  );

  // El rubro viaja calculado: es una palabra corta por producto y le evita al
  // telefono tener que bajar y recorrer el arbol de categorias entero.
  for (const p of productos as {
    categoriaId: string | null; marca: string | null; esCoope?: boolean;
    rubro?: string; descEmpleado?: number; categoria?: string;
  }[]) {
    const ruta = p.categoriaId ? rutas.get(p.categoriaId) ?? '' : '';
    const r = rubrosDe(ruta);
    if (r) p.rubro = r;
    // La categoria de mas arriba: "Almacen", "Frescos", "Limpieza". Es lo que
    // sirve para filtrar una busqueda, y viaja como una palabra por producto
    // en vez de mandarle al telefono un arbol de 2.377 nodos que ademas cambia
    // de forma en cada cadena.
    const raiz = ruta.split(' > ')[0]?.trim();
    if (raiz) p.categoria = raiz;
    // Solo se manda la excepcion: sin el campo, la app asume el 10%.
    if (!p.esCoope) { delete p.esCoope; continue; }
    delete p.esCoope;
    const pct = descuentoEmpleado(p.marca, ruta);
    if (pct !== 10) p.descEmpleado = pct;
  }

  const conteos: Conteos = {
    tiendas: tiendas.length,
    categorias: categorias.length,
    productos: productos.length,
    precios: precios.length,
    promos: promos.length,
  };

  const archivo = `completo-${revision}.json.gz`;
  const bytes = await escribirGz(path.join(SALIDA, archivo), {
    revision,
    generado: new Date().toISOString(),
    tiendas,
    categorias,
    productos,
    precios,
    promos,
  });

  // El manifiesto es lo primero que pide el celular: con una descarga de un
  // par de KB ya sabe si esta al dia y, si no, que bajar.
  await writeFile(
    path.join(SALIDA, 'manifiesto.json'),
    JSON.stringify({ revision, generado: new Date().toISOString(), completo: archivo, bytes, conteos }, null, 2),
  );

  // Se conservan dos: el vigente y uno de respaldo por si hay que volver atras.
  // Sin esto se acumulan indefinidamente —llegaron a diez, 34 MB— y `publicar`
  // los sube todos en cada corrida, gastando espacio y operaciones en R2
  // aunque la app solo use el que nombra el manifiesto.
  const CONSERVAR = 2;
  const gz = (await readdir(SALIDA))
    .filter((f) => f.startsWith('completo-') && f.endsWith('.json.gz'))
    // Por numero de revision y no por nombre: "completo-9" es mas nuevo que
    // "completo-10" si se ordena como texto.
    .sort((a, b) => Number(b.match(/\d+/)?.[0] ?? 0) - Number(a.match(/\d+/)?.[0] ?? 0));

  for (const viejo of gz.slice(CONSERVAR)) {
    await unlink(path.join(SALIDA, viejo));
  }
  const borrados = Math.max(0, gz.length - CONSERVAR);

  console.log(`Revision ${revision}`);
  for (const [k, v] of Object.entries(conteos)) console.log(`  ${k.padEnd(12)} ${v}`);
  console.log(`\n${SALIDA}/${archivo}  ${kb(bytes)}`);
  console.log(`${SALIDA}/manifiesto.json`);
  if (borrados > 0) {
    console.log(`Borrados ${borrados} snapshots viejos (se conservan ${CONSERVAR}).`);
  }
}

try {
  await main();
} finally {
  await pool.end();
}
