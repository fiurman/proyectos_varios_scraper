import { and, eq, ne, sql } from 'drizzle-orm';
import {
  db, stores, categories, products, productSources, prices, currentPrices,
  scrapeRuns, rawScrapeItems, productMedia, eanConflictos,
} from '@precios/db';
import type { SourceProduct } from './adapters/types.js';
import { toNormalizedName, toSlugSegment } from './normalize.js';

interface Dueno {
  id: string;
  name: string;
}

/** Si ese codigo de barras ya es de OTRO producto, devuelve cual. */
async function duenoDelEan(ean13: string | null, salvo: string): Promise<Dueno | undefined> {
  if (!ean13) return undefined;
  const [otro] = await db.select({ id: products.id, name: products.name })
    .from(products)
    .where(and(eq(products.ean13, ean13), ne(products.id, salvo)));
  return otro;
}

/** Deja constancia del choque para poder revisarlo despues.
 *
 *  Cuenta las veces en vez de agregar una fila por corrida: un choque aislado
 *  puede ser un error de un dia, pero si se repite todos los dias es que la
 *  cadena lo tiene mal cargado de verdad. */
async function anotarConflicto(
  sp: SourceProduct,
  ctx: { productId: string; ajeno: Dueno; chain: string },
): Promise<void> {
  await db.insert(eanConflictos)
    .values({
      ean13: sp.ean13!,
      productId: ctx.productId,
      chain: ctx.chain,
      externalId: sp.externalId,
      poseedorProductId: ctx.ajeno.id,
      nombreNuevo: sp.name,
      nombrePoseedor: ctx.ajeno.name,
    })
    .onConflictDoUpdate({
      target: [eanConflictos.ean13, eanConflictos.productId],
      set: { veces: sql`${eanConflictos.veces} + 1`, vistoEn: new Date() },
    });
}

export async function ensureStore(chain: string, name: string): Promise<string> {
  const slug = `${chain}-online`;
  const [existing] = await db.select({ id: stores.id }).from(stores).where(eq(stores.slug, slug));
  if (existing) return existing.id;

  const [created] = await db.insert(stores).values({ slug, chain, name }).returning({ id: stores.id });
  return created!.id;
}

/** Crea la cadena de categorias si no existe y devuelve el id de la hoja. */
async function ensureCategoryPath(path: string[]): Promise<string | null> {
  let parentId: string | null = null;
  let slugAcc = '';

  for (const name of path) {
    const segmento = toSlugSegment(name);
    slugAcc = slugAcc ? `${slugAcc}/${segmento}` : segmento;

    const [found] = await db.select({ id: categories.id }).from(categories)
      .where(eq(categories.slug, slugAcc));

    if (found) {
      parentId = found.id;
    } else {
      // Anotacion explicita: sin ella TS entra en inferencia circular, porque
      // parentId alimenta el insert del que sale su propio proximo valor.
      const creada: { id: string }[] = await db.insert(categories)
        .values({ slug: slugAcc, name, parentId })
        .returning({ id: categories.id });
      parentId = creada[0]!.id;
    }
  }
  return parentId;
}

export async function startRun(chain: string): Promise<string> {
  const [run] = await db.insert(scrapeRuns).values({ chain, status: 'running' })
    .returning({ id: scrapeRuns.id });
  return run!.id;
}

export async function finishRun(runId: string, itemsFound: number, error?: string): Promise<void> {
  await db.update(scrapeRuns)
    .set({
      status: error ? 'failed' : 'success',
      finishedAt: new Date(),
      itemsFound,
      errorMessage: error ?? null,
    })
    .where(eq(scrapeRuns.id, runId));
}

export interface PersistResult { created: boolean }

