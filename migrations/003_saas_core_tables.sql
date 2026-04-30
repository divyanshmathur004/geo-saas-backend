-- migrations/003_saas_core_tables.sql
-- Description: Creates the SaaS multi-tenant boundary, billing limits, and API key management tables.

-- Create ENUMs for strict type safety on roles and status
CREATE TYPE user_role_enum AS ENUM ('ADMIN', 'TENANT', 'DEVELOPER');
CREATE TYPE user_status_enum AS ENUM ('ACTIVE', 'PENDING', 'SUSPENDED');

-- 1. subscription_plan
CREATE TABLE subscription_plan (
    id UUID DEFAULT gen_random_uuid() CONSTRAINT pk_subscription_plan PRIMARY KEY,
    code VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    rate_limit_per_min INT NOT NULL,
    max_requests_per_month INT NOT NULL,
    max_allowed_states INT NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT chk_plan_code_not_empty CHECK (trim(code) <> ''),
    CONSTRAINT chk_plan_name_not_empty CHECK (trim(name) <> ''),
    CONSTRAINT chk_plan_price_positive CHECK (price >= 0),
    CONSTRAINT chk_plan_limits_positive CHECK (rate_limit_per_min >= 0 AND max_requests_per_month >= 0 AND max_allowed_states >= 0)
);
CREATE UNIQUE INDEX uq_subscription_plan_code ON subscription_plan(code) WHERE deleted_at IS NULL;

CREATE TRIGGER set_updated_at_subscription_plan
    BEFORE UPDATE ON subscription_plan
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- 2. "user" (Tenant / Customer)
-- Note: 'user' is a reserved keyword in PostgreSQL, so it must be double-quoted.
CREATE TABLE "user" (
    id UUID DEFAULT gen_random_uuid() CONSTRAINT pk_user PRIMARY KEY,
    subscription_plan_id UUID NOT NULL,
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    company_name VARCHAR(255),
    role user_role_enum NOT NULL DEFAULT 'TENANT',
    status user_status_enum NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT fk_user_subscription_plan FOREIGN KEY (subscription_plan_id) REFERENCES subscription_plan(id) ON DELETE RESTRICT,
    CONSTRAINT chk_user_email_format CHECK (email ~* '^[A-Za-z0-9._+%-]+@[A-Za-z0-9.-]+[.][A-Za-z]+$'),
    CONSTRAINT chk_user_first_name_not_empty CHECK (trim(first_name) <> ''),
    CONSTRAINT chk_user_last_name_not_empty CHECK (trim(last_name) <> '')
);
CREATE UNIQUE INDEX uq_user_email ON "user"(email) WHERE deleted_at IS NULL;
CREATE INDEX idx_user_subscription_plan_id ON "user"(subscription_plan_id);

CREATE TRIGGER set_updated_at_user
    BEFORE UPDATE ON "user"
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- 3. api_key
CREATE TABLE api_key (
    id UUID DEFAULT gen_random_uuid() CONSTRAINT pk_api_key PRIMARY KEY,
    user_id UUID NOT NULL,
    name VARCHAR(255) NOT NULL,
    key_prefix VARCHAR(15) NOT NULL, 
    key_hash VARCHAR(64) NOT NULL, 
    expires_at TIMESTAMP WITH TIME ZONE,
    last_used_at TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT fk_api_key_user FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE RESTRICT,
    CONSTRAINT chk_api_key_name_not_empty CHECK (trim(name) <> ''),
    CONSTRAINT chk_api_key_hash_length CHECK (length(key_hash) = 64) 
);
CREATE UNIQUE INDEX uq_api_key_hash ON api_key(key_hash) WHERE deleted_at IS NULL;
CREATE INDEX idx_api_key_user_active ON api_key(user_id) WHERE deleted_at IS NULL AND is_active = true;

CREATE TRIGGER set_updated_at_api_key
    BEFORE UPDATE ON api_key
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- 4. user_state_access
CREATE TABLE user_state_access (
    id UUID DEFAULT gen_random_uuid() CONSTRAINT pk_user_state_access PRIMARY KEY,
    user_id UUID NOT NULL,
    state_id UUID NOT NULL,
    granted_by UUID, 
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT fk_user_state_access_user FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE RESTRICT,
    CONSTRAINT fk_user_state_access_state FOREIGN KEY (state_id) REFERENCES state(id) ON DELETE RESTRICT,
    CONSTRAINT fk_user_state_access_granted_by FOREIGN KEY (granted_by) REFERENCES "user"(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX uq_user_state_access ON user_state_access(user_id, state_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_user_state_access_user_id ON user_state_access(user_id) WHERE deleted_at IS NULL AND is_active = true;
CREATE INDEX idx_user_state_access_state_id ON user_state_access(state_id);

CREATE TRIGGER set_updated_at_user_state_access
    BEFORE UPDATE ON user_state_access
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
