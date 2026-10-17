-- Where a self-serve sign-up came from, for the operator console's Traffic page: the landing page
-- adds the visit's UTM source and campaign (else the referring site's host) to its links to the
-- sign-in page, in the page itself; no cookie or storage is involved. The sign-in page
-- keeps it through the emailed link (on the login token) and the GitHub round trip (in the signed
-- state), and the transaction that creates the account stores it. Null when unknown.
ALTER TABLE accounts ADD COLUMN signup_source text;
ALTER TABLE accounts ADD COLUMN signup_campaign text;
ALTER TABLE login_tokens ADD COLUMN signup_source text;
ALTER TABLE login_tokens ADD COLUMN signup_campaign text;
