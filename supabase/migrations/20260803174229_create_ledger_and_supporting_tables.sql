-- The append-only source of truth. Every movement of money is a row here.
create table public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.wallet_accounts(id),
  amount_paise bigint not null check (amount_paise <> 0),
  entry_type text not null,
  transaction_id uuid not null,
  idempotency_key text not null,
  reference_type text,
  reference_id uuid,
  created_at timestamptz not null default now()
);

create index ledger_entries_transaction_id_idx on public.ledger_entries (transaction_id);
create index ledger_entries_account_id_created_at_idx on public.ledger_entries (account_id, created_at);

-- Tracks which idempotency keys have already been used, and which transaction
-- they map to, so a replayed request can be answered with the original result
-- instead of re-running the operation.
create table public.idempotency_keys (
  key text primary key,
  transaction_id uuid not null,
  created_at timestamptz not null default now()
);

create table public.escrow_holds (
  id uuid primary key default gen_random_uuid(),
  funder_id uuid not null references public.users(id),
  worker_id uuid not null references public.users(id),
  amount_paise bigint not null check (amount_paise > 0),
  status text not null default 'held' check (status in ('held', 'released', 'refunded')),
  created_at timestamptz not null default now()
);

create table public.withdrawal_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id),
  amount_paise bigint not null check (amount_paise > 0),
  destination text not null,
  status text not null default 'pending' check (status in ('pending', 'settled', 'failed')),
  created_at timestamptz not null default now()
);

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.users(id),
  action text not null,
  target_id uuid,
  ip text,
  result text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);

-- Enforce append-only at the database level: even a bug (or a malicious
-- direct connection) that tries to UPDATE or DELETE a row gets rejected.
create function public.prevent_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'this table is append-only: % is not allowed', tg_op
    using errcode = 'P0002';
end;
$$;

create trigger ledger_entries_no_update
  before update on public.ledger_entries
  for each row execute function public.prevent_mutation();

create trigger ledger_entries_no_delete
  before delete on public.ledger_entries
  for each row execute function public.prevent_mutation();

create trigger audit_log_no_update
  before update on public.audit_log
  for each row execute function public.prevent_mutation();

create trigger audit_log_no_delete
  before delete on public.audit_log
  for each row execute function public.prevent_mutation();

-- The core invariant: every transaction_id's entries must sum to zero.
-- This is a "constraint trigger" deferred to the end of the transaction,
-- because every RPC function writes all of one operation's entries (e.g.
-- debit sender, credit recipient, credit platform fee) in a single INSERT
-- statement. A STATEMENT-level trigger with a transition table checks
-- exactly that batch of rows as soon as the statement finishes -- this is
-- simpler and more robust than a deferred-to-commit row-level trigger, which
-- depends on transaction-boundary timing that varies by caller.
create function public.check_transaction_balances()
returns trigger
language plpgsql
as $$
declare
  v_bad_count int;
begin
  select count(*) into v_bad_count
  from (
    select transaction_id, sum(amount_paise) as total
    from new_rows
    group by transaction_id
  ) totals
  where totals.total <> 0;

  if v_bad_count > 0 then
    raise exception 'one or more transactions in this statement do not sum to zero'
      using errcode = 'P0003';
  end if;

  return null;
end;
$$;

create trigger ledger_entries_balance_check
  after insert on public.ledger_entries
  referencing new table as new_rows
  for each statement
  execute function public.check_transaction_balances();
