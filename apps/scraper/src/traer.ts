/** `fetch` con limite de tiempo.
 *
 *  Node no le pone ninguno. Un servidor que acepta la conexion y despues se
 *  queda mudo deja el pedido esperando para siempre, y con el todo el refresco.
 *
 *  No es teorico: el 2026-09-20 el scrapeo de La Coope quedo 24 horas colgado
 *  en un solo pedido. Se llevo puesto el candado, asi que ninguna de las
 *  corridas siguientes pudo arrancar, y el catalogo no se actualizo hasta el
 *  dia siguiente. El `timeout` de cinco horas del script tampoco lo salvo.
 *
 *  El limite es por pedido, no por corrida: si uno se cuelga, muere ese y los
 *  reintentos que ya tiene cada adapter se encargan del resto. Una corrida
 *  entera puede tardar una hora sin que ningun pedido pase de un minuto. */
export const TIMEOUT_MS = 45_000;

export function traer(url: string, init: RequestInit = {}, ms = TIMEOUT_MS): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}
