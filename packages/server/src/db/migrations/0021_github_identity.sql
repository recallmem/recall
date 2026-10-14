-- "Continue with GitHub" signs a person in by their GitHub account's numeric id, not by the email
-- address GitHub reports: a verified address can stay on a GitHub account after its owner lost the
-- mailbox (a former employer's domain), and must not keep opening the Recall account of that
-- address. A GitHub account is tied to a user when it creates the user, or when the signed-in user
-- connects it under Settings. `github_login` is the GitHub username, shown in Settings.
ALTER TABLE users ADD COLUMN github_id bigint;
ALTER TABLE users ADD COLUMN github_login text;
CREATE UNIQUE INDEX users_github_id_key ON users (github_id) WHERE github_id IS NOT NULL;
