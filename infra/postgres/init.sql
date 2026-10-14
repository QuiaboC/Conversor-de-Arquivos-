CREATE TABLE IF NOT EXISTS jobs (
    id UUID PRIMARY KEY,
    original_filename VARCHAR(255) NOT NULL,
    output_format VARCHAR(20) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'pending',
    input_key TEXT,
    output_key TEXT,
    error_message TEXT,
    email VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jobs_status
ON jobs(status);

CREATE INDEX IF NOT EXISTS idx_jobs_created_at
ON jobs(created_at DESC);