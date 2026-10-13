-- Whether a model call's cost_usd is an estimate: the list price of its tokens (the price table,
-- RECALL_PRICING_JSON or OpenRouter's catalog) rather than a cost the provider reported. OpenRouter
-- reports its calls' cost; a call on the operator's own provider key (BYOK) that reports no
-- upstream charge is estimated at list price instead of being recorded as free (src/llm/openrouter.ts).
-- Null on rows written before this column existed. Nullable without a default, so adding it
-- rewrites nothing.
ALTER TABLE llm_usage ADD COLUMN cost_estimated boolean;
