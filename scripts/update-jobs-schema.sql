-- Add expiry columns to existing jobs table
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT 'manual';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS external_id VARCHAR(255);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS category VARCHAR(100);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS salary VARCHAR(255);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS recruiter_id VARCHAR(255);

-- Add indexes for better performance
CREATE INDEX IF NOT EXISTS idx_jobs_expires_at ON jobs(expires_at);
CREATE INDEX IF NOT EXISTS idx_jobs_is_active ON jobs(is_active);
CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source);
CREATE INDEX IF NOT EXISTS idx_jobs_external_id ON jobs(external_id);

-- Function to automatically expire old jobs
CREATE OR REPLACE FUNCTION expire_old_jobs()
RETURNS INTEGER AS $$
DECLARE
    expired_count INTEGER;
BEGIN
    UPDATE jobs 
    SET is_remote = false  -- Using is_remote as is_active substitute temporarily
    WHERE expires_at < NOW() 
    AND is_remote = true;
    
    GET DIAGNOSTICS expired_count = ROW_COUNT;
    
    RETURN expired_count;
END;
$$ LANGUAGE plpgsql;

-- Set default expiry for existing jobs (30 days from now)
UPDATE jobs 
SET expires_at = NOW() + INTERVAL '30 days',
    scraped_at = NOW() - INTERVAL '1 day'
WHERE expires_at IS NULL;