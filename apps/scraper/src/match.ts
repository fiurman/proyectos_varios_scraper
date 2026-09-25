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

  // Dos productos distintos no pueden ser el mismo del otro lado: cuando varios
  // reclaman el mismo par, solo el de mejor score queda en auto. Es lo que
  // separa "raid" de "raid max", que comparten todo menos una palabra.
  const mejorPorDestino = new Map<string, number>();
  for (const m of aGuardar) {
    if (m.status !== 'auto') continue;
    const actual = mejorPorDestino.get(m.matchProductId);
    const score = Number(m.score);
    if (actual === undefined || score > actual) mejorPorDestino.set(m.matchProductId, score);
  }

  let degradados = 0;
  for (const m of aGuardar) {
    if (m.status !== 'auto') continue;
    if (Number(m.score) < mejorPorDestino.get(m.matchProductId)!) {
      m.status = 'pendiente';
      degradados++;
    }
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

  const auto = aGuardar.filter((m) => m.status === 'auto').length;
  console.log(`  auto (score alto):  ${auto}`);
  console.log(`  pendientes:         ${aGuardar.length - auto}`);
  console.log(`  sin marca del otro lado: ${sinMarcaEnLaOtra}`);
  console.log(`  sin candidato bueno:     ${descartados}`);
  console.log(`  degradados por conflicto: ${degradados}`);
  console.log(`\nGuardados ${aGuardar.length} pares en product_matches.`);
}

try {
  await main();
} finally {
  await pool.end();
}
