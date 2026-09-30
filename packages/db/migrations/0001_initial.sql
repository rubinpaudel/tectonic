CREATE TABLE tenants (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now()
);

CREATE TABLE entities (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  type text NOT NULL,
  name text NOT NULL,
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX entities_tenant_name_idx ON entities(tenant_id, name);

CREATE TABLE entity_aliases (
  tenant_id text NOT NULL,
  entity_id text NOT NULL,
  kind text NOT NULL,
  value text NOT NULL,
  PRIMARY KEY (tenant_id, entity_id, kind, value),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entities(tenant_id, id)
);
CREATE INDEX entity_aliases_lookup_idx ON entity_aliases(tenant_id, kind, value);

CREATE TABLE sources (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  system text NOT NULL CHECK (system IN ('gmail', 'sharepoint', 'teams')),
  external_id text NOT NULL,
  uri text NOT NULL,
  title text NOT NULL,
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT sources_identity_unique UNIQUE (tenant_id, system, external_id)
);

CREATE TABLE source_versions (
  tenant_id text NOT NULL,
  id text NOT NULL,
  source_id text NOT NULL,
  version text NOT NULL,
  content_hash text NOT NULL,
  content_type text NOT NULL,
  content text NOT NULL,
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
  -- ISO text preserves the provider snapshot's offset and fractional precision.
  source_modified_at text CHECK (source_modified_at IS NULL OR source_modified_at::timestamptz IS NOT NULL),
  ingested_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, source_id) REFERENCES sources(tenant_id, id),
  CONSTRAINT source_versions_identity_unique UNIQUE (tenant_id, source_id, version),
  CONSTRAINT source_versions_evidence_unique UNIQUE (tenant_id, source_id, id)
);
CREATE INDEX source_versions_hash_idx ON source_versions(tenant_id, source_id, content_hash);
CREATE INDEX source_versions_latest_idx ON source_versions(tenant_id, source_id, ingested_at);

-- Protect evidence even from accidental UPDATE/DELETE outside the repository.
CREATE FUNCTION reject_source_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'source_versions are immutable; insert a new version' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER source_versions_immutable
  BEFORE UPDATE OR DELETE ON source_versions
  FOR EACH ROW EXECUTE FUNCTION reject_source_version_mutation();

CREATE TABLE memories (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  type text NOT NULL CHECK (type IN ('fact', 'event', 'decision', 'commitment', 'exception', 'issue', 'resolution', 'context')),
  status text NOT NULL CHECK (status IN ('active', 'uncertain', 'conflicting', 'superseded', 'resolved')),
  summary text NOT NULL,
  content jsonb NOT NULL,
  confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  occurred_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX memories_list_idx ON memories(tenant_id, created_at DESC, id);
CREATE INDEX memories_filter_idx ON memories(tenant_id, type, status);
CREATE INDEX memories_timeline_idx ON memories(tenant_id, (coalesce(occurred_at, created_at)), id);

CREATE TABLE memory_entities (
  tenant_id text NOT NULL,
  memory_id text NOT NULL,
  entity_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('subject', 'actor', 'recipient', 'organisation', 'affected')),
  PRIMARY KEY (tenant_id, memory_id, entity_id, role),
  FOREIGN KEY (tenant_id, memory_id) REFERENCES memories(tenant_id, id),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entities(tenant_id, id)
);
CREATE INDEX memory_entities_entity_idx ON memory_entities(tenant_id, entity_id, memory_id);

CREATE TABLE memory_sources (
  tenant_id text NOT NULL,
  memory_id text NOT NULL,
  evidence_key text NOT NULL,
  source_id text NOT NULL,
  source_version_id text NOT NULL,
  locator jsonb CHECK (locator IS NULL OR jsonb_typeof(locator) = 'object'),
  quote text,
  PRIMARY KEY (tenant_id, memory_id, evidence_key),
  FOREIGN KEY (tenant_id, memory_id) REFERENCES memories(tenant_id, id),
  FOREIGN KEY (tenant_id, source_id, source_version_id) REFERENCES source_versions(tenant_id, source_id, id)
);
CREATE INDEX memory_sources_version_idx ON memory_sources(tenant_id, source_version_id);

CREATE TABLE memory_edges (
  tenant_id text NOT NULL,
  from_memory_id text NOT NULL,
  to_memory_id text NOT NULL,
  type text NOT NULL CHECK (type IN ('relates_to', 'caused_by', 'resolves', 'supersedes', 'contradicts', 'follows', 'supports')),
  PRIMARY KEY (tenant_id, from_memory_id, to_memory_id, type),
  FOREIGN KEY (tenant_id, from_memory_id) REFERENCES memories(tenant_id, id),
  FOREIGN KEY (tenant_id, to_memory_id) REFERENCES memories(tenant_id, id)
);
CREATE INDEX memory_edges_incoming_idx ON memory_edges(tenant_id, to_memory_id, type);
