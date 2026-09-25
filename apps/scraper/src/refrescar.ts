import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { pool } from '@precios/db';
import { ADAPTERS } from './adapters/registro.js';
import { scrapearCadena, type Resultado } from './scrapear.js';

/** Refresco completo y desatendido: scrapea todas las cadenas, arma el
 *  snapshot y lo publica. Es lo que corre la tarea programada.
 *
 *  Pensado para correr solo, asi que no se rinde al primer tropiezo: si una
 *  cadena falla, las demas siguen y igual se publica. Precios de tres cadenas
 *  al dia valen mas que ninguno porque la cuarta estaba caida. */

const ejecutar = promisify(execFile);
const RAIZ = fileURLToPath(new URL('../../../', import.meta.url));

const hora = () => new Date().toLocaleTimeString('es-AR', { hour12: false });
const log = (msg: string) => console.log(`[${hora()}] ${msg}`);

async function correr(script: string): Promise<void> {
  const { stdout } = await ejecutar('npm', ['run', script], {
    cwd: RAIZ,
    maxBuffer: 32 * 1024 * 1024,
  });
  const ultima = stdout.trim().split('\n').filter(Boolean).at(-1);
  if (ultima) log(`  ${ultima.trim()}`);
}

async function main(): Promise<void> {
  const inicio = Date.now();
  log('Arranca el refresco');

  const resultados: Resultado[] = [];

  for (const [clave, crear] of Object.entries(ADAPTERS)) {
    const adapter = crear();
    log(`${clave}: scrapeando ${adapter.displayName}...`);

    // Sin callback por producto: en un log desatendido, 30.000 lineas por
    // corrida no ayudan a nadie y llenan el disco.
    const r = await scrapearCadena(adapter, Number.POSITIVE_INFINITY);
    resultados.push(r);

    const conFallidos = r.fallidos > 0 ? `, ${r.fallidos} descartados` : '';
    const espera = r.reintentos ? ` [${r.reintentos}]` : '';
    if (r.error) log(`${clave}: FALLO tras ${r.total} productos${espera} — ${r.error.slice(0, 120)}`);
    else log(`${clave}: ${r.total} productos (${r.creados} nuevos${conFallidos})${espera}`);
  }

  const vivas = resultados.filter((r) => !r.error);
  if (vivas.length === 0) {
    log('Ninguna cadena respondio: no se publica nada y queda el catalogo anterior.');
    process.exitCode = 1;
    return;
  }

  // Los codigos de barras en disputa se cuentan antes de soltar la base. Es lo
  // unico del refresco que pide una decision humana, asi que tiene que quedar
  // visible en el log en vez de solo acumularse en una tabla que nadie mira.
  const { rows: [conflictos] } = await pool.query<{ nuevos: string; total: string }>(
    `select count(*) filter (where visto_en > now() - interval '3 hours') nuevos,
            count(*) total
       from ean_conflictos where resuelto_en is null`,
  );
  if (Number(conflictos!.total) > 0) {
    log(
      `Codigos de barras en disputa: ${conflictos!.nuevos} nuevos, ` +
        `${conflictos!.total} sin resolver. Vealos con: npm run conflictos`,
    );
  }

  // La base ya esta actualizada; a partir de aca son pasos de publicacion.
  await pool.end();

  // Despues del scrapeo y antes del snapshot, siempre.
  //
  // Desde que el adapter lee `precio_anterior` y `existe_promo`, el scrapeo ya
  // marca las promociones de campaña por su cuenta. Este paso sigue porque es
  // el unico que publica la etiqueta ("- 25%", "Combo"): el listado por
  // categoria solo la trae en algunos casos.
  log('Buscando promociones de campaña...');
  await correr('promociones');

  // Los que el listado esconde por no tener stock online. Siguen en la gondola
  // y siguen cambiando de precio, asi que sin esto quedan congelados en el
  // ultimo dia que tuvieron stock, promo incluida. Va despues de promociones
  // para no repescar lo que aquel ya refresco.
  log('Repescando los que se cayeron del listado...');
  await correr('repechaje');

  log('Emparejando productos entre cadenas...');
  await correr('match');
  await correr('apply');

  log('Generando el snapshot...');
  await correr('snapshot');

  log('Publicando...');
  await correr('publicar');

  log('Podando payloads viejos...');
  await correr('prune');

  const minutos = Math.round((Date.now() - inicio) / 60000);
  const fallaron = resultados.filter((r) => r.error).map((r) => r.cadena);
  log(`Listo en ${minutos} minutos.${fallaron.length ? ` Fallaron: ${fallaron.join(', ')}.` : ''}`);
}

try {
  await main();
} catch (err) {
  log(`Error inesperado: ${String(err)}`);
  process.exitCode = 1;
} finally {
  // Si main corto antes de cerrarlo, que no quede el proceso colgado.
  await pool.end().catch(() => {});
}
