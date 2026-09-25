// Solo por el efecto de cargar el .env de la raiz: este script no toca la base,
// pero las credenciales de R2 viven en el mismo archivo y sin esto llegan vacias.
import '@precios/db/env';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand,
} from '@aws-sdk/client-s3';

/** Sube el snapshot a Cloudflare R2.
 *
 *  Es el reemplazo de "apuntar a la maquina de casa": publicado, el telefono se
 *  actualiza desde cualquier lado y por HTTPS, sin depender de que tu PC este
 *  prendida ni de estar en tu wifi.
 *
 *  Va bajo una ruta larga y aleatoria en vez de un repositorio publico: el
 *  bucket permite lectura sin credenciales —el telefono no puede llevar una
 *  clave adentro, se extraeria del APK en cinco minutos— pero nadie llega sin
 *  conocer la direccion exacta, y no queda indexado en ningun lado. */

const SALIDA = fileURLToPath(new URL('../../../snapshot/', import.meta.url));

const cfg = {
  cuenta: process.env.R2_ACCOUNT_ID,
  clave: process.env.R2_ACCESS_KEY_ID,
  secreto: process.env.R2_SECRET_ACCESS_KEY,
  bucket: process.env.R2_BUCKET,
  prefijo: (process.env.R2_PREFIX ?? '').replace(/^\/+|\/+$/g, ''),
  publico: (process.env.R2_PUBLIC_BASE ?? '').replace(/\/+$/, ''),
};

function faltantes(): string[] {
  const necesarias: [string, unknown][] = [
    ['R2_ACCOUNT_ID', cfg.cuenta], ['R2_ACCESS_KEY_ID', cfg.clave],
    ['R2_SECRET_ACCESS_KEY', cfg.secreto], ['R2_BUCKET', cfg.bucket],
    ['R2_PREFIX', cfg.prefijo], ['R2_PUBLIC_BASE', cfg.publico],
  ];
  return necesarias.filter(([, v]) => !v).map(([k]) => k);
}

async function main(): Promise<void> {
  const falta = faltantes();
  if (falta.length > 0) {
    console.error(`Faltan variables en .env: ${falta.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const archivos = (await readdir(SALIDA)).filter(
    (f) => f === 'manifiesto.json' || /^completo-\d+\.json\.gz$/.test(f),
  );
  if (!archivos.includes('manifiesto.json')) {
    console.error('No hay manifiesto. Genera el snapshot primero: npm run snapshot');
    process.exitCode = 1;
    return;
  }

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${cfg.cuenta}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: cfg.clave!, secretAccessKey: cfg.secreto! },
  });

  for (const archivo of archivos) {
    const cuerpo = await readFile(path.join(SALIDA, archivo));
    const gz = archivo.endsWith('.json.gz');

    await s3.send(new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: `${cfg.prefijo}/${archivo}`,
      Body: cuerpo,
      ContentType: 'application/json; charset=utf-8',
      // Con esta cabecera el telefono recibe JSON ya descomprimido: fetch lo
      // resuelve solo y la app no necesita una libreria para desarmar el gzip.
      ...(gz ? { ContentEncoding: 'gzip' } : {}),
      // El manifiesto cambia seguido y es chico; el catalogo lleva la revision
      // en el nombre, asi que nunca cambia de contenido y se puede cachear.
      CacheControl: gz ? 'public, max-age=31536000, immutable' : 'public, max-age=60',
    }));

    console.log(`  subido  ${archivo}  ${(cuerpo.length / 1024).toFixed(0)} KB`);
  }

  // El nombre del catalogo lleva la revision, asi que cada publicacion crea un
  // objeto nuevo en vez de reemplazar. Sin esta limpieza se acumularian 3 MB
  // por dia para siempre. Borrar no cuesta nada en R2.
  const viejos = await s3.send(new ListObjectsV2Command({
    Bucket: cfg.bucket,
    Prefix: `${cfg.prefijo}/completo-`,
  }));

  const aBorrar = (viejos.Contents ?? [])
    .map((o) => o.Key!)
    .filter((k) => !archivos.some((f) => k === `${cfg.prefijo}/${f}`));

  if (aBorrar.length > 0) {
    await s3.send(new DeleteObjectsCommand({
      Bucket: cfg.bucket,
      Delete: { Objects: aBorrar.map((Key) => ({ Key })) },
    }));
    console.log(`  borrados ${aBorrar.length} snapshots viejos`);
  }

  console.log(`\nDireccion para la app:\n  ${cfg.publico}/${cfg.prefijo}`);
}

await main();
