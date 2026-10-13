-- OAuth 2.1 for the hosted MCP endpoint (hosted mode only: self-hosted installs
-- keep API keys and never write to these tables).
--
-- MCP clients (Claude, ChatGPT, editors) register themselves (RFC 7591) or
-- identify with a client ID metadata document (an https URL as client_id), a
-- signed-in dashboard user approves them on a consent screen, and the client
-- gets short-lived access tokens plus rotating refresh tokens bound to the MCP
-- endpoint. Like API keys and magic links, every secret (codes and tokens) is
-- stored only as a SHA-256 hash.

-- Clients. `id` is the client_id: "rc_<random>" for registered clients, or the
-- https URL of a client ID metadata document (cached here, re-fetched after
-- `refresh_after`). Clients are public: there is no client secret to store.
CREATE TABLE oauth_clients (
  id                   text PRIMARY KEY,
  kind                 text NOT NULL CHECK (kind IN ('registered', 'metadata_document')),
  name                 text NOT NULL,
  redirect_uris        text[] NOT NULL,
  -- The accepted registration as returned to the client (or the fetched document's fields we keep).
  metadata             jsonb NOT NULL DEFAULT '{}',
  -- Keyed hash of the registering client's network, for the registration rate limit.
  registration_ip_hash text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  refresh_after        timestamptz,
  -- When the client last received an authorization code; never-used clients are purged.
  last_used_at         timestamptz
);
CREATE INDEX oauth_clients_ip_idx ON oauth_clients (registration_ip_hash, created_at);
CREATE INDEX oauth_clients_created_idx ON oauth_clients (created_at);

-- A user's approval of a client for one account: the workspaces it may use
-- (NULL = every workspace of the account) and the connection's defaults. One
-- grant is one token family: revoking it (dashboard, refresh-token reuse,
-- authorization-code replay) ends every token issued under it.
CREATE TABLE oauth_grants (
  id                text PRIMARY KEY,
  account_id        text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id           text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id         text NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  redirect_uri      text NOT NULL,
  -- RFC 8707 resource (the MCP endpoint's URL) the tokens are audience-bound to.
  resource          text NOT NULL,
  scope             text NOT NULL,
  workspaces        text[],
  default_workspace text NOT NULL,
  default_peer      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_used_at      timestamptz,
  revoked_at        timestamptz,
  revoked_reason    text
);
CREATE INDEX oauth_grants_account_idx ON oauth_grants (account_id, created_at);
CREATE INDEX oauth_grants_client_idx ON oauth_grants (client_id);
CREATE INDEX oauth_grants_user_idx ON oauth_grants (user_id);

-- Authorization codes: single use, valid for 60 seconds. The consent decision
-- travels with the code, and the grant is created when the code is exchanged.
-- `grant_id` records that grant so a replayed code can revoke it (RFC 6749 4.1.2).
CREATE TABLE oauth_codes (
  id                text PRIMARY KEY,
  code_hash         text NOT NULL UNIQUE,
  client_id         text NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  account_id        text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id           text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri      text NOT NULL,
  code_challenge    text NOT NULL,
  resource          text NOT NULL,
  scope             text NOT NULL,
  workspaces        text[],
  default_workspace text NOT NULL,
  default_peer      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  used_at           timestamptz,
  replayed_at       timestamptz,
  grant_id          text
);
CREATE INDEX oauth_codes_expires_idx ON oauth_codes (expires_at);

-- Access tokens (1 hour) and refresh tokens (rotated on every use: a used one
-- presented again revokes its grant).
CREATE TABLE oauth_tokens (
  id         text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  grant_id   text NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('access', 'refresh')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  revoked_at timestamptz
);
CREATE INDEX oauth_tokens_grant_idx ON oauth_tokens (grant_id, kind);
CREATE INDEX oauth_tokens_expires_idx ON oauth_tokens (expires_at);

-- Where to go after a magic-link sign-in (an /oauth/authorize request that
-- needed a signed-in user). Server-side, so the emailed link stays short.
ALTER TABLE login_tokens ADD COLUMN next_path text;

ALTER TABLE oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_tokens ENABLE ROW LEVEL SECURITY;
