import { pgTable, uuid, text, integer, smallint, boolean, timestamp, unique, index } from 'drizzle-orm/pg-core';

/** Promociones bancarias de cada cadena: reintegros por dia de la semana.
 *
 *  En Argentina el banco cambia el precio final mas que la gondola. Un 30% de
 *  reintegro sobre una compra de $45.000 son $13.500, mucho mas de lo que se
 *  gana eligiendo donde comprar. Sin esto, el changuito calcula bien un numero
 *  que despues no es el que termina saliendo la compra.
 *
 *  El dato no viene de una API: se extrae del HTML de cada banco, asi que es
 *  fragil por naturaleza. Por eso se guarda `texto` con el titulo original — si
 *  el parser un dia lee mal el porcentaje, queda la frase de la que salio para
 *  poder auditarla. */
export const promosBancarias = pgTable(
  'promos_bancarias',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Donde aplica: 'cooperativa_obrera', 'carrefour', ... */
    chain: text('chain').notNull(),

    /** Identificador estable dentro de la cadena, sacado de la URL:
     *  'banco-credicoop'. Es lo que permite reconocer la misma promo entre
     *  corridas en vez de duplicarla. */
    slug: text('slug').notNull(),
    banco: text('banco').notNull(),

    /** El reintegro principal. Null cuando la promo tiene variantes y no hay un
     *  numero unico honesto que mostrar (Patagonia: "30%, 20% o 15%"). */
    porcentaje: integer('porcentaje'),

    /** El rango, cuando hay variantes. Iguales al principal si no las hay. */
    porcentajeMin: integer('porcentaje_min'),
    porcentajeMax: integer('porcentaje_max'),

    /** Dias de la semana en que aplica, formato de JS: domingo 0, sabado 6. */
    dias: smallint('dias').array().notNull(),

    /** Tope de reintegro en centavos. Null si la promo no declara ninguno.
     *  Sin esto el ahorro que mostremos seria mentira en las compras grandes. */
    topeCents: integer('tope_cents'),
    /** Si el tope es por mes y no por compra. Cambia por completo lo que se
     *  puede prometer: un tope mensual ya puede estar consumido. */
    topeMensual: boolean('tope_mensual').notNull().default(false),

    /** Rubros que la promo deja afuera, en vocabulario propio: 'carne',
     *  'pescado', 'hogar', 'tecnologia', 'bazar', 'textil', 'regaleria'.
     *
     *  Vacio significa "no excluye nada"; null, "no pudimos leerlo". La
     *  diferencia importa: sobre null no se calcula ningun monto, porque
     *  suponer que no excluye nada infla el reintegro que prometemos. */
    excluye: text('excluye').array(),
    /** La frase de la que salieron los rubros, para poder auditarla. */
    excluyeTexto: text('excluye_texto'),

    /** Con que se paga. No lo usamos para calcular —no sabemos con que tarjeta
     *  vas a pagar— pero sin comunicarlo el reintegro no se cobra. */
    mediosPago: text('medios_pago'),

    /** La promo aplica solo a pedidos online. Cambia si sirve caminando el
     *  super, que es para lo que existe el changuito. */
    soloOnline: boolean('solo_online').notNull().default(false),

    /** 'compra', 'dia', 'semana' o 'mes'. Solo para mostrar: el calculo es
     *  siempre por compra, porque no hay forma de saber cuanto del tope
     *  acumulado ya se consumio. */
    topePeriodo: text('tope_periodo'),

    /** La frase original de la que se extrajo todo, para poder auditarla. */
    texto: text('texto').notNull(),
    /** Las preguntas frecuentes, que son las condiciones en prosa. */
    condiciones: text('condiciones'),
    url: text('url').notNull(),

    /** Una promo que deja de aparecer en la pagina no se borra: se marca. Asi
     *  el historial queda y una caida del scraper no vacia la pantalla. */
    activa: boolean('activa').notNull().default(true),
    vistaEn: timestamp('vista_en', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_promo_cadena_slug').on(t.chain, t.slug),
    index('idx_promos_activas').on(t.chain, t.activa),
  ],
);
