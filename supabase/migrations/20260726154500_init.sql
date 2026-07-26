-- Migration: Init Cliptown Supabase Auth & E2EE Clips table

CREATE SCHEMA IF NOT EXISTS cliptown;

CREATE TABLE IF NOT EXISTS cliptown.clips (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    encrypted_content TEXT NOT NULL,
    nonce TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE cliptown.clips ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can only access their own clips"
ON cliptown.clips
FOR ALL
USING (auth.uid() = user_id);
