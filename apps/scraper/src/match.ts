import { sql } from 'drizzle-orm';
import { db, pool, productMatches } from '@precios/db';
import { contenidoBase, contencion, nameTokens, toNormalizedName } from './normalize.js';

/** Empareja los productos de una cadena sin EAN contra los de otra que si lo
 *  publica. No toca products: escribe candidatos en product_matches con su
 *  score, para revisar y aplicar aparte. */

const SIN_EAN = 'cooperativa_obrera';

/** Cuanto puede diferir el gramaje y seguir siendo el mismo producto. Cubre el
 *  redondeo de "0.29 kg" contra "290 grs", no un envase distinto. */
const TOLERANCIA = 0.02;

/** Con gramaje coincidente el nombre puede ser mas laxo; sin el, es lo unico
 *  que queda y hay que exigirle bastante mas.
 *
 *  Los numeros salen de medir contra 4.384 pares verificados por codigo de
 *  barras y 6.000 pares de productos distintos de la misma marca y gramaje.
 *  Con contencion, el 0.80 encuentra el 63% de los verdaderos y se cuela el
 *  5,5%; subirlo a 0.90 baja el error a 2,8% pero pierde cinco puntos de
 *  cobertura. Se eligio el punto mas agresivo a proposito. */
const UMBRAL = {
  conGramaje: { auto: 0.8, pendiente: 0.55 },
  sinGramaje: { auto: 0.95, pendiente: 0.75 },
};

interface Fila {
  id: string;
  name: string;
  brand: string | null;
  ean13: string | null;
  contentValue: string | null;
  contentUnit: string | null;
}

/** Los productos de una cadena que todavia no tienen codigo de barras. */
async function traerSinEan(chain: string): Promise<Fila[]> {
  const { rows } = await pool.query<Fila>(
    `select p.id, p.name, p.brand, p.ean13,
            p.content_value as "contentValue", p.content_unit as "contentUnit"
       from products p
       join product_sources s on s.product_id = p.id
      where s.chain = $1 and p.deleted_at is null
        and p.brand is not null and p.ean13 is null`,
    [chain],
  );
  return rows;
}

/** Todo lo que tenga EAN, venga de la cadena que venga. Los productos que
 *  comparten codigo entre cadenas ya son una sola fila, asi que preguntar por
 *  cadena aca no tendria sentido: se buscarian dos veces los mismos. */
async function traerConEan(): Promise<Fila[]> {
  const { rows } = await pool.query<Fila>(
    `select p.id, p.name, p.brand, p.ean13,
            p.content_value as "contentValue", p.content_unit as "contentUnit"
       from products p
      where p.deleted_at is null and p.brand is not null and p.ean13 is not null`,
  );
  return rows;
}

const claveMarca = (b: string | null) => toNormalizedName(b ?? '');

async function main(): Promise<void> {
  const izquierda = await traerSinEan(SIN_EAN);
  const derecha = await traerConEan();

  console.log(`Emparejando ${izquierda.length} productos sin EAN contra ${derecha.length} con EAN.\n`);

  // La marca es el ancla: sin ella el espacio de comparacion es inmanejable y
  // el nombre solo no alcanza para decidir.
  const porMarca = new Map<string, Fila[]>();
  for (const d of derecha) {
    const k = claveMarca(d.brand);
    if (!k) continue;
    const lista = porMarca.get(k);
    if (lista) lista.push(d);
    else porMarca.set(k, [d]);
  }

  const aGuardar: {
    productId: string; matchProductId: string; ean13: string | null;
    score: string; strategy: string; status: string;
  }[] = [];

  let sinMarcaEnLaOtra = 0;
  let descartados = 0;

  for (const c of izquierda) {
    const candidatos = porMarca.get(claveMarca(c.brand));
    if (!candidatos) { sinMarcaEnLaOtra++; continue; }

    const tokensC = nameTokens(c.name, c.brand);
    const contC = contenidoBase(c.contentValue, c.contentUnit);

    let mejor: { fila: Fila; score: number; conGramaje: boolean } | null = null;

    for (const d of candidatos) {
      const contD = contenidoBase(d.contentValue, d.contentUnit);

      // Si los dos declaran contenido en la misma unidad, tiene que coincidir:
      // es el unico dato objetivo que tenemos y un envase distinto es otro EAN.
      let conGramaje = false;
      if (contC && contD && contC.unidad === contD.unidad) {
        const diff = Math.abs(contC.valor - contD.valor) / Math.max(contC.valor, contD.valor);
        if (diff > TOLERANCIA) continue;
        conGramaje = true;
      }

      const score = contencion(tokensC, nameTokens(d.name, d.brand));
      if (!mejor || score > mejor.score) mejor = { fila: d, score, conGramaje };
    }

    if (!mejor) { descartados++; continue; }

    const umbral = mejor.conGramaje ? UMBRAL.conGramaje : UMBRAL.sinGramaje;
    const status =
      mejor.score >= umbral.auto ? 'auto' : mejor.score >= umbral.pendiente ? 'pendiente' : null;

    if (status === null) { descartados++; continue; }

    aGuardar.push({
      productId: c.id,
      matchProductId: mejor.fila.id,
      ean13: mejor.fila.ean13,
      score: mejor.score.toFixed(3),
      strategy: mejor.conGramaje ? 'marca_gramaje_nombre' : 'marca_nombre',
      status,
    });
  }

  // Recalcular no debe pisar lo que una persona ya decidio.
  for (let i = 0; i < aGuardar.length; i += 500) {
    await db.insert(productMatches).values(aGuardar.slice(i, i + 500))
      .onConflictDoUpdate({
        target: [productMatches.productId, productMatches.matchProductId],
        set: {
          score: sql`excluded.score`,
          strategy: sql`excluded.strategy`,
          status: sql`excluded.status`,
          ean13: sql`excluded.ean13`,
          updatedAt: new Date(),
        },
        setWhere: sql`${productMatches.status} in ('auto','pendiente')`,
      });
  }

  const soltados = await unDuenoPorCanonico();

  const auto = aGuardar.filter((m) => m.status === 'auto').length;
  console.log(`  auto (score alto):  ${auto}`);
  console.log(`  pendientes:         ${aGuardar.length - auto}`);
  console.log(`  sin marca del otro lado: ${sinMarcaEnLaOtra}`);
  console.log(`  sin candidato bueno:     ${descartados}`);
  console.log(`  soltados por disputa:    ${soltados}`);
  console.log(`\nGuardados ${aGuardar.length} pares en product_matches.`);
}

