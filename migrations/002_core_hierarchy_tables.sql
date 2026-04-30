-- migrations/002_core_hierarchy_tables.sql
-- Description: Creates the normalized geo-hierarchy tables for the platform with enterprise-grade constraints.

-- Generic function to automatically update 'updated_at' timestamp
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 1. country
CREATE TABLE country (
    id UUID DEFAULT gen_random_uuid() CONSTRAINT pk_country PRIMARY KEY,
    code VARCHAR(3) NOT NULL,
    name VARCHAR(255) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT chk_country_code_not_empty CHECK (trim(code) <> ''),
    CONSTRAINT chk_country_name_not_empty CHECK (trim(name) <> '')
);
CREATE UNIQUE INDEX uq_country_code ON country(code) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_country_name ON country(name) WHERE deleted_at IS NULL;
CREATE INDEX idx_country_name ON country(name);

CREATE TRIGGER set_updated_at_country
    BEFORE UPDATE ON country
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- 2. state
CREATE TABLE state (
    id UUID DEFAULT gen_random_uuid() CONSTRAINT pk_state PRIMARY KEY,
    country_id UUID NOT NULL,
    code VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    region VARCHAR(100),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT fk_state_country FOREIGN KEY (country_id) REFERENCES country(id) ON DELETE RESTRICT,
    CONSTRAINT chk_state_code_not_empty CHECK (trim(code) <> ''),
    CONSTRAINT chk_state_name_not_empty CHECK (trim(name) <> '')
);
CREATE UNIQUE INDEX uq_state_country_code ON state(country_id, code) WHERE deleted_at IS NULL;
CREATE INDEX idx_state_country_id ON state(country_id);
CREATE INDEX idx_state_name ON state(name);

CREATE TRIGGER set_updated_at_state
    BEFORE UPDATE ON state
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- 3. district
CREATE TABLE district (
    id UUID DEFAULT gen_random_uuid() CONSTRAINT pk_district PRIMARY KEY,
    state_id UUID NOT NULL,
    code VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT fk_district_state FOREIGN KEY (state_id) REFERENCES state(id) ON DELETE RESTRICT,
    CONSTRAINT chk_district_code_not_empty CHECK (trim(code) <> ''),
    CONSTRAINT chk_district_name_not_empty CHECK (trim(name) <> '')
);
CREATE UNIQUE INDEX uq_district_state_code ON district(state_id, code) WHERE deleted_at IS NULL;
CREATE INDEX idx_district_state_id ON district(state_id);
CREATE INDEX idx_district_name ON district(name);

CREATE TRIGGER set_updated_at_district
    BEFORE UPDATE ON district
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- 4. sub_district
CREATE TABLE sub_district (
    id UUID DEFAULT gen_random_uuid() CONSTRAINT pk_sub_district PRIMARY KEY,
    district_id UUID NOT NULL,
    code VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT fk_sub_district_district FOREIGN KEY (district_id) REFERENCES district(id) ON DELETE RESTRICT,
    CONSTRAINT chk_sub_district_code_not_empty CHECK (trim(code) <> ''),
    CONSTRAINT chk_sub_district_name_not_empty CHECK (trim(name) <> '')
);
CREATE UNIQUE INDEX uq_sub_district_district_code ON sub_district(district_id, code) WHERE deleted_at IS NULL;
CREATE INDEX idx_sub_district_district_id ON sub_district(district_id);
CREATE INDEX idx_sub_district_name ON sub_district(name);

CREATE TRIGGER set_updated_at_sub_district
    BEFORE UPDATE ON sub_district
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- 5. village
CREATE TABLE village (
    id UUID DEFAULT gen_random_uuid() CONSTRAINT pk_village PRIMARY KEY,
    sub_district_id UUID NOT NULL,
    code VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    population INT,
    pin_code VARCHAR(10),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT fk_village_sub_district FOREIGN KEY (sub_district_id) REFERENCES sub_district(id) ON DELETE RESTRICT,
    CONSTRAINT chk_village_code_not_empty CHECK (trim(code) <> ''),
    CONSTRAINT chk_village_name_not_empty CHECK (trim(name) <> ''),
    CONSTRAINT chk_village_pin_code CHECK (pin_code IS NULL OR pin_code ~ '^[0-9]{6}$')
);
CREATE UNIQUE INDEX uq_village_sub_district_code ON village(sub_district_id, code) WHERE deleted_at IS NULL;
CREATE INDEX idx_village_sub_district_active ON village(sub_district_id, name) WHERE deleted_at IS NULL AND is_active = true;
CREATE INDEX idx_village_code ON village(code);
CREATE INDEX idx_village_name ON village(name);
CREATE INDEX idx_village_pin_code ON village(pin_code);

CREATE TRIGGER set_updated_at_village
    BEFORE UPDATE ON village
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
