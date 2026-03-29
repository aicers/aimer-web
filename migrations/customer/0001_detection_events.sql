CREATE TABLE detection_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aice_id TEXT NOT NULL,
    payload BYTEA NOT NULL,
    wrapped_dek TEXT NOT NULL,
    event_count INTEGER NOT NULL CHECK (event_count > 0),
    schema_version TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('bridge', 'manual')),
    connection_id UUID,
    ingested_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_detection_events_aice_id ON detection_events (aice_id);
CREATE INDEX idx_detection_events_created_at ON detection_events (created_at DESC);

-- Runtime role grants
GRANT SELECT, INSERT ON detection_events TO aimer_customer;
