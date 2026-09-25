import { CoopeAdapter } from './coope.js';

/** La tienda de hogar de la misma cooperativa: bazar, textil, electro,
 *  herramientas. Catalogo online aparte, pero se vende en las mismas
 *  sucursales fisicas que el super.
 *
 *  Por eso comparte `chain` con CooperativaAdapter: para el que esta parado en
 *  el hipermercado es un solo lugar y un solo total. Y no es solo una decision
 *  de presentacion: cod_interno es el SKU de la cooperativa, compartido entre
 *  ambos catalogos —84 articulos figuran en los dos con el mismo codigo y el
 *  mismo nombre—, asi que separarlos los duplicaria. */
export class CoopeHogarAdapter extends CoopeAdapter {
  constructor() {
    super({
      chain: 'cooperativa_obrera',
      displayName: 'Cooperativa Obrera',
      api: 'https://api.coopehogar.coop/api',
      web: 'www.coopehogar.coop',
    });
  }
}
