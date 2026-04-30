-- Migration 001: Foundation Extensions Setup
-- Applies To: NeonDB (PostgreSQL)
-- Description: Establishes critical search, cryptographic extensions, and production safety defaults.

-- ==============================================================================
-- 1. EXTENSIONS
-- ==============================================================================

-- Enables Generalized Inverted Index (GIN) for high-performance text searching
-- Critical for the `village_search` autocomplete functionality.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Enables robust cryptographic functions and reliable UUID generation.
-- Essential for `api_key` hashing and producing UUIDs.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Provides standard UUID algorithms.
-- Included for redundancy and supporting any potential migration of legacy UUIDs.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ==============================================================================
-- 2. PRODUCTION SAFEGUARDS & DEFAULTS
-- ==============================================================================

-- We use a dynamic PL/pgSQL block to automatically apply these settings 
-- to whatever database you are currently connected to (e.g., 'neondb').
DO $$ 
DECLARE
    current_db text := current_database();
BEGIN
    -- 1. Enforce UTC timezone globally to prevent time-drift across distributed systems.
    EXECUTE 'ALTER DATABASE ' || quote_ident(current_db) || ' SET timezone TO ''UTC''';
    
    -- 2. Statement Timeout (30s): Prevents runaway queries from exhausting NeonDB compute.
    EXECUTE 'ALTER DATABASE ' || quote_ident(current_db) || ' SET statement_timeout TO ''30s''';
    
    -- 3. Lock Timeout (10s): Fails fast during severe lock contention to prevent deadlock pileups.
    EXECUTE 'ALTER DATABASE ' || quote_ident(current_db) || ' SET lock_timeout TO ''10s''';
    
    -- 4. Idle Transaction Timeout (60s): Kills abandoned transactions. 
    -- Extremely critical in NeonDB to allow the cluster to successfully scale-to-zero when idle.
    EXECUTE 'ALTER DATABASE ' || quote_ident(current_db) || ' SET idle_in_transaction_session_timeout TO ''60s''';
END $$;
