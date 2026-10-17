-- Why the night shift could not refresh a peer card (output over the size rules even after one
-- repair); null while refreshes work. The dashboard shows it; the old card stays in use.
ALTER TABLE collections ADD COLUMN card_blocked text;
