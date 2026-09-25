import Fastify from 'fastify';
import cors from '@fastify/cors';
import path from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pool } from '@precios/db';
import { buscar, cadenas, historial, porEan, porId } from './consultas.js';
import { cambiosDesde, revisionActual } from './sync.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

// La app corre en otro puerto (Metro en 8081, o la IP de la maquina desde un
// celular), asi que sin esto el navegador bloquea todas las consultas. La API
// es de solo lectura y publica: no hay cookies ni sesion que proteger.
await app.register(cors, { origin: true });

const entero = (v: unknown, porDefecto: number, tope: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), tope) : porDefecto;
};

// Los snapshots del catalogo, para desarrollo. En produccion esto lo sirve un
// CDN y la API no se despliega.
//
// El .gz se manda con Content-Encoding: gzip para que fetch() lo descomprima
// solo y el cliente reciba JSON. Si se sirviera como archivo comun, el celular
// tendria que traerse una libreria de descompresion para nada.
// Anclado al modulo y no al cwd: npm ejecuta el workspace parado en apps/api,
// asi que un 'snapshot' relativo apuntaria al lugar equivocado.
const SNAPSHOTS = process.env.SNAPSHOT_DIR
  ? path.resolve(process.env.SNAPSHOT_DIR)
  : fileURLToPath(new URL('../../../snapshot/', import.meta.url));

app.get('/snapshot/:archivo', async (req, reply) => {
  const { archivo } = req.params as { archivo: string };
  // Sin barras ni puntos dobles: el nombre sale de un manifiesto nuestro, pero
  // la ruta la arma el cliente y no hay que confiar en ella.
  if (!/^[A-Za-z0-9._-]+$/.test(archivo) || archivo.includes('..')) {
    return reply.code(400).send({ error: 'Nombre de archivo invalido.' });
  }

  const ruta = path.join(SNAPSHOTS, archivo);
  if (!existsSync(ruta)) {
    return reply.code(404).send({ error: 'No existe ese snapshot.', archivo });
  }

  if (archivo.endsWith('.json.gz')) {
    reply.header('Content-Encoding', 'gzip').type('application/json; charset=utf-8');
  } else if (archivo.endsWith('.json')) {
    reply.type('application/json; charset=utf-8');
  }
  return reply.send(createReadStream(ruta));
});

app.get('/salud', async () => {
  const { rows } = await pool.query<{ n: string }>('select count(*) n from products');
  return { ok: true, productos: Number(rows[0]!.n), revision: await revisionActual() };
});

app.get('/cadenas', async () => ({ cadenas: await cadenas() }));

app.get('/buscar', async (req, reply) => {
  const { q, cadena, limite } = req.query as Record<string, string | undefined>;
  if (!q || q.trim().length < 2) {
    return reply.code(400).send({ error: 'Falta q, o es muy corto (minimo 2 caracteres).' });
  }
  const termino = q.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  return { resultados: await buscar(termino, { cadena, limite: entero(limite, 20, 100) }) };
});

/** El escaneo del codigo de barras entra por aca. */
app.get('/ean/:codigo', async (req, reply) => {
  const { codigo } = req.params as { codigo: string };
  if (!/^\d{8,13}$/.test(codigo)) {
    return reply.code(400).send({ error: 'El codigo tiene que ser de 8 a 13 digitos.' });
  }
  const grupo = await porEan(codigo);
  if (!grupo) return reply.code(404).send({ error: 'No tenemos ese codigo todavia.', ean13: codigo });
  return grupo;
});

app.get('/producto/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const grupo = await porId(id);
  if (!grupo) return reply.code(404).send({ error: 'No existe.' });
  return grupo;
});

app.get('/producto/:id/historial', async (req) => {
  const { id } = req.params as { id: string };
  const { dias } = req.query as Record<string, string | undefined>;
  return { puntos: await historial(id, entero(dias, 90, 365)) };
});

app.get('/sync', async (req) => {
  const { desde, limite } = req.query as Record<string, string | undefined>;
  const d = Number(desde);
  return cambiosDesde(Number.isFinite(d) && d >= 0 ? d : 0, entero(limite, 1000, 5000));
});

const port = entero(process.env.PORT, 3000, 65535);
await app.listen({ port, host: '0.0.0.0' });
