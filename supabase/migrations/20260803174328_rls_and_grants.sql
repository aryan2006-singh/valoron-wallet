-- Row Level Security: enabled on every table that holds user-visible data.
-- With RLS enabled and no policy, the default is DENY for every role except
-- the table owner (our migration role) and any role with the BYPASSRLS
-- attribute (service_role). That is deliberate: audit_log and
-- idempotency_keys get no policies at all below, so they are invisible to
-- every ordinary client, including logged-in users.
alter table public.users enable row level security;
alter table public.wallet_accounts enable row level security;
alter table public.account_balances enable row level security;
alter table public.ledger_entries enable row level security;
alter table public.escrow_holds enable row level security;
alter table public.withdrawal_requests enable row level security;
alter table public.audit_log enable row level security;
alter table public.idempotency_keys enable row level security;

create policy "users can view own row"
  on public.users for select
  to authenticated
  using (id = auth.uid());

create policy "users can view own wallet accounts"
  on public.wallet_accounts for select
  to authenticated
  using (user_id = auth.uid());

create policy "users can view own account balances"
  on public.account_balances for select
  to authenticated
  using (
    account_id in (
      select id from public.wallet_accounts where user_id = auth.uid()
    )
  );

create policy "users can view own ledger entries"
  on public.ledger_entries for select
  to authenticated
  using (
    account_id in (
      select id from public.wallet_accounts where user_id = auth.uid()
    )
  );

create policy "users can view own escrow holds"
  on public.escrow_holds for select
  to authenticated
  using (funder_id = auth.uid() or worker_id = auth.uid());

create policy "users can view own withdrawal requests"
  on public.withdrawal_requests for select
  to authenticated
  using (user_id = auth.uid());

-- The client-facing balances view. security_invoker = true is the critical
-- setting here: without it, a view runs with the privileges/RLS exemption of
-- its OWNER (the migration role, which bypasses RLS), so the view's WHERE
-- clause would be the ONLY thing standing between a bug and a full data
-- leak. With security_invoker, the underlying tables' own RLS policies are
-- enforced *in addition to* the view's WHERE clause, so a mistake in one
-- layer doesn't expose everyone's balances.
create view public.my_balances
with (security_invoker = true)
as
select
  wa.id as account_id,
  wa.account_type,
  ab.balance_paise
from public.wallet_accounts wa
join public.account_balances ab on ab.account_id = wa.id
where wa.user_id = auth.uid();

-- Explicit, defense-in-depth grants. Nothing is granted to any role by
-- default in this project (verified: a fresh table has zero privileges for
-- anon/authenticated/service_role until we say so), but we spell out the
-- denials anyway so the intent is unambiguous to a future reader.
revoke all on public.users, public.wallet_accounts, public.account_balances,
  public.ledger_entries, public.escrow_holds, public.withdrawal_requests,
  public.audit_log, public.idempotency_keys, public.my_balances
  from anon;

grant select on public.users to authenticated;
grant select on public.wallet_accounts to authenticated;
grant select on public.account_balances to authenticated;
grant select on public.ledger_entries to authenticated;
grant select on public.escrow_holds to authenticated;
grant select on public.withdrawal_requests to authenticated;
grant select on public.my_balances to authenticated;
-- Deliberately no INSERT/UPDATE/DELETE grants to authenticated on any
-- financial table: all writes happen inside SECURITY DEFINER functions,
-- which run as the table owner and so do not need these grants themselves.
