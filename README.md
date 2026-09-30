# precios_varios — scraper

Baja los catálogos de los supermercados de Bahía Blanca, empareja el mismo
producto entre cadenas y publica un snapshot que consume la app.

La app vive aparte y no depende de este repo: lee el snapshot desde un CDN.
No hay API entre los dos, sólo un archivo JSON.

```
este repo  ──►  snapshot en Cloudflare R2  ──►  la app en el telefono
```

## Cadenas

| cadena | productos | cómo |
|---|---|---|
| Cooperativa Obrera | ~11.000 | API propia (súper + Coope Hogar, mismo SKU y sucursal) |
| Carrefour | ~12.500 | VTEX |
| Changó Más | ~11.000 | VTEX Intelligent Search con `regionId` de Bahía |

Los precios de Changó Más salen de sus sucursales de Bahía: sin fijar la
región, VTEX devuelve los de Buenos Aires.

## Arrancar

Hace falta Node 22+ y Docker.

```bash
npm install
npm run db:up                      # Postgres en Docker
npm run migrate -w @precios/db
cp .env.example .env               # completar credenciales
npm run scrape -- coope 100        # probar con 100 productos
```

## El refresco

```bash
npm run refrescar                  # scrapea, empareja, arma y publica
```

En orden: `scrape` de cada cadena, `promociones` (las campañas de La Coope,
que traen la etiqueta), `repechaje` (los que el listado esconde por no tener
stock online), `match` + `apply`, `snapshot`, `publicar` y `prune`.

Corre solo todos los días por GitHub Actions y también a mano desde el botón
*Run workflow*. Las credenciales van en los Secrets del repo.

`scripts/refrescar.sh` es la variante para correrlo en una máquina propia: usa
un archivo candado, avisa por Telegram y deja logs.

### Los respaldos

Cuando el refresco termina bien, sube la base a R2 con `npm run respaldar`. Se
conservan los **últimos 4** y el más viejo se borra solo en cada corrida, así
que la carpeta no crece: son unos 36 MB cada uno, 140 MB en total, contra los
10 GB del plan gratis.

Desde el panel de R2 parece que crece, porque se ve aparecer el archivo nuevo y
no se ve desaparecer el viejo. La línea `borrados N respaldos viejos` en el log
de la corrida es la que lo confirma.

Se guardan cuatro y no uno porque si el último se subió con la base ya rota,
hace falta tener a dónde volver.

## Lo que hay que saber antes de tocar precios

Tres cosas que costaron plata averiguar, todas verificadas contra tickets
reales:

- **Los precios de VTEX son por región.** Sin `regionId`, la API devuelve los
  de Buenos Aires con total naturalidad.
- **La Coope marca las promos de dos formas.** La clásica baja `precio_promo`;
  la de campaña ya viene aplicada en `precio`, con el de lista en
  `precio_anterior` y la bandera en `existe_promo`. Leyendo sólo la primera se
  escapan 30 de cada 31.
- **`cant_articulos` no es el tamaño de página, es el desplazamiento.** Y el
  listado se estanca cerca de 64 productos en cualquier eje: para sacar una
  categoría entera hay que subdividirla por marca.

## Licencia

Proyecto personal, sin licencia de uso. Los datos son de cada cadena.
