-- Three demo users for the UI and the proof script. All start at INR 0 --
-- their wallet_accounts / account_balances rows are created automatically by
-- the provision_user_accounts trigger (see 20260803143254_create_wallet_accounts.sql),
-- never by inserting a starting balance here.
--
-- Note: the token columns below (confirmation_token, recovery_token, etc.)
-- must be set to '' rather than left NULL. GoTrue's Go code scans these as
-- plain strings, and a NULL there causes every auth request for this user to
-- fail with "Scan error ... converting NULL to string is unsupported" --
-- harmless-looking until you actually try to log in.
create extension if not exists pgcrypto;

insert into auth.users
  (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
   raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
   confirmation_token, recovery_token, email_change_token_new, email_change,
   email_change_token_current, phone_change, phone_change_token, reauthentication_token)
values
  ('a0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'alice@valoron.test', crypt('demopassword123', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', '', '', '', '', '', ''),
  ('a0000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'bob@valoron.test', crypt('demopassword123', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', '', '', '', '', '', ''),
  ('a0000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'carol@valoron.test', crypt('demopassword123', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', '', '', '', '', '', '');
