import { VtexAdapter } from './vtex.js';

/** Las raices que van al changuito.
 *
 *  Se recorta porque Disco publica el catalogo entero de un hipermercado y era
 *  el 75% del refresco: tres horas de las cuatro. Quedan afuera Electro,
 *  Tiempo Libre (jugueteria y libreria) y Mundo Bebe, mas cuatro categorias
 *  basura que la propia cadena dejo sueltas. */
const RAICES = [
  1,   // Almacen
  2,   // Bebidas
  3,   // Frutas y Verduras
  4,   // Carnes
  5,   // Pescados y Mariscos
  6,   // Quesos y Fiambres
  7,   // Lacteos
  8,   // Congelados
  9,   // Panaderia y Pasteleria
  10,  // Rotiseria
  11,  // Perfumeria
  13,  // Limpieza
  14,  // Mascotas
  16,  // Hogar y textil — entra podada, ver ABAJO
  271, // Panaderia
  463, // Pastas Frescas
];

/** Ramas de "Hogar y textil" que no son changuito.
 *
 *  La raiz entera no sirve ni para dejarla ni para sacarla: adentro conviven
 *  repasadores, ollas, sabanas y toallas —que si se comparan con Coope Hogar—
 *  con ropa interior, calzado y guardapolvos, que no. Ademas Indumentaria es de
 *  las mas caras de recorrer: sus categorias traen miles de articulos sin
 *  precio. Quedan Cocina, Mesa, Ropa de Cama, Baño, Organizacion y Colchones. */
const EXCLUIR = [
  478, // Indumentaria
  127, // Ferreteria
  126, // Automotor
  420, // Muebles
  418, // Decoracion
  417, // Cotillon
];

export class DiscoAdapter extends VtexAdapter {
  constructor(raices?: number[]) {
    super({
      chain: 'disco',
      displayName: 'Disco',
      host: 'www.disco.com.ar',
      raices: raices ?? RAICES,
      excluir: EXCLUIR,
    });
  }
}
