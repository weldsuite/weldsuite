-- pgvector must exist before the vector(1024) column below can be created.
-- drizzle-kit does not emit extension statements, so this line is hand-added;
-- keep it at the top if this migration is ever regenerated.
-- Available on every Neon plan, no add-on required.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "search_index" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"entity_type" varchar(30) NOT NULL,
	"entity_id" varchar(30) NOT NULL,
	"chunk_index" integer DEFAULT 0 NOT NULL,
	"content" text NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"embedding" vector(1024),
	"embed_model" varchar(100) NOT NULL,
	"title" varchar(500),
	"subtitle" varchar(500),
	"url" varchar(500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "search_index_entity_chunk_idx" ON "search_index" USING btree ("entity_type","entity_id","chunk_index");--> statement-breakpoint
CREATE INDEX "search_index_entity_type_idx" ON "search_index" USING btree ("entity_type");--> statement-breakpoint
CREATE INDEX "search_index_embed_model_idx" ON "search_index" USING btree ("embed_model");--> statement-breakpoint
-- Approximate-nearest-neighbour index for the semantic leg. Cosine ops match
-- bge-m3's normalised output. Hand-added: declaring it in the Drizzle schema
-- is possible but the generated DDL is not what we want here.
--
-- Built on an empty table, so this is instant at migration time. The usual
-- "bulk load first, index after" advice applies only to tenants with a large
-- existing corpus — for those, drop and rebuild this index around the backfill.
-- Note CONCURRENTLY is deliberately NOT used: it cannot run inside the
-- transaction the migration runner wraps each file in.
CREATE INDEX "search_index_embedding_hnsw_idx" ON "search_index" USING hnsw ("embedding" vector_cosine_ops);