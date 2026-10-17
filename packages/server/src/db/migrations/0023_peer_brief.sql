-- A brief per collection: a short dated account of what memory knows about the observed peer,
-- kept up to date by dreams from the facts learned since `brief_through`.
ALTER TABLE collections ADD COLUMN brief text;
ALTER TABLE collections ADD COLUMN brief_through timestamptz;

-- A brief may quote any fact of its collection, so deleting one (by a person, an erasure, a scope
-- leaving) drops the brief; the next dream writes it again from what is left. Facts a dream merges
-- into another stay represented by the survivor and keep the brief. (The function body stays on
-- one line: the migration runner ends a statement at a semicolon followed by a newline.)
CREATE FUNCTION conclusions_drop_brief() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP = 'DELETE' THEN UPDATE collections SET brief = NULL, brief_through = NULL WHERE id IN (SELECT DISTINCT collection_id FROM gone) AND brief_through IS NOT NULL; ELSE UPDATE collections SET brief = NULL, brief_through = NULL WHERE id = NEW.collection_id AND brief_through IS NOT NULL; END IF; RETURN NULL; END $$;
CREATE TRIGGER conclusions_brief_on_delete AFTER DELETE ON conclusions
  REFERENCING OLD TABLE AS gone FOR EACH STATEMENT EXECUTE FUNCTION conclusions_drop_brief();
CREATE TRIGGER conclusions_brief_on_soft_delete AFTER UPDATE OF deleted_at ON conclusions
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND NOT (NEW.internal ? 'merged_into'))
  EXECUTE FUNCTION conclusions_drop_brief();
