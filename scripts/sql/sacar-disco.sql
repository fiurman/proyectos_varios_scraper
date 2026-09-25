-- Saca Disco de la base.
--
-- Disco no tiene sucursales en Bahia Blanca: son ~11.000 productos de un super
-- al que no se puede entrar a comprar, y seguian apareciendo en el selector de
-- cadenas de la app. El adapter queda disponible a mano por si algun dia abre
-- (npm run scrape -- disco), esto solo borra los datos que ya estaban.
--
--   docker compose exec -T db psql -U precios -d precios -v ON_ERROR_STOP=1 \
--     -f /dev/stdin < scripts/sql/sacar-disco.sql
--
-- Medido antes de escribirlo: 6.616 productos existen solo en Disco y se van
-- enteros; 4.624 son compartidos con La Coope o Carrefour y se quedan, pierden
-- unicamente el precio de Disco.

BEGIN;

-- Cuanto hay, para poder comparar despues.
SELECT 'antes' etapa,
       (SELECT count(*) FROM stores WHERE chain = 'disco') tiendas,
       (SELECT count(*) FROM product_sources WHERE chain = 'disco') fuentes,
       (SELECT count(*) FROM products) productos;

-- La tienda arrastra por cascada sus precios, actuales e historicos.
DELETE FROM stores WHERE chain = 'disco';

-- Las fuentes dicen de que cadena vino cada producto.
DELETE FROM product_sources WHERE chain = 'disco';

-- Y el producto que se quedo sin ninguna cadena ya no existe para nadie.
DELETE FROM products p
 WHERE NOT EXISTS (SELECT 1 FROM product_sources s WHERE s.product_id = p.id);

SELECT 'despues' etapa,
       (SELECT count(*) FROM stores WHERE chain = 'disco') tiendas,
       (SELECT count(*) FROM product_sources WHERE chain = 'disco') fuentes,
       (SELECT count(*) FROM products) productos;

COMMIT;
