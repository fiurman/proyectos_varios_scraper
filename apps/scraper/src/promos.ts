import '@precios/db/env';
import { pool, db, promosBancarias } from '@precios/db';
import { and, eq, notInArray, sql } from 'drizzle-orm';
import { traer } from './traer.js';

/** Promociones bancarias de La Coope.
 *
 *  No hay API: la pagina lista los bancos como imagenes y cada uno tiene una
 *  subpagina con el texto de la promo. De ahi se saca todo.
 *
 *  Al ser HTML, es fragil por definicion: el dia que rediseñen la pagina esto
 *  deja de encontrar lo que busca. Por eso falla ruidosamente y nunca a medias:
 *  una promo que no se puede leer entera no se guarda, porque un reintegro mal
 *  leido es peor que uno ausente — el ausente se nota, el equivocado no.
 *
 *  npm run promos           las baja y guarda
 *  npm run promos -- ver    las muestra sin tocar la base */
const BASE = 'https://www.cooperativaobrera.coop';
const INDICE = `${BASE}/financiacion-y-promos-bancarias`;
const UA = 'precios-varios/0.1 (proyecto personal de comparacion de precios)';
const DELAY_MS = 1500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DIAS: Record<string, number> = {
  domingo: 0, domingos: 0, lunes: 1, martes: 2,
  miercoles: 3, jueves: 4, viernes: 5, sabado: 6, sabados: 6,
};
const NOMBRE_DIA = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

const sinTildes = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