export async function persistProduct(
  sp: SourceProduct,
  ctx: { chain: string; storeId: string; runId: string },
): Promise<PersistResult> {
  // El payload crudo primero: si algo falla despues, el dato no se pierde.
  await db.insert(rawScrapeItems).values({
    scrapeRunId: ctx.runId,
    sourceUrl: sp.url,
    payload: sp.raw as Record<string, unknown>,
  });

  const categoryId = sp.categoryPath.length ? await ensureCategoryPath(sp.categoryPath) : null;

  const campos = {
    name: sp.name,
    normalizedName: toNormalizedName(sp.name),
    brand: sp.brand,
    categoryId,
    contentValue: sp.contentValue !== null ? String(sp.contentValue) : null,
    contentUnit: sp.contentUnit,
    isWeighted: sp.isWeighted,
    internalSku: sp.externalId,
    ean13: sp.ean13,
  };

  // 1. ¿Ya conocemos este producto en esta cadena?
  const [source] = await db.select({ productId: productSources.productId })
    .from(productSources)
    .where(and(eq(productSources.chain, ctx.chain), eq(productSources.externalId, sp.externalId)));

  let productId: string;
  let created = false;

  if (source) {
    productId = source.productId;

    // El EAN que manda la cadena puede pertenecer ya a otro producto nuestro:
    // pasa cuando una de ellas lo tiene mal cargado. Escribirlo violaria la
    // restriccion de unicidad y tiraria abajo el scrapeo entero, asi que nos
    // quedamos con el que ya teniamos y anotamos el choque para revisarlo.
    const ajeno = await duenoDelEan(sp.ean13, productId);
    if (ajeno) {
      await anotarConflicto(sp, { productId, ajeno, chain: ctx.chain });
      // Sin la columna, explicito: que se omita no puede depender de como
      // trate el ORM un undefined. Todo lo demas —nombre, precio, categoria—
      // se actualiza igual; lo unico que se ignora es el codigo dudoso.
      const { ean13: _dudoso, ...sinEan } = campos;
      await db.update(products).set(sinEan).where(eq(products.id, productId));
    } else {
      await db.update(products).set(campos).where(eq(products.id, productId));
    }
  } else {
    // 2. Si la fuente trae EAN, puede ser un producto que ya tenemos por otra cadena.
    const yaExiste = sp.ean13
      ? (await db.select({ id: products.id }).from(products).where(eq(products.ean13, sp.ean13)))[0]
      : undefined;

    if (yaExiste) {
      productId = yaExiste.id;
      await db.update(products).set(campos).where(eq(products.id, productId));
    } else {
      const [nuevo] = await db.insert(products).values(campos).returning({ id: products.id });
      productId = nuevo!.id;
      created = true;
    }

    await db.insert(productSources).values({
      productId, chain: ctx.chain, externalId: sp.externalId,
      url: sp.url, rawName: sp.name, lastSeenAt: new Date(),
    });
  }

  // url y rawName tambien se refrescan: si la fuente renombra un producto, o si
  // corregimos como armamos la URL, las filas viejas se ponen al dia solas.
  await db.update(productSources)
    .set({ lastSeenAt: new Date(), url: sp.url, rawName: sp.name })
    .where(and(eq(productSources.chain, ctx.chain), eq(productSources.externalId, sp.externalId)));

  // 3. Imagen. Va en tabla aparte porque no viaja en el sync Light: el
  //    celular baja primero el catalogo de texto, que es chico y sirve solo,
  //    y las fotos despues si las quiere.
  if (sp.imageUrl) {
    await db.insert(productMedia)
      .values({ productId, kind: 'thumbnail', url: sp.imageUrl })
      .onConflictDoNothing({ target: [productMedia.productId, productMedia.url] });
  }

  // 4. Historial: siempre se agrega, nunca se pisa.
  await db.insert(prices).values({
    productId, storeId: ctx.storeId,
    priceCents: sp.priceCents, promoCents: sp.promoCents, promoLabel: sp.promoLabel,
    scrapeRunId: ctx.runId,
  });

  // 5. Precio vigente: este si se pisa. El trigger le sube la revision.
  //
  // La etiqueta y la vigencia se escriben aca tambien, no solo en el historial.
  // Antes las dejaba intactas, asi que una promo terminada seguia figurando
  // como vigente hasta que algo la pisara: el producto volvia a su precio de
  // lista pero conservaba el cartel de oferta.
  await db.insert(currentPrices)
    .values({
      productId, storeId: ctx.storeId,
      priceCents: sp.priceCents, promoCents: sp.promoCents,
      promoLabel: sp.promoLabel, promoHasta: sp.promoHasta,
      promoDesde: sp.promoDesde,
    })
    .onConflictDoUpdate({
      target: [currentPrices.productId, currentPrices.storeId],
      set: {
        priceCents: sp.priceCents,
        promoCents: sp.promoCents,
        promoLabel: sp.promoLabel,
        promoHasta: sp.promoHasta,
        promoDesde: sp.promoDesde,
        updatedAt: new Date(),
        revision: sql`nextval('global_revision_seq')`,
      },
    });

  return { created };
}
