import { CoopeAdapter } from './coope.js';

/** El supermercado: almacen, frescos, bebidas, perfumeria, limpieza. */
export class CooperativaAdapter extends CoopeAdapter {
  constructor() {
    super({
      chain: 'cooperativa_obrera',
      displayName: 'Cooperativa Obrera',
      api: 'https://api.lacoopeencasa.coop/api',
      web: 'www.lacoopeencasa.coop',
    });
  }
}
