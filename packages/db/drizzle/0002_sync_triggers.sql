-- Triggers de sync. El DEFAULT de la columna cubre el INSERT; estos cubren el
-- UPDATE, que es donde una fila cambiaria sin que el cliente se entere.

CREATE TRIGGER trg_products_revision BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION bump_revision();
--> statement-breakpoint
CREATE TRIGGER trg_products_touch BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
--> statement-breakpoint

CREATE TRIGGER trg_current_prices_revision BEFORE UPDATE ON current_prices
  FOR EACH ROW EXECUTE FUNCTION bump_revision();
--> statement-breakpoint
CREATE TRIGGER trg_current_prices_touch BEFORE UPDATE ON current_prices
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
--> statement-breakpoint

CREATE TRIGGER trg_product_media_revision BEFORE UPDATE ON product_media
  FOR EACH ROW EXECUTE FUNCTION bump_revision();
--> statement-breakpoint
CREATE TRIGGER trg_visual_features_revision BEFORE UPDATE ON product_visual_features
  FOR EACH ROW EXECUTE FUNCTION bump_revision();
--> statement-breakpoint

-- Busqueda por nombre tolerante a errores de tipeo ("coca cola" vs "cocacola").
-- GIN + trigramas: Drizzle no expresa la clase de operadores gin_trgm_ops.
CREATE INDEX idx_products_norm_name ON products USING gin (normalized_name gin_trgm_ops);
--> statement-breakpoint

-- Busqueda por similitud visual. Cosine es lo habitual para embeddings de
-- imagen; si el modelo que elijamos usa L2, se cambia por vector_l2_ops.
CREATE INDEX idx_visual_embedding ON product_visual_features
  USING hnsw (embedding vector_cosine_ops);