async function bajar(url: string): Promise<string> {
  const res = await traer(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${url} respondio HTTP ${res.status}`);
  return res.text();
}

/** El texto visible, sin etiquetas ni scripts y con los espacios normalizados. */
function aTexto(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Los rubros que las cadenas nombran al excluir, normalizados a un vocabulario
 *  nuestro. La izquierda es lo que escriben ellos; la derecha, con que lo
 *  cruzamos despues contra las categorias del catalogo. */
const RUBROS: [RegExp, string][] = [
  [/art[ií]culos? (?:del? )?hogar/i, 'hogar'],
  [/tecnolog[ií]a/i, 'tecnologia'],
  [/cortes de carne|carnes rojas|pollos?\b/i, 'carne'],
  [/pescados?|pescader[ií]a/i, 'pescado'],
  [/\bbazar\b/i, 'bazar'],
  [/\btextil(?:es)?\b|\btienda\b/i, 'textil'],
  [/regaler[ií]a/i, 'regaleria'],
];

/** La frase que enumera lo excluido.
 *
 *  Viene de dos formas: una pregunta propia ("¿Que rubros estan excluidos?") o
 *  un "excepto" metido adentro de la de incluidos, que es como lo escribe La
 *  Pampa. Si no aparece ninguna, devolvemos null y no se calcula nada: suponer
 *  que no excluye nada infla el reintegro que le prometemos al usuario. */
function fraseExcluidos(t: string): string | null {
  const propia = /rubros est[aá]n excluidos[^?]*\?\s*([^¿]{0,300})/i.exec(t);
  if (propia) return propia[1]!.split(/Otras condiciones/i)[0]!.trim();

  const dentro = /rubros est[aá]n incluidos[^?]*\?\s*([^¿]{0,300})/i.exec(t);
  const excepto = dentro && /\bexcepto\b(.{0,260})/i.exec(dentro[1]!);
  if (excepto) return excepto[1]!.split(/Otras condiciones/i)[0]!.trim();

  return null;
}

export interface Promo {
  slug: string;
  banco: string;
  porcentaje: number | null;
  porcentajeMin: number;
  porcentajeMax: number;
  dias: number[];
  topeCents: number | null;
  topeMensual: boolean;
  topePeriodo: string | null;
  excluye: string[] | null;
  excluyeTexto: string | null;
  mediosPago: string | null;
  soloOnline: boolean;
  texto: string;
  condiciones: string | null;
  url: string;
}

/** "$15.000" -> 1500000 centavos. */
function aCentavos(monto: string): number {
  return Math.round(Number(monto.replace(/\./g, '').replace(',', '.')) * 100);
}

export function extraer(slug: string, html: string): Promo | null {
  const t = aTexto(html);

  // El titulo va entre "Promo Banco X" y el bloque de preguntas frecuentes.
  const m = /Promo Banco\s+(.{0,160}?)\s*PREGUNTAS FRECUENTES/i.exec(t);
  if (!m) return null;
  const titulo = m[1]!.trim();

  const pcts = [...titulo.matchAll(/(\d{1,2})\s?%/g)].map((x) => Number(x[1]));
  if (pcts.length === 0) return null;

  const plano = sinTildes(titulo);
  const dias = [
    ...new Set(
      [...plano.matchAll(/lunes|martes|miercoles|jueves|viernes|sabados?|domingos?/g)]
        .map((x) => DIAS[x[0]]!)
    ),
  ].sort();
  if (dias.length === 0) return null;

  const tope = /tope de reintegro(\s+mensual)?\s+es de\s*\$\s?([\d.,]+)([^.]{0,40})/i.exec(t);

  // El periodo se muestra, no se calcula: no hay forma de saber cuanto de un
  // tope semanal o mensual ya se consumio, asi que el monto que mostramos es
  // siempre el de esta compra.
  const cola = `${tope?.[1] ?? ''} ${tope?.[3] ?? ''}`;
  const periodo = /por semana/i.test(cola) ? 'semana'
    : /mensual|por mes/i.test(cola) ? 'mes'
    : /por (?:martes|lunes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|d[ií]a)/i.test(cola) ? 'dia'
    : /por compra/i.test(cola) ? 'compra'
    // Que no lo diga no significa "por compra": es el supuesto optimista, y
    // mostrarlo como tal prometeria un tope que se renueva en cada visita.
    : null;

  const fraseEx = fraseExcluidos(t);
  const excluye = fraseEx === null
    ? null
    : [...new Set(RUBROS.filter(([re]) => re.test(fraseEx)).map(([, k]) => k))];

  const pago = /(?:tarjetas puedo pagar|medios de pago puedo utilizar)[^?]*\?\s*([^¿]{0,300})/i
    .exec(t)?.[1]?.split(/Otras condiciones/i)[0]?.trim() ?? null;

  // "Aplica a pedidos online en ..." sin mencionar sucursales fisicas: la promo
  // no sirve caminando la gondola, que es justo para lo que existe el changuito.
  const mencionaOnline = /aplica a pedidos online/i.test(t);
  const mencionaFisico = /sucursales? f[ií]sicas?|locales adheridos|en la caja/i.test(t);
  const soloOnline = mencionaOnline && !mencionaFisico;

  // Un solo porcentaje repetido ("30% los martes y 30% los viernes") sigue
  // siendo una promo de un numero. Varios distintos significan que hay
  // condiciones que deciden cual te toca, y ahi no hay un valor honesto.
  const unicos = [...new Set(pcts)];

  return {
    slug,
    banco: titulo.split(/\s+\d{1,2}\s?%/)[0]!.trim() || slug,
    porcentaje: unicos.length === 1 ? unicos[0]! : null,
    porcentajeMin: Math.min(...pcts),
    porcentajeMax: Math.max(...pcts),
    dias,
    topeCents: tope ? aCentavos(tope[2]!) : null,
    topeMensual: periodo === 'mes',
    topePeriodo: periodo,
    excluye,
    excluyeTexto: fraseEx,
    mediosPago: pago,
    soloOnline,
    texto: titulo,
    condiciones: (/PREGUNTAS FRECUENTES\s*(.{0,1800})/i.exec(t)?.[1] ?? null),
    url: `${INDICE}/${slug}`,
  };
}

async function main(): Promise<void> {
  const soloVer = (process.argv[2] ?? '') === 'ver';

  const indice = await bajar(INDICE);
  const slugs = [...new Set(
    [...indice.matchAll(/\/financiacion-y-promos-bancarias\/([a-z0-9-]+)/g)].map((m) => m[1]!),
  )].sort();

  if (slugs.length === 0) {
    console.error('No encontre ningun banco en el indice. ¿Cambio la pagina?');
    process.exitCode = 1;
    return;
  }
  console.log(`${slugs.length} bancos en el indice.\n`);

  const promos: Promo[] = [];
  const fallaron: string[] = [];

  for (const slug of slugs) {
    await sleep(DELAY_MS);
    try {
      const p = extraer(slug, await bajar(`${INDICE}/${slug}`));
      if (!p) { fallaron.push(slug); continue; }
      promos.push(p);

      const rango = p.porcentaje !== null ? `${p.porcentaje}%` : `${p.porcentajeMin}-${p.porcentajeMax}%`;
      const tope = p.topeCents
        ? `tope $${(p.topeCents / 100).toLocaleString('es-AR')}/${p.topePeriodo ?? '?'}`
        : 'sin tope';
      const ex = p.excluye === null ? 'SIN LEER' : (p.excluye.join(',') || 'nada');
      console.log(`  ${rango.padStart(7)}  ${p.banco.slice(0, 20).padEnd(22)} ${p.dias.map((d) => NOMBRE_DIA[d]).join(',').padEnd(30)} ${tope.padEnd(22)} excluye: ${ex}${p.soloOnline ? '  [SOLO ONLINE]' : ''}`);
    } catch (err) {
      fallaron.push(slug);
      console.warn(`  ! ${slug}: ${String(err).slice(0, 90)}`);
    }
  }

  if (fallaron.length > 0) {
    console.warn(`\n! ${fallaron.length} sin poder leer: ${fallaron.join(', ')}`);
    console.warn('  Si son todos, lo mas probable es que hayan rediseñado la pagina.');
  }

  if (soloVer) { console.log('\n(modo ver: no se toco la base)'); return; }
  if (promos.length === 0) {
    console.error('\nNinguna promo legible: no se guarda nada y queda lo anterior.');
    process.exitCode = 1;
    return;
  }

  for (const p of promos) {
    await db.insert(promosBancarias).values({
      chain: 'cooperativa_obrera', ...p, activa: true,
    }).onConflictDoUpdate({
      target: [promosBancarias.chain, promosBancarias.slug],
      set: {
        banco: p.banco, porcentaje: p.porcentaje,
        porcentajeMin: p.porcentajeMin, porcentajeMax: p.porcentajeMax,
        dias: p.dias, topeCents: p.topeCents, topeMensual: p.topeMensual,
        topePeriodo: p.topePeriodo, excluye: p.excluye, excluyeTexto: p.excluyeTexto,
        mediosPago: p.mediosPago, soloOnline: p.soloOnline,
        texto: p.texto, condiciones: p.condiciones, url: p.url,
        activa: true, vistaEn: sql`now()`, updatedAt: sql`now()`,
      },
    });
  }

  // Las que ya no estan en la pagina se marcan, no se borran: asi una caida del
  // scraper no vacia la pantalla y queda el historial de lo que hubo.
  const vivos = promos.map((p) => p.slug);
  const bajas = await db.update(promosBancarias)
    .set({ activa: false, updatedAt: sql`now()` })
    .where(and(
      eq(promosBancarias.chain, 'cooperativa_obrera'),
      eq(promosBancarias.activa, true),
      notInArray(promosBancarias.slug, vivos),
    ))
    .returning({ slug: promosBancarias.slug });

  console.log(`\nGuardadas ${promos.length} promos.${bajas.length ? ` ${bajas.length} dadas de baja: ${bajas.map((b) => b.slug).join(', ')}.` : ''}`);
}

try {
  await main();
} finally {
  await pool.end();
}
