import { VtexAdapter } from './vtex.js';

/** Carrefour vende de todo: electro, hogar, jugueteria, indumentaria y
 *  automotor suman ~63.000 articulos que no tienen nada que ver con el
 *  changuito ni cruzan con el catalogo de La Coope. Nos quedamos con los
 *  rubros de supermercado. */
const RAICES_SUPERMERCADO = [
  161, // Almacén
  222, // Desayuno y merienda
  255, // Bebidas
  292, // Lácteos y productos frescos
  321, // Carnes y pescados
  330, // Frutas y verduras
  336, // Panadería
  347, // Congelados
  359, // Limpieza
  402, // Perfumería y farmacia
  451, // Mundo Bebé
  471, // Mascotas
];

export class CarrefourAdapter extends VtexAdapter {
  /** Se le puede pasar un subconjunto de raices para cortar el catalogo en
   *  varias corridas: cada una es corta y se puede repetir sola si falla. */
  constructor(raices: number[] = RAICES_SUPERMERCADO) {
    super({
      chain: 'carrefour',
      displayName: 'Carrefour',
      host: 'www.carrefour.com.ar',
      raices,
    });
  }
}
