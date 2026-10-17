-- Tagged links the operator makes in the console (Links page) for the posts they share: a page
-- of the site with a UTM source, medium, campaign and optional content. The console shows each
-- link's visitors (from Umami, by those tags) and the sign-ups whose account carries its source
-- and campaign (accounts.signup_source, signup_campaign; 0029). Archiving hides a link; its tags
-- keep working wherever it was posted.
CREATE TABLE utm_links (
  id          text PRIMARY KEY,
  path        text NOT NULL,
  source      text NOT NULL,
  medium      text NOT NULL,
  campaign    text NOT NULL,
  content     text,
  note        text,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
-- One live link per set of tags, so each one's numbers are its own.
CREATE UNIQUE INDEX utm_links_tags ON utm_links (source, medium, campaign, coalesce(content, ''))
  WHERE archived_at IS NULL;
ALTER TABLE utm_links ENABLE ROW LEVEL SECURITY;
