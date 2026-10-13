-- "Remember automatically", per connected app: its MCP instructions tell the app to save lasting
-- facts the user shares without being asked. On unless the user unticks it on the consent screen
-- or turns it off under Connected apps.
ALTER TABLE oauth_codes ADD COLUMN auto_remember boolean NOT NULL DEFAULT true;
ALTER TABLE oauth_grants ADD COLUMN auto_remember boolean NOT NULL DEFAULT true;
