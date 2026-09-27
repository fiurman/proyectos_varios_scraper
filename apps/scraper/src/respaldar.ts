import '@precios/db/env';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';

/** Copia la base a R2, al lado del snapshot.
 *
 *  Existe para que la maquina que corre el refresco sea descartable. Si se
 *  pierde —un servidor gratis que te apagan, un disco que muere— levantar otra
 *  es: crear la instancia, correr `scripts/aprovisionar.sh` y traer este
 *  archivo. Sin esto habria que volver a scrapear todo, y se perderian los
 *  emparejamientos entre cadenas, que son horas de revision a mano.
 *
 *  No entran los payloads crudos: son 190 de los 361 MB y se rellenan solos en
 *  el primer scrapeo. Lo que importa son los productos, sus precios, el
 *  historial y los matches.
 *
 *   npm run respaldar
 */

const CUANTOS_GUARDAR = 4;

const cfg = {
  cuenta: process.env.R2_ACCOUNT_ID,
  clave: process.env.R2_ACCESS_KEY_ID,
  secreto: process.env.R2_SECRET_ACCESS_KEY,
  bucket: process.env.R2_BUCKET,
  prefijo: (process.env.R2_PREFIX ?? '').replace(/^\/+|\/+$/g, ''),
};

function faltante(): string | null {
  for (const [nombre, valor] of [
    ['R2_ACCOUNT_ID', cfg.cuenta], ['R2_ACCESS_KEY_ID', cfg.clave],
    ['R2_SECRET_ACCESS_KEY', cfg.secreto], ['R2_BUCKET', cfg.bucket],
  ] as const) {
    if (!valor) return nombre;
  }
  return null;
}

function volcar(destino: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const hijo = spawn('pg_dump', [
      process.env.DATABASE_URL!,
      '--exclude-table-data=raw_scrape_items',
      // Con esquema: el respaldo tiene que poder restaurarse sobre una base
      // recien creada, que es lo que hay en cada corrida de la tarea.
      '-Fc', '-f', destino,
    ], { stdio: ['ignore', 'inherit', 'inherit'] });
    hijo.on('error', reject);
    hijo.on('close', (codigo) => {
      if (codigo === 0) resolve();
      else reject(new Error(`pg_dump salio con ${codigo}`));
    });
  });
}

/** Nombre del respaldo mas nuevo que hay en R2, o vacio si no hay ninguno.
 *
 *  Lo usa la tarea programada para saber que bajar antes de empezar.
 *  Se imprime pelado, sin adornos, porque lo lee un script. */
async function ultimo(s3: S3Client): Promise<string> {
  const { Contents } = await s3.send(new ListObjectsV2Command({
    Bucket: cfg.bucket,
    Prefix: `${cfg.prefijo}/respaldos/`,
  }));
  const nombres = (Contents ?? [])
    .map((o) => o.Key ?? '')
    .filter((k) => k.endsWith('.dump'))
    .sort();
  const ultimo = nombres.at(-1);
  return ultimo ? ultimo.split('/').pop()! : '';
}

async function main(): Promise<void> {
  const falta = faltante();
  if (falta) {
    console.error(`Falta ${falta} en el .env. Sin eso no hay adonde subir.`);
    process.exitCode = 1;
    return;
  }

  const s3Listar = new S3Client({
    region: 'auto',
    endpoint: `https://${cfg.cuenta}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: cfg.clave!, secretAccessKey: cfg.secreto! },
  });

  const orden = process.argv[2] ?? '';

  // `respaldos ultimo` solo informa cual es el mas nuevo y termina.
  if (orden === 'ultimo') {
    console.log(await ultimo(s3Listar));
    return;
  }

  // `respaldos bajar <destino>` trae el mas nuevo.
  //
  // Con credenciales y no por la URL publica: el respaldo no tiene por que
  // estar al alcance de cualquiera que adivine el link, aunque su contenido
  // sea el mismo catalogo que se publica.
  if (orden === 'bajar') {
    const nombre = await ultimo(s3Listar);
    if (!nombre) { console.error('No hay ningun respaldo todavia.'); return; }
    // Relativo a donde se invoco npm, no a donde termino corriendo.
    //
    // `npm run -w @precios/scraper` cambia el directorio al del workspace, asi
    // que un nombre suelto escribia en apps/scraper/ y quien lo llamo lo
    // buscaba en la raiz. Paso de verdad: la tarea bajo el respaldo, no lo
    // encontro, arranco de una base vacia y recreo el catalogo entero con ids
    // nuevos, dejando sin efecto lo que la app tenia guardado.
    const pedido = process.argv[3] ?? nombre;
    const destino = path.isAbsolute(pedido)
      ? pedido
      : path.resolve(process.env.INIT_CWD ?? process.cwd(), pedido);
    const { Body } = await s3Listar.send(new GetObjectCommand({
      Bucket: cfg.bucket,
      Key: `${cfg.prefijo}/respaldos/${nombre}`,
    }));
    await pipeline(Body as Readable, createWriteStream(destino));
    const { size } = await stat(destino);
    console.log(`  ${nombre} -> ${destino}  ${(size / 1024 / 1024).toFixed(0)} MB`);
    return;
  }

  // Con hora y no solo fecha: dos respaldos del mismo dia se pisaban, y el
  // orden alfabetico es lo que decide cual es el ultimo.
  const sello = new Date().toISOString().slice(0, 16).replace(':', '-');
  const nombre = `base-${sello}.dump`;
  const local = path.join(tmpdir(), nombre);

  console.log('Volcando la base...');
  await volcar(local);
  const { size } = await stat(local);
  console.log(`  ${nombre}  ${(size / 1024 / 1024).toFixed(0)} MB`);

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${cfg.cuenta}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: cfg.clave!, secretAccessKey: cfg.secreto! },
  });

  const clave = `${cfg.prefijo}/respaldos/${nombre}`;
  await s3.send(new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: clave,
    Body: createReadStream(local),
    ContentLength: size,
    ContentType: 'application/octet-stream',
    // Un respaldo no lo pide nadie desde la app: no tiene por que cachearse.
    CacheControl: 'no-store',
  }));
  console.log(`  subido a ${clave}`);
  await unlink(local).catch(() => {});

  // Se conservan unos pocos. Uno solo no sirve: si el ultimo se subio con la
  // base ya rota, no queda a donde volver.
  const { Contents } = await s3.send(new ListObjectsV2Command({
    Bucket: cfg.bucket,
    Prefix: `${cfg.prefijo}/respaldos/`,
  }));
  const viejos = (Contents ?? [])
    .filter((o) => o.Key && o.Key.endsWith('.dump'))
    .sort((a, b) => (b.Key! > a.Key! ? 1 : -1))
    .slice(CUANTOS_GUARDAR);

  if (viejos.length > 0) {
    await s3.send(new DeleteObjectsCommand({
      Bucket: cfg.bucket,
      Delete: { Objects: viejos.map((o) => ({ Key: o.Key! })) },
    }));
    console.log(`  borrados ${viejos.length} respaldos viejos (se guardan ${CUANTOS_GUARDAR})`);
  }
}

await main();
