-- A pending deposit created by POST /api/deposit/intent. The webhook later
-- resolves which user to credit from THIS row's user_id (via intent_id in
-- the webhook payload), never from a user_id the caller could put in the
-- webhook body directly.
create table public.payment_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id),
  amount_paise bigint not null check (amount_paise > 0),
  status text not null default 'pending' check (status in ('pending', 'completed')),
  created_at timestamptz not null default now()
);

alter table public.payment_intents enable row level security;

create policy "users can view own payment intents"
  on public.payment_intents for select
  to authenticated
  using (user_id = auth.uid());

revoke all on public.payment_intents from anon;
grant select on public.payment_intents to authenticated;
grant select, insert on public.payment_intents to service_role;

-- The two webhook handlers (running with the service_role key, server-side
-- only) need to be able to create the pending intent row's completion and
-- write audit_log entries for both successful and rejected attempts -- the
-- rejections happen *before* any RPC call (bad signature, replay, etc.), so
-- there is no database transaction for them to ride along with; the API
-- route logs them directly using this grant.
grant insert, select on public.audit_log to service_role;
grant update (status) on public.payment_intents to service_role;
