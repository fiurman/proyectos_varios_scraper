import { pool } from '@precios/db';
import { ADAPTERS, ADAPTERS_EXTRA, ADAPTERS_MANUALES } from './adapters/registro.js';

// A mano se puede correr cualquiera, incluidas las que quedaron fuera del
// refresco automatico.
const TODOS = { ...ADAPTERS, ...ADAPTERS_EXTRA, ...ADAPTERS_MANUALES };
import { scrapearCadena } from './scrapear.js';

// npm run scrape -- [cadena] [limite] [raices]
//   npm run scrape -- 20                        los primeros 20 de La Coope
//   npm run scrape -- disco todo                el catalogo entero de Disco
//   npm run scrape -- carrefour todo 161,222    solo esas dos raices

const args = process.argv.slice(2);
const clave = args[0] !== undefined && args[0] in TODOS ? args.shift()! : 'coope';
const pedido = args[0] ?? '20';
const limit =
  pedido === 'todo' || pedido === 'all' ? Number.POSITIVE_INFINITY : Number(pedido);

// Lista de ids separada por comas: parte el catalogo en corridas mas cortas.
const raices = args[1]
  ? args[1].split(',').map((n) => Number(n.trim())).filter(Number.isFinite)
  : undefined;

const adapter = TODOS[clave]!(raices);

console.log(
  `Scrapeando ${adapter.displayName} (limite: ${limit === Infinity ? 'catalogo completo' : limit})\n`,
);

const { total, creados, error, reintentos } = await scrapearCadena(adapter, limit, (n, nombre, nuevo) => {
  console.log(`${String(n).padStart(4)}. ${nuevo ? '+' : '·'}  ${nombre.slice(0, 54)}`);
});

if (error) {
  console.error('\nFallo el scrapeo:', error);
  process.exitCode = 1;
} else {
  console.log(`\nListo: ${total} productos (${creados} nuevos, ${total - creados} actualizados).`);
  // El tiempo perdido reintentando explica corridas largas que de otro modo
  // parecen lentitud nuestra.
  if (reintentos) console.log(`Reintentos: ${reintentos}.`);
}

await pool.end();
