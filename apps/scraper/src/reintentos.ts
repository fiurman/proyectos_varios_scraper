/** Cuenta los reintentos de la corrida en curso.
 *
 *  Existe porque el tiempo que se pierde reintentando era invisible: cuando una
 *  cadena nos limita, cada pedido fallido se come hasta medio minuto de esperas
 *  y en el log no quedaba ni rastro. Disco tardaba tres horas y no habia forma
 *  de saber cuanto de eso era trabajo y cuanto era esperar.
 *
 *  Es estado global a proposito: las cadenas se scrapean de a una, y pasar un
 *  contador por las seis capas que hay entre el orquestador y el fetch seria
 *  mucho ruido para un numero que se mira una vez por corrida. */
export interface Reintentos {
  veces: number;
  msPerdidos: number;
}

const actual: Reintentos = { veces: 0, msPerdidos: 0 };

export function anotarReintento(esperaMs: number): void {
  actual.veces++;
  actual.msPerdidos += esperaMs;
}

export function reiniciarReintentos(): void {
  actual.veces = 0;
  actual.msPerdidos = 0;
}

export function leerReintentos(): Reintentos {
  return { ...actual };
}

/** "312 reintentos, 14 min perdidos", o cadena vacia si no hubo ninguno. */
export function resumenReintentos(): string {
  if (actual.veces === 0) return '';
  const seg = Math.round(actual.msPerdidos / 1000);
  const tiempo = seg >= 90 ? `${Math.round(seg / 60)} min` : `${seg}s`;
  return `${actual.veces} reintentos, ${tiempo} esperando`;
}