/** Un canonico tiene un solo dueño.
 *
 *  Dos productos distintos no pueden ser el mismo del otro lado, asi que cuando
 *  varios reclaman el mismo canonico queda en `auto` solo el de mejor score. Es
 *  lo que separa "raid" de "raid max", que comparten todo menos una palabra.
 *
 *  Y si empatan en el mejor score, no queda ninguno. Esto faltaba y era el
 *  agujero grande. `contencion` divide por el conjunto mas chico, asi que un
 *  canonico de dos palabras da 1.0 contra cualquier producto de esa marca:
 *  "Esponja Virulana" empataba a 1.000 con las diez esponjas Virulana del
 *  catalogo y entraban las diez. Un canonico de Rexona se llevaba veinte
 *  desodorantes de variantes distintas. Medido sobre la base: 882 filas
 *  empatadas, 878 de ellas productos realmente distintos.
 *
 *  Desempatar por parecido de texto no sirve, ya se probo: contra un canonico
 *  que dice "charcoal", "white" puntua mas alto que "white carbon", que es el
 *  correcto. Si no hay con que decidir, que no decida.
 *
 *  Corre sobre la tabla entera y no sobre lo de esta corrida. Arreglarlo solo
 *  en memoria dejaba 490 filas empatadas igual: un par que entro como `auto`
 *  en una corrida vieja y hoy ya no se regenera no se volvia a mirar nunca, y
 *  los empates se acumulaban corrida a corrida.
 *
 *  Degrada a pendiente en vez de borrar: el par sigue ahi para que una persona
 *  lo decida. Tambien limpia `applied_at`, sin lo cual el producto seguia
 *  apuntando al canonico equivocado: `apply` solo suelta el puntero cuando ya
 *  no queda ningun match aplicado, y un match degradado que conserva la fecha
 *  cuenta como aplicado.
 *
 *  Y si ya hay un `confirmado` para ese canonico, los `auto` que lo disputan se
 *  caen: la decision ya la tomo una persona. */
async function unDuenoPorCanonico(): Promise<number> {
  const { rowCount } = await pool.query(`
    with mejor as (
      select match_product_id, max(score) score
        from product_matches where status = 'auto' group by 1
    ),
    empates as (
      select m.match_product_id, count(*) cuantos
        from product_matches m
        join mejor t on t.match_product_id = m.match_product_id and m.score = t.score
       where m.status = 'auto'
       group by 1
    ),
    decidido as (
      select distinct match_product_id from product_matches where status = 'confirmado'
    )
    update product_matches m
       set status = 'pendiente', applied_at = null, updated_at = now()
      from mejor t
      join empates e on e.match_product_id = t.match_product_id
      left join decidido d on d.match_product_id = t.match_product_id
     where m.match_product_id = t.match_product_id
       and m.status = 'auto'
       and (m.score < t.score or e.cuantos > 1 or d.match_product_id is not null)`);
  return rowCount ?? 0;
}

try {
  await main();
} finally {
  await pool.end();
}
