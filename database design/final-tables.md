# Phase 1: Database-First Architecture - Schema Definitions

## Core Hierarchy Tables

Table: country

PK:
id UUID

FK:
None

Unique:
code

Indexes:
name

Fields:
code
name
iso_code
is_active
created_at
updated_at
deleted_at

Special Rules:
Soft delete enabled. Base of the geographic hierarchy.

---

Table: state

PK:
id UUID

FK:
country_id → country.id

Unique:
(country_id, code)

Indexes:
name
country_id

Fields:
code
name
region
is_active
created_at
updated_at
deleted_at

Special Rules:
Crucial for state-level access control in multi-tenant authorization rules.

---

Table: district

PK:
id UUID

FK:
state_id → state.id

Unique:
(state_id, code)

Indexes:
name
state_id

Fields:
code
name
is_active
created_at
updated_at
deleted_at

Special Rules:
Requires soft-delete cascading or application-level handling to ensure child sub-districts and villages are invalidated if a district is deleted.

---

Table: sub_district

PK:
id UUID

FK:
district_id → district.id

Unique:
(district_id, code)

Indexes:
name
district_id

Fields:
code
name
is_active
created_at
updated_at
deleted_at

Special Rules:
High cardinality table. Indexing `district_id` is essential for hierarchical traversal queries.

---

Table: village

PK:
id UUID

FK:
sub_district_id → sub_district.id

Unique:
(sub_district_id, code)

Indexes:
name
sub_district_id

Fields:
code
name
pin_code
is_active
created_at
updated_at
deleted_at

Special Rules:
Highest volume operational table. `pin_code` requires a check constraint to ensure valid formatting. Any updates to `name` or `pin_code` must propagate to the `village_search` projection table.

---

## Search Projection

Table: village_search

PK:
village_id UUID

FK:
village_id → village.id (One-to-One)
state_id → state.id (For tenant access filtering)

Unique:
village_id

Indexes:
search_text_trgm (GIN index using pg_trgm)
pin_code (B-Tree index)
state_id (B-Tree index)

Fields:
village_id
search_text (Denormalized concatenation of Village, Sub-District, District, State)
pin_code
state_id
state_name
district_name
sub_district_name
village_name
is_active
last_synced_at

Special Rules:
This is a materialized projection table strictly for high-speed autocomplete and search. Do NOT use this as the source of truth. Updates to this table should be handled via database triggers or asynchronous workers listening to hierarchy changes.

---

## SaaS Multi-Tenant & Auth Tables

Table: subscription_plan

PK:
id UUID

FK:
None

Unique:
name

Indexes:
is_active

Fields:
name
max_requests_per_month
max_requests_per_second
allowed_states_count
price_in_cents
is_active
created_at
updated_at

Special Rules:
Used to enforce rate limits and geographical constraints. Tier changes impact the `user_state_access` table restrictions.

---

Table: user

PK:
id UUID

FK:
subscription_plan_id → subscription_plan.id

Unique:
email

Indexes:
email
subscription_plan_id

Fields:
email
password_hash
first_name
last_name
role (Enum: ADMIN, CUSTOMER)
status (Enum: PENDING, ACTIVE, SUSPENDED)
subscription_plan_id
created_at
updated_at

Special Rules:
Represents the core tenant. Actions and API usages are aggregated back to this entity for billing and analytical purposes.

---

Table: api_key

PK:
id UUID

FK:
user_id → user.id

Unique:
key_hash

Indexes:
user_id
is_active

Fields:
key_prefix
key_hash
name
is_active
expires_at
last_used_at
created_at
updated_at
deleted_at

Special Rules:
NEVER store the raw API key. The application must generate a high-entropy key, store its SHA-256 hash in `key_hash`, and a 4-8 character `key_prefix` for the user interface. High frequency read table; keep it fully cached in Redis.

---

Table: user_state_access

PK:
id UUID

FK:
user_id → user.id
state_id → state.id

Unique:
(user_id, state_id)

Indexes:
user_id
state_id

Fields:
user_id
state_id
granted_at
granted_by (UUID of Admin)
created_at

Special Rules:
Maps exactly which states a user is authorized to query. The API layer must enforce this list when fetching data.

---

## Observability

Table: api_log

PK:
(id, created_at)

