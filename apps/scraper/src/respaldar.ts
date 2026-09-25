import '@precios/db/env';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';

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
      '-Fc', '-f', destino,
    ], { stdio: ['ignore', 'inherit', 'inherit'] });
    hijo.on('error', reject);
    hijo.on('close', (codigo) => {
      if (codigo === 0) resolve();
      else reject(new Error(`pg_dump salio con ${codigo}`));
    });
  });
}

async function main(): Promise<void> {
  const falta = faltante();
  if (falta) {
    console.error(`Falta ${falta} en el .env. Sin eso no hay adonde subir.`);
    process.exitCode = 1;
    return;
  }

  const fecha = new Date().toISOString().slice(0, 10);
  const nombre = `base-${fecha}.dump`;
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
