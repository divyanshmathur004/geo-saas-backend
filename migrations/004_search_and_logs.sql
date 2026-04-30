-- migrations/004_search_and_logs.sql
-- Description: Creates the high-performance search projection table and the partitioned API log table.

-- 1. Ensure pg_trgm extension is active for the search features
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. village_search (Projection Table)
CREATE TABLE village_search (
    id UUID DEFAULT gen_random_uuid() CONSTRAINT pk_village_search PRIMARY KEY,
    village_id UUID NOT NULL,
    village_name VARCHAR(255) NOT NULL,
    sub_district_name VARCHAR(255) NOT NULL,
    district_name VARCHAR(255) NOT NULL,
    state_name VARCHAR(255) NOT NULL,
    search_text TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_village_search_village FOREIGN KEY (village_id) REFERENCES village(id) ON DELETE CASCADE,
    CONSTRAINT chk_village_search_text_not_empty CHECK (trim(search_text) <> '')
);

-- Unique index to ensure 1:1 mapping with the base village table
CREATE UNIQUE INDEX uq_village_search_village_id ON village_search(village_id);

-- High-performance GIN index using pg_trgm for fuzzy autocomplete matching
CREATE INDEX idx_village_search_trgm ON village_search USING gin (search_text gin_trgm_ops);

-- Assuming set_updated_at() was created in 002
CREATE TRIGGER set_updated_at_village_search
    BEFORE UPDATE ON village_search
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- 3. api_log (Append-Only Partitioned Table)
CREATE TABLE api_log (
    id UUID DEFAULT gen_random_uuid(),
    user_id UUID,
    api_key_id UUID,
    endpoint VARCHAR(255) NOT NULL,
    method VARCHAR(10) NOT NULL,
    status_code INT NOT NULL,
    response_time_ms INT NOT NULL,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_api_log PRIMARY KEY (id, created_at),
    -- Enforcing strict retention: API logs block hard-deleting tenants to preserve audit history
    CONSTRAINT fk_api_log_user FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE RESTRICT,
    CONSTRAINT fk_api_log_api_key FOREIGN KEY (api_key_id) REFERENCES api_key(id) ON DELETE RESTRICT
) PARTITION BY RANGE (created_at);

-- Indexes applied to the parent table automatically cascade to all current and future partitions
CREATE INDEX idx_api_log_user_id ON api_log(user_id);
CREATE INDEX idx_api_log_api_key_id ON api_log(api_key_id);
CREATE INDEX idx_api_log_created_at ON api_log(created_at);

-- Create initial monthly partitions.
-- WARNING: DO NOT CREATE A DEFAULT PARTITION.
-- A default partition forces Postgres to do an ACCESS EXCLUSIVE lock and full table scan 
-- every time a new partition is added. Pre-create partitions instead.
CREATE TABLE api_log_y2026m04 PARTITION OF api_log FOR VALUES FROM ('2026-04-01 00:00:00+00') TO ('2026-05-01 00:00:00+00');
CREATE TABLE api_log_y2026m05 PARTITION OF api_log FOR VALUES FROM ('2026-05-01 00:00:00+00') TO ('2026-06-01 00:00:00+00');
CREATE TABLE api_log_y2026m06 PARTITION OF api_log FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');
CREATE TABLE api_log_y2026m07 PARTITION OF api_log FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');
CREATE TABLE api_log_y2026m08 PARTITION OF api_log FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00');
CREATE TABLE api_log_y2026m09 PARTITION OF api_log FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');

-- 4. Enforce Strict Append-Only Immutability
CREATE OR REPLACE FUNCTION prevent_api_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'api_log is an immutable append-only audit table. UPDATE and DELETE operations are strictly prohibited.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_api_log_append_only
    BEFORE UPDATE OR DELETE ON api_log
    FOR EACH STATEMENT
    EXECUTE FUNCTION prevent_api_log_mutation();