FK:
api_key_id → api_key.id (Conceptual/Logical FK, see rules below)

Unique:
None

Indexes:
api_key_id
created_at
endpoint

Fields:
id UUID
api_key_id UUID
endpoint
method
status_code
response_time_ms
ip_address
user_agent
request_payload JSONB
error_message
created_at (Timestamp without timezone)

Special Rules:
Must be partitioned by range on `created_at` (e.g., daily or weekly partitions). High-volume, append-only table. Do NOT enforce a hard Foreign Key constraint on `api_key_id` in production to avoid lock contention on inserts.

---

# Principal Architect Review

### 1. Weak Schema Decisions
* **UUIDv4 as Primary Keys:** Using random UUIDv4 can cause severe B-tree index fragmentation leading to poor insert performance and bloated caches. 
  * *Correction:* Use time-sorted UUIDv7 or KSUID instead of UUIDv4 for all primary keys.
* **Cascading Soft Deletes:** Querying the hierarchy (e.g., finding active villages) requires checking `deleted_at IS NULL` at the sub_district, district, state, and country level to be truly safe.
  * *Correction:* Denormalize a global `hierarchy_active` boolean on the `village_search` projection table to simplify read-heavy queries.

### 2. Dangerous Production Risks
* **`api_log` Payload Storage:** Storing full `request_payload` and `response_payload` as JSONB on every single API hit will rapidly explode database storage and degrade I/O performance.
  * *Correction:* Only log request payloads for `4xx` and `5xx` errors. Do not log payloads for successful `200` GET requests. Consider shipping these logs to an external store (e.g., ClickHouse or ElasticSearch) entirely instead of PostgreSQL if volume > 100 req/sec.
* **Synchronous Search Projection:** If `village_search` is updated synchronously via DB triggers during bulk geographical imports, it will cause lock contention and slow down the migration.
  * *Correction:* Decouple the projection updates using an asynchronous queue or a background worker.

### 3. Missing Constraints
* **Pin Code Validation:** The `pin_code` field is highly susceptible to dirty data.
  * *Correction:* Add a `CHECK (pin_code ~ '^[1-9][0-9]{5}$')` constraint at the database level to ensure strict 6-digit Indian PIN code formatting.
* **Sanity Checks on Enums/States:** `is_active` defaults should be explicitly declared at the DB layer to prevent null states.

### 4. API Key Security Improvements
* **Hashing Strategy:** Do NOT use bcrypt or Argon2 for `api_key` hashing. API keys have very high entropy already. Bcrypt is intentionally slow and will bottleneck your API authentication middleware.
  * *Correction:* Use a fast cryptographic hash like SHA-256 for API keys.
* **Key Rotation:** There is no infrastructure for rolling keys.
  * *Correction:* Introduce a `rolled_at` column, and allow two keys to be briefly active simultaneously to enable zero-downtime key rotation for enterprise users.

### 5. Multi-Tenant Design Corrections
* **Plan Downgrades:** If a user downgrades from an "All India" plan to a "Single State" plan, the `user_state_access` table will hold stale, invalid authorizations.
  * *Correction:* Application logic must implement a strict cleanup routine for `user_state_access` whenever a `subscription_plan_id` changes. Add an `is_active` flag to `user_state_access` to softly revoke access without deleting audit history.

### 6. Partitioning Corrections
* **api_log Partition Strategy:** PostgreSQL does not automatically create new partitions. If the application hits a date without an existing partition, inserts will fail, causing API downtime.
  * *Correction:* Implement a cron job (or use `pg_partman`) to pre-create partitions 30 days in advance.
* **Composite Primary Key:** Partitioned tables in PostgreSQL require the partition key to be part of the Primary Key. Hence, `PK: (id, created_at)` is mandatory.

### 7. Search Optimization Improvements
* **pg_trgm Limitations:** GIN indexes using `pg_trgm` are excellent for wildcard `LIKE '%query%'` searches but have significant write overhead.
  * *Correction:* Prefix search (e.g., `LIKE 'query%'`) can use a standard `text_pattern_ops` B-tree index, which is much faster to update. Only use the `pg_trgm` GIN index if you truly need substring matching from the *middle* of the string. Keep the `pin_code` search exclusively on a B-tree index.
