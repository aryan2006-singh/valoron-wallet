-- service_role already has the BYPASSRLS attribute (set up by Supabase's own
-- roles bootstrap) and is only ever used from trusted server-side code (the
-- webhook route handlers) -- never exposed to the browser. But BYPASSRLS and
-- table-level GRANTs are two independent layers: bypassing RLS does nothing
-- if the role was never granted the base privilege on the table in the
-- first place. Our earlier migrations only granted service_role narrow
-- access (audit_log, payment_intents) and relied on SECURITY DEFINER to
-- cover the rest -- which works for a direct `SET ROLE` SQL session, but not
-- for every call path PostgREST uses. Since service_role is already
-- fully trusted in this architecture, the correct fix is to grant it
-- explicitly, rather than lean on an implicit side effect of SECURITY DEFINER.
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant execute on functions to service_role;
