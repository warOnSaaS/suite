-- Sign-in with a warOnSaaS account (AUTH_PROVIDER=waronsaas): the account id per person, and the account
-- session behind each web session, so "Sign out everywhere" on the account reaches this server.
ALTER TABLE users ADD COLUMN account_sub TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_account_sub ON users (account_sub);
ALTER TABLE sessions ADD COLUMN account_sid TEXT;
