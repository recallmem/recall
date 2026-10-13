-- A sign-in link's "continue to" page (an OAuth consent request) is followed only in the browser
-- that asked for the link: a keyed hash of that browser's anonymous cookie, never the cookie.
ALTER TABLE login_tokens ADD COLUMN next_browser text;

-- A key minted by another key (POST /v3/keys) dies with it: revoking a leaked key also revokes
-- every key it minted, and the keys those minted.
ALTER TABLE api_keys ADD COLUMN minted_by text REFERENCES api_keys(id) ON DELETE CASCADE;
CREATE INDEX api_keys_minted_by_idx ON api_keys (minted_by) WHERE minted_by IS NOT NULL;
