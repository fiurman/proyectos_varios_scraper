import type { ChainAdapter } from './types.js';
import { CooperativaAdapter } from './cooperativa.js';
import { DiscoAdapter } from './disco.js';
import { CarrefourAdapter } from './carrefour.js';
import { CoopeHogarAdapter } from './coopehogar.js';
import { CoopeWebAdapter } from './coope-web.js';
import { ChangoMasAdapter } from './chango.js';

/** Las cadenas que sabemos scrapear, por su nombre corto en la linea de
 *  comandos. Un solo lugar: si mañana se suma Jumbo, se agrega aca y aparece
 *  tanto en el scrapeo manual como en el refresco automatico. */
export const ADAPTERS: Record<string, (raices?: number[]) => ChainAdapter> = {
  coope: () => new CooperativaAdapter(),
  hogar: () => new CoopeHogarAdapter(),
  carrefour: (raices) => new CarrefourAdapter(raices),
  chango: () => new ChangoMasAdapter(),
};

/** Quedan a mano, no entran en el refresco automatico. */
export const ADAPTERS_EXTRA: Record<string, () => ChainAdapter> = {
  /** La Coope navegada con Chromium, en vez de pidiendole a su API.
   *
   *  No es el titular porque todavia trae menos: 5.770 contra 6.145, y tarda
   *  56 minutos contra 17. Medido producto por producto, no solo en total: de
   *  los suyos, 5.758 los trae tambien el otro y solo 12 son exclusivos, asi
   *  que correr los dos no paga la hora que cuesta.
   *
   *  Se queda igual porque fue el que encontro como se pagina de verdad este
   *  sitio —`cant_articulos` es el desplazamiento, no el tamaño de pagina— y
   *  porque le falta una sola cosa para ganar: el respaldo por marca no
   *  encuentra los enlaces del filtro lateral en el DOM. */
  coopeweb: () => new CoopeWebAdapter(),
};

/** Cadenas que sabemos scrapear pero que no entran en el refresco automatico.
 *
 *  Disco no tiene sucursales en Bahia Blanca: son 10.500 productos y las tres
 *  horas mas caras de la corrida, de un super al que no se puede entrar a
 *  comprar. El changuito existe para saber cuanto vas a pagar caminando la
 *  gondola, y para eso un precio de una cadena ausente no sirve.
 *
 *  Queda disponible a mano —`npm run scrape -- disco`— por si algun dia abre
 *  una sucursal o interesa como referencia de precios online. */
export const ADAPTERS_MANUALES: Record<string, (raices?: number[]) => ChainAdapter> = {
  disco: (raices) => new DiscoAdapter(raices),
};
