import { pgTable, text, jsonb, timestamp } from 'drizzle-orm/pg-core';

/** Memoria chica del scraper entre corridas.
 *
 *  Existe por un problema concreto. Las campañas de promociones de La Coope se
 *  piden por un id que rota y no tiene indice, asi que hay que barrer un rango.
 *  Ese rango estaba escrito a mano en el codigo (`SEMILLA = 82844`), y los ids
 *  siguieron avanzando: medido el 2026-10-02, las campañas vivas estaban entre
 *  83090 y 83345, o sea 216 ids mas alla del final de la ventana. El barrido no
 *  encontraba nada, y eso tiraba abajo el refresco entero.
 *
 *  Una constante en el codigo no puede seguir algo que se mueve solo. Guardando
 *  aca el ultimo id vivo que vimos, la ventana se corre con las campañas y no
 *  hay que acordarse de actualizar un numero cada tanto.
 *
 *  Clave y valor sueltos y no una columna por cosa: lo que se guarda son
 *  marcadores de posicion del scraper, no datos del catalogo. Una tabla por cada
 *  uno seria una migracion por cada vez que algo necesita recordar algo. */
export const estadoScraper = pgTable('estado_scraper', {
  /** Nombre del marcador: 'promo_ids_coope'. */
  clave: text('clave').primaryKey(),

  /** El valor, libre. Para las campañas es `{ vivos: number[], visto: string }`.
   *
   *  Se guardan TODOS los ids vivos y no solo el mayor: si el mayor resulta ser
   *  una campaña de dos articulos que se termina manana, el barrido del dia
   *  siguiente arrancaria de ahi y perderia la grande que esta mas abajo. */
  valor: jsonb('valor').notNull(),

  actualizadoEn: timestamp('actualizado_en', { withTimezone: true })
    .notNull().defaultNow(),
});
