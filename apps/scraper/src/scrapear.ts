import type { ChainAdapter } from './adapters/types.js';
import { ensureStore, startRun, finishRun, persistProduct } from './persist.js';
import { reiniciarReintentos, resumenReintentos } from './reintentos.js';

export interface Resultado {
  cadena: string;
  total: number;
  creados: number;
  /** Productos sueltos que no se pudieron guardar. No cortan la corrida. */
  fallidos: number;
  /** Solo para lo que si es terminal: la base caida, la API que no vuelve. */
  error?: string;
  /** "312 reintentos, 14 min esperando", o vacio si no fallo ningun pedido.
   *  Sin esto no habia forma de saber cuanto de una corrida larga es trabajo y
   *  cuanto es esperar a que el otro lado nos deje de frenar. */
  reintentos: string;
}

/** El ciclo de scrapeo de una cadena, sin nada de linea de comandos.
 *
 *  Lo comparten el comando manual y el refresco automatico: si cambia la forma
 *  de persistir o de cerrar una corrida, cambia en un solo lugar. */
export async function scrapearCadena(
  adapter: ChainAdapter,
  limite: number,
  alProducto?: (n: number, nombre: string, nuevo: boolean) => void,
): Promise<Resultado> {
  const storeId = await ensureStore(adapter.chain, adapter.displayName);
  const runId = await startRun(adapter.chain);

  // El contador es global y se scrapea de a una cadena por vez: se pone en cero
  // aca para que el numero sea el de esta cadena y no el acumulado del refresco.
  reiniciarReintentos();

  let total = 0;
  let creados = 0;
  let fallidos = 0;

  try {
    for await (const sp of adapter.fetchProducts({ limit: limite })) {
      // Cada producto en su propio try: un registro que las cadenas cargaron
      // mal no puede cancelar los diez mil que vienen atras. Antes esto estaba
      // afuera del ciclo y un solo EAN repetido mataba la cadena entera.
      try {
        const { created } = await persistProduct(sp, { chain: adapter.chain, storeId, runId });
        total++;
        if (created) creados++;
        alProducto?.(total, sp.name, created);
      } catch (err) {
        fallidos++;
        console.warn(`  ! no se pudo guardar "${sp.name.slice(0, 44)}": ${String(err).slice(0, 110)}`);
      }
    }
    await finishRun(runId, total);
    return { cadena: adapter.displayName, total, creados, fallidos, reintentos: resumenReintentos() };
  } catch (err) {
    // Aca solo llega lo terminal: la conexion a la base que se corta, o el
    // adapter que se queda sin poder seguir recorriendo.
    //
    // La corrida queda marcada como fallida en la base, no colgada en
    // "running": asi el podador sabe despues que puede limpiarla.
    await finishRun(runId, total, String(err));
    return {
      cadena: adapter.displayName, total, creados, fallidos,
      error: String(err), reintentos: resumenReintentos(),
    };
  }
}
