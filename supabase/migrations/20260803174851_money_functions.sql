-- ============================================================================
-- Rate limiting: a Postgres-backed counter, not an in-memory one, because
-- serverless API routes run as many independent instances that don't share
-- memory. A durable table is the only place that can be truthfully counted
-- from every instance.
-- ============================================================================
create table public.rate_limit_events (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  action text not null,
  created_at timestamptz not null default now()
);

create index rate_limit_events_user_action_created_idx
  on public.rate_limit_events (user_id, action, created_at);

alter table public.rate_limit_events enable row level security;
revoke all on public.rate_limit_events from anon, authenticated;

create function public.enforce_rate_limit(p_user_id uuid, p_action text, p_max_per_hour int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  select count(*) into v_count
  from public.rate_limit_events
  where user_id = p_user_id
    and action = p_action
    and created_at > now() - interval '1 hour';

  if v_count >= p_max_per_hour then
    raise exception 'rate limit exceeded for %', p_action using errcode = 'P1006';
  end if;

  insert into public.rate_limit_events (user_id, action) values (p_user_id, p_action);
end;
$$;

-- ============================================================================
-- Idempotency: the first caller to use a given key "claims" it. Everyone
-- else who ever passes that same key back (a retry, a duplicate double-click,
-- 20 parallel copies of the same webhook) gets routed to the ALREADY
-- DECIDED transaction_id instead of re-running the operation.
-- ============================================================================
create function public.claim_idempotency_key(p_key text, p_transaction_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing_transaction_id uuid;
begin
  insert into public.idempotency_keys (key, transaction_id)
  values (p_key, p_transaction_id)
  on conflict (key) do nothing;

  if found then
    return p_transaction_id;
  end if;

  select transaction_id into v_existing_transaction_id
  from public.idempotency_keys
  where key = p_key;

  return v_existing_transaction_id;
end;
$$;

-- ============================================================================
-- credit_deposit: platform_genesis -> user available.
-- Callable only by the webhook handler (service_role) -- see grants at the
-- bottom of this file. Never callable by an end user, at any amount, for
-- any reason: that is the entire "no free money" rule for this project.
-- ============================================================================
create function public.credit_deposit(
  p_user_id uuid,
  p_amount_paise bigint,
  p_provider_payment_id text,
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transaction_id uuid := gen_random_uuid();
  v_claimed_transaction_id uuid;
  v_genesis_account_id uuid;
  v_user_available_id uuid;
begin
  if p_amount_paise <= 0 then
    raise exception 'amount_paise must be positive' using errcode = 'P1005';
  end if;

  v_claimed_transaction_id := public.claim_idempotency_key(p_idempotency_key, v_transaction_id);
  if v_claimed_transaction_id <> v_transaction_id then
    return v_claimed_transaction_id;
  end if;

  select id into v_genesis_account_id
  from public.wallet_accounts
  where account_type = 'platform_genesis' and user_id is null
  for update;

  select id into v_user_available_id
  from public.wallet_accounts
  where user_id = p_user_id and account_type = 'available'
  for update;

  if v_user_available_id is null then
    raise exception 'no available account for user %', p_user_id using errcode = 'P1004';
  end if;

  insert into public.ledger_entries
    (account_id, amount_paise, entry_type, transaction_id, idempotency_key, reference_type, reference_id)
  values
    (v_genesis_account_id, -p_amount_paise, 'deposit', v_transaction_id, p_idempotency_key, 'deposit', v_transaction_id),
    (v_user_available_id, p_amount_paise, 'deposit', v_transaction_id, p_idempotency_key, 'deposit', v_transaction_id);

  update public.account_balances set balance_paise = balance_paise - p_amount_paise where account_id = v_genesis_account_id;
  update public.account_balances set balance_paise = balance_paise + p_amount_paise where account_id = v_user_available_id;

  insert into public.audit_log (actor_id, action, target_id, result, detail)
  values (p_user_id, 'credit_deposit', v_user_available_id, 'success',
    jsonb_build_object('amount_paise', p_amount_paise, 'provider_payment_id', p_provider_payment_id));

  return v_transaction_id;
end;
$$;

-- ============================================================================
-- send_support: sender available -> recipient available (70%) + platform_fee
-- (30%). The fee is floor(amount * 30 / 100); the recipient gets whatever is
-- left, so fee + recipient_amount == amount_paise is true by construction,
-- never by luck, for every amount down to 1 paise.
-- ============================================================================
create function public.send_support(
  p_sender_id uuid,
  p_recipient_id uuid,
  p_amount_paise bigint,
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transaction_id uuid := gen_random_uuid();
  v_claimed_transaction_id uuid;
  v_sender_available_id uuid;
  v_recipient_available_id uuid;
  v_platform_fee_id uuid;
  v_sender_balance bigint;
  v_fee_amount bigint;
  v_recipient_amount bigint;
begin
  if auth.uid() is distinct from p_sender_id then
    raise exception 'only the sender may send from their own wallet' using errcode = 'P1002';
  end if;

  if p_amount_paise <= 0 then
    raise exception 'amount_paise must be positive' using errcode = 'P1005';
  end if;

  if p_sender_id = p_recipient_id then
    raise exception 'cannot send support to yourself' using errcode = 'P1005';
  end if;

  perform public.enforce_rate_limit(p_sender_id, 'send_support', 60);

  v_claimed_transaction_id := public.claim_idempotency_key(p_idempotency_key, v_transaction_id);
  if v_claimed_transaction_id <> v_transaction_id then
    return v_claimed_transaction_id;
  end if;

  select id into v_sender_available_id from public.wallet_accounts where user_id = p_sender_id and account_type = 'available';
  select id into v_recipient_available_id from public.wallet_accounts where user_id = p_recipient_id and account_type = 'available';
  select id into v_platform_fee_id from public.wallet_accounts where account_type = 'platform_fee' and user_id is null;

  if v_recipient_available_id is null then
    raise exception 'recipient % does not exist', p_recipient_id using errcode = 'P1004';
  end if;

  -- Lock every account this operation touches, always in the same
  -- (account_id) order, so a transfer A->B running at the same instant as
  -- one going B->A can never deadlock against this one.
  perform 1 from public.wallet_accounts
    where id in (v_sender_available_id, v_recipient_available_id, v_platform_fee_id)
    order by id
    for update;

  select balance_paise into v_sender_balance from public.account_balances where account_id = v_sender_available_id;

  v_fee_amount := (p_amount_paise * 30) / 100;
  v_recipient_amount := p_amount_paise - v_fee_amount;

  if v_sender_balance < p_amount_paise then
    raise exception 'insufficient funds' using errcode = 'P1001';
  end if;

  insert into public.ledger_entries
    (account_id, amount_paise, entry_type, transaction_id, idempotency_key, reference_type, reference_id)
  values
    (v_sender_available_id, -p_amount_paise, 'support_send', v_transaction_id, p_idempotency_key, 'support', v_transaction_id),
    (v_recipient_available_id, v_recipient_amount, 'support_receive', v_transaction_id, p_idempotency_key, 'support', v_transaction_id),
    (v_platform_fee_id, v_fee_amount, 'support_fee', v_transaction_id, p_idempotency_key, 'support', v_transaction_id);

  update public.account_balances set balance_paise = balance_paise - p_amount_paise where account_id = v_sender_available_id;
  update public.account_balances set balance_paise = balance_paise + v_recipient_amount where account_id = v_recipient_available_id;
  update public.account_balances set balance_paise = balance_paise + v_fee_amount where account_id = v_platform_fee_id;

  insert into public.audit_log (actor_id, action, target_id, result, detail)
  values (p_sender_id, 'send_support', p_recipient_id, 'success',
    jsonb_build_object('amount_paise', p_amount_paise, 'fee_amount', v_fee_amount, 'recipient_amount', v_recipient_amount));

  return v_transaction_id;
end;
$$;

-- ============================================================================
-- request_withdrawal: available -> payout. The money becomes unspendable the
-- instant this commits, because it has already left the `available` bucket
-- entirely -- there is no separate "hold" flag to check elsewhere, just a
-- balance that is genuinely gone from `available`.
-- ============================================================================
create function public.request_withdrawal(
  p_caller_id uuid,
  p_amount_paise bigint,
  p_destination text,
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transaction_id uuid := gen_random_uuid();
  v_claimed_transaction_id uuid;
  v_available_id uuid;
  v_payout_id uuid;
  v_available_balance bigint;
  v_minimum_paise bigint := 10000; -- INR 100.00 - see NOTES.md for justification
begin
  if auth.uid() is distinct from p_caller_id then
    raise exception 'only the account owner may request a withdrawal' using errcode = 'P1002';
  end if;

  if p_amount_paise <= 0 then
    raise exception 'amount_paise must be positive' using errcode = 'P1005';
  end if;

  if p_amount_paise < v_minimum_paise then
    raise exception 'amount below minimum withdrawal of % paise', v_minimum_paise using errcode = 'P1005';
  end if;

  perform public.enforce_rate_limit(p_caller_id, 'request_withdrawal', 10);

  v_claimed_transaction_id := public.claim_idempotency_key(p_idempotency_key, v_transaction_id);
  if v_claimed_transaction_id <> v_transaction_id then
    return v_claimed_transaction_id;
  end if;

  select id into v_available_id from public.wallet_accounts where user_id = p_caller_id and account_type = 'available';
  select id into v_payout_id from public.wallet_accounts where user_id = p_caller_id and account_type = 'payout';

  perform 1 from public.wallet_accounts where id in (v_available_id, v_payout_id) order by id for update;

  select balance_paise into v_available_balance from public.account_balances where account_id = v_available_id;

  if v_available_balance < p_amount_paise then
    raise exception 'insufficient funds' using errcode = 'P1001';
  end if;

  insert into public.withdrawal_requests (id, user_id, amount_paise, destination, status)
  values (v_transaction_id, p_caller_id, p_amount_paise, p_destination, 'pending');

  insert into public.ledger_entries
    (account_id, amount_paise, entry_type, transaction_id, idempotency_key, reference_type, reference_id)
  values
    (v_available_id, -p_amount_paise, 'withdrawal_request', v_transaction_id, p_idempotency_key, 'withdrawal', v_transaction_id),
    (v_payout_id, p_amount_paise, 'withdrawal_request', v_transaction_id, p_idempotency_key, 'withdrawal', v_transaction_id);

  update public.account_balances set balance_paise = balance_paise - p_amount_paise where account_id = v_available_id;
  update public.account_balances set balance_paise = balance_paise + p_amount_paise where account_id = v_payout_id;

  insert into public.audit_log (actor_id, action, target_id, result, detail)
  values (p_caller_id, 'request_withdrawal', v_transaction_id, 'success',
    jsonb_build_object('amount_paise', p_amount_paise, 'destination', p_destination));

  return v_transaction_id;
end;
$$;

-- ============================================================================
-- settle_withdrawal: payout -> external_settlement. Callable only by the
-- payout-provider webhook or an admin path (service_role) -- see grants.
-- There is deliberately no auth.uid() check tying this to the withdrawing
-- user, because the withdrawing user must NEVER be able to call this at
-- all; that is enforced by the EXECUTE grant, not by application logic.
-- ============================================================================
create function public.settle_withdrawal(
  p_request_id uuid,
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transaction_id uuid := gen_random_uuid();
  v_claimed_transaction_id uuid;
  v_request record;
  v_payout_id uuid;
  v_external_settlement_id uuid;
begin
  v_claimed_transaction_id := public.claim_idempotency_key(p_idempotency_key, v_transaction_id);
  if v_claimed_transaction_id <> v_transaction_id then
    return v_claimed_transaction_id;
  end if;

  perform 1 from public.withdrawal_requests where id = p_request_id for update;
  select * into v_request from public.withdrawal_requests where id = p_request_id;

  if v_request is null then
    raise exception 'withdrawal request % not found', p_request_id using errcode = 'P1004';
  end if;

  if v_request.status <> 'pending' then
    raise exception 'withdrawal request % is not pending (status: %)', p_request_id, v_request.status using errcode = 'P1003';
  end if;

  select id into v_payout_id from public.wallet_accounts where user_id = v_request.user_id and account_type = 'payout';
  select id into v_external_settlement_id from public.wallet_accounts where account_type = 'external_settlement' and user_id is null;

  perform 1 from public.wallet_accounts where id in (v_payout_id, v_external_settlement_id) order by id for update;

  insert into public.ledger_entries
    (account_id, amount_paise, entry_type, transaction_id, idempotency_key, reference_type, reference_id)
  values
    (v_payout_id, -v_request.amount_paise, 'withdrawal_settle', v_transaction_id, p_idempotency_key, 'withdrawal', p_request_id),
    (v_external_settlement_id, v_request.amount_paise, 'withdrawal_settle', v_transaction_id, p_idempotency_key, 'withdrawal', p_request_id);

  update public.account_balances set balance_paise = balance_paise - v_request.amount_paise where account_id = v_payout_id;
  update public.account_balances set balance_paise = balance_paise + v_request.amount_paise where account_id = v_external_settlement_id;

  update public.withdrawal_requests set status = 'settled' where id = p_request_id;

  insert into public.audit_log (actor_id, action, target_id, result, detail)
  values (null, 'settle_withdrawal', p_request_id, 'success', jsonb_build_object('amount_paise', v_request.amount_paise));

  return v_transaction_id;
end;
$$;

-- ============================================================================
-- fail_withdrawal: payout -> available. Same access model as settle_withdrawal.
-- ============================================================================
create function public.fail_withdrawal(
  p_request_id uuid,
  p_reason text,
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transaction_id uuid := gen_random_uuid();
  v_claimed_transaction_id uuid;
  v_request record;
  v_payout_id uuid;
  v_available_id uuid;
begin
  v_claimed_transaction_id := public.claim_idempotency_key(p_idempotency_key, v_transaction_id);
  if v_claimed_transaction_id <> v_transaction_id then
    return v_claimed_transaction_id;
  end if;

  perform 1 from public.withdrawal_requests where id = p_request_id for update;
  select * into v_request from public.withdrawal_requests where id = p_request_id;

  if v_request is null then
    raise exception 'withdrawal request % not found', p_request_id using errcode = 'P1004';
  end if;

  if v_request.status <> 'pending' then
    raise exception 'withdrawal request % is not pending (status: %)', p_request_id, v_request.status using errcode = 'P1003';
  end if;

  select id into v_payout_id from public.wallet_accounts where user_id = v_request.user_id and account_type = 'payout';
  select id into v_available_id from public.wallet_accounts where user_id = v_request.user_id and account_type = 'available';

  perform 1 from public.wallet_accounts where id in (v_payout_id, v_available_id) order by id for update;

  insert into public.ledger_entries
    (account_id, amount_paise, entry_type, transaction_id, idempotency_key, reference_type, reference_id)
  values
    (v_payout_id, -v_request.amount_paise, 'withdrawal_fail', v_transaction_id, p_idempotency_key, 'withdrawal', p_request_id),
    (v_available_id, v_request.amount_paise, 'withdrawal_fail', v_transaction_id, p_idempotency_key, 'withdrawal', p_request_id);

  update public.account_balances set balance_paise = balance_paise - v_request.amount_paise where account_id = v_payout_id;
  update public.account_balances set balance_paise = balance_paise + v_request.amount_paise where account_id = v_available_id;

  update public.withdrawal_requests set status = 'failed' where id = p_request_id;

  insert into public.audit_log (actor_id, action, target_id, result, detail)
  values (null, 'fail_withdrawal', p_request_id, 'success', jsonb_build_object('reason', p_reason));

  return v_transaction_id;
end;
$$;

-- ============================================================================
-- fund_escrow: funder available -> funder escrow.
-- ============================================================================
create function public.fund_escrow(
  p_funder_id uuid,
  p_worker_id uuid,
  p_amount_paise bigint,
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transaction_id uuid := gen_random_uuid();
  v_claimed_transaction_id uuid;
  v_funder_available_id uuid;
  v_funder_escrow_id uuid;
  v_funder_balance bigint;
begin
  if auth.uid() is distinct from p_funder_id then
    raise exception 'only the funder may fund an escrow hold' using errcode = 'P1002';
  end if;

  if p_amount_paise <= 0 then
    raise exception 'amount_paise must be positive' using errcode = 'P1005';
  end if;

  if p_funder_id = p_worker_id then
    raise exception 'cannot escrow to yourself' using errcode = 'P1005';
  end if;

  if not exists (select 1 from public.users where id = p_worker_id) then
    raise exception 'worker % does not exist', p_worker_id using errcode = 'P1004';
  end if;

  perform public.enforce_rate_limit(p_funder_id, 'fund_escrow', 30);

  v_claimed_transaction_id := public.claim_idempotency_key(p_idempotency_key, v_transaction_id);
  if v_claimed_transaction_id <> v_transaction_id then
    return v_claimed_transaction_id;
  end if;

  select id into v_funder_available_id from public.wallet_accounts where user_id = p_funder_id and account_type = 'available';
  select id into v_funder_escrow_id from public.wallet_accounts where user_id = p_funder_id and account_type = 'escrow';

  perform 1 from public.wallet_accounts where id in (v_funder_available_id, v_funder_escrow_id) order by id for update;

  select balance_paise into v_funder_balance from public.account_balances where account_id = v_funder_available_id;

  if v_funder_balance < p_amount_paise then
    raise exception 'insufficient funds' using errcode = 'P1001';
  end if;

  insert into public.escrow_holds (id, funder_id, worker_id, amount_paise, status)
  values (v_transaction_id, p_funder_id, p_worker_id, p_amount_paise, 'held');

  insert into public.ledger_entries
    (account_id, amount_paise, entry_type, transaction_id, idempotency_key, reference_type, reference_id)
  values
    (v_funder_available_id, -p_amount_paise, 'escrow_fund', v_transaction_id, p_idempotency_key, 'escrow', v_transaction_id),
    (v_funder_escrow_id, p_amount_paise, 'escrow_fund', v_transaction_id, p_idempotency_key, 'escrow', v_transaction_id);

  update public.account_balances set balance_paise = balance_paise - p_amount_paise where account_id = v_funder_available_id;
  update public.account_balances set balance_paise = balance_paise + p_amount_paise where account_id = v_funder_escrow_id;

  insert into public.audit_log (actor_id, action, target_id, result, detail)
  values (p_funder_id, 'fund_escrow', v_transaction_id, 'success',
    jsonb_build_object('amount_paise', p_amount_paise, 'worker_id', p_worker_id));

  return v_transaction_id;
end;
$$;

-- ============================================================================
-- release_escrow: funder escrow -> worker available (70%) + platform_fee
-- (30%). Only the funder may call this -- checked against the hold's own
-- funder_id, not a value the caller can supply.
-- ============================================================================
create function public.release_escrow(
  p_caller_id uuid,
  p_hold_id uuid,
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transaction_id uuid := gen_random_uuid();
  v_claimed_transaction_id uuid;
  v_hold record;
  v_funder_escrow_id uuid;
  v_worker_available_id uuid;
  v_platform_fee_id uuid;
  v_fee_amount bigint;
  v_worker_amount bigint;
begin
  select * into v_hold from public.escrow_holds where id = p_hold_id;

  if v_hold is null then
    raise exception 'escrow hold % not found', p_hold_id using errcode = 'P1004';
  end if;

  if auth.uid() is distinct from v_hold.funder_id then
    raise exception 'only the funder may release this escrow hold' using errcode = 'P1002';
  end if;

  v_claimed_transaction_id := public.claim_idempotency_key(p_idempotency_key, v_transaction_id);
  if v_claimed_transaction_id <> v_transaction_id then
    return v_claimed_transaction_id;
  end if;

  select id into v_funder_escrow_id from public.wallet_accounts where user_id = v_hold.funder_id and account_type = 'escrow';
  select id into v_worker_available_id from public.wallet_accounts where user_id = v_hold.worker_id and account_type = 'available';
  select id into v_platform_fee_id from public.wallet_accounts where account_type = 'platform_fee' and user_id is null;

  perform 1 from public.escrow_holds where id = p_hold_id for update;
  perform 1 from public.wallet_accounts
    where id in (v_funder_escrow_id, v_worker_available_id, v_platform_fee_id)
    order by id
    for update;

  -- Re-read the hold now that we hold its lock, in case a concurrent call
  -- already released or refunded it while we were waiting.
  select * into v_hold from public.escrow_holds where id = p_hold_id;

  if v_hold.status <> 'held' then
    raise exception 'escrow hold % is not held (status: %)', p_hold_id, v_hold.status using errcode = 'P1003';
  end if;

  v_fee_amount := (v_hold.amount_paise * 30) / 100;
  v_worker_amount := v_hold.amount_paise - v_fee_amount;

  insert into public.ledger_entries
    (account_id, amount_paise, entry_type, transaction_id, idempotency_key, reference_type, reference_id)
  values
    (v_funder_escrow_id, -v_hold.amount_paise, 'escrow_release', v_transaction_id, p_idempotency_key, 'escrow', p_hold_id),
    (v_worker_available_id, v_worker_amount, 'escrow_release', v_transaction_id, p_idempotency_key, 'escrow', p_hold_id),
    (v_platform_fee_id, v_fee_amount, 'escrow_release', v_transaction_id, p_idempotency_key, 'escrow', p_hold_id);

  update public.account_balances set balance_paise = balance_paise - v_hold.amount_paise where account_id = v_funder_escrow_id;
  update public.account_balances set balance_paise = balance_paise + v_worker_amount where account_id = v_worker_available_id;
  update public.account_balances set balance_paise = balance_paise + v_fee_amount where account_id = v_platform_fee_id;

  update public.escrow_holds set status = 'released' where id = p_hold_id;

  insert into public.audit_log (actor_id, action, target_id, result, detail)
  values (p_caller_id, 'release_escrow', p_hold_id, 'success',
    jsonb_build_object('worker_amount', v_worker_amount, 'fee_amount', v_fee_amount));

  return v_transaction_id;
end;
$$;

-- ============================================================================
-- refund_escrow: funder escrow -> funder available, in full, no fee.
-- ============================================================================
create function public.refund_escrow(
  p_caller_id uuid,
  p_hold_id uuid,
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transaction_id uuid := gen_random_uuid();
  v_claimed_transaction_id uuid;
  v_hold record;
  v_funder_escrow_id uuid;
  v_funder_available_id uuid;
begin
  select * into v_hold from public.escrow_holds where id = p_hold_id;

  if v_hold is null then
    raise exception 'escrow hold % not found', p_hold_id using errcode = 'P1004';
  end if;

  if auth.uid() is distinct from v_hold.funder_id then
    raise exception 'only the funder may refund this escrow hold' using errcode = 'P1002';
  end if;

  v_claimed_transaction_id := public.claim_idempotency_key(p_idempotency_key, v_transaction_id);
  if v_claimed_transaction_id <> v_transaction_id then
    return v_claimed_transaction_id;
  end if;

  select id into v_funder_escrow_id from public.wallet_accounts where user_id = v_hold.funder_id and account_type = 'escrow';
  select id into v_funder_available_id from public.wallet_accounts where user_id = v_hold.funder_id and account_type = 'available';

  perform 1 from public.escrow_holds where id = p_hold_id for update;
  perform 1 from public.wallet_accounts where id in (v_funder_escrow_id, v_funder_available_id) order by id for update;

  select * into v_hold from public.escrow_holds where id = p_hold_id;

  if v_hold.status <> 'held' then
    raise exception 'escrow hold % is not held (status: %)', p_hold_id, v_hold.status using errcode = 'P1003';
  end if;

  insert into public.ledger_entries
    (account_id, amount_paise, entry_type, transaction_id, idempotency_key, reference_type, reference_id)
  values
    (v_funder_escrow_id, -v_hold.amount_paise, 'escrow_refund', v_transaction_id, p_idempotency_key, 'escrow', p_hold_id),
    (v_funder_available_id, v_hold.amount_paise, 'escrow_refund', v_transaction_id, p_idempotency_key, 'escrow', p_hold_id);

  update public.account_balances set balance_paise = balance_paise - v_hold.amount_paise where account_id = v_funder_escrow_id;
  update public.account_balances set balance_paise = balance_paise + v_hold.amount_paise where account_id = v_funder_available_id;

  update public.escrow_holds set status = 'refunded' where id = p_hold_id;

  insert into public.audit_log (actor_id, action, target_id, result, detail)
  values (p_caller_id, 'refund_escrow', p_hold_id, 'success', jsonb_build_object('amount_paise', v_hold.amount_paise));

  return v_transaction_id;
end;
$$;

-- ============================================================================
-- Grants: PUBLIC gets EXECUTE on a new function by default in Postgres, so
-- every function above starts by having it explicitly revoked, and then
-- re-granted only to the one role that should legitimately call it.
-- ============================================================================
revoke execute on function public.enforce_rate_limit(uuid, text, int) from public;
revoke execute on function public.claim_idempotency_key(text, uuid) from public;

revoke execute on function public.credit_deposit(uuid, bigint, text, text) from public;
grant execute on function public.credit_deposit(uuid, bigint, text, text) to service_role;

revoke execute on function public.send_support(uuid, uuid, bigint, text) from public;
grant execute on function public.send_support(uuid, uuid, bigint, text) to authenticated;

revoke execute on function public.request_withdrawal(uuid, bigint, text, text) from public;
grant execute on function public.request_withdrawal(uuid, bigint, text, text) to authenticated;

revoke execute on function public.settle_withdrawal(uuid, text) from public;
grant execute on function public.settle_withdrawal(uuid, text) to service_role;

revoke execute on function public.fail_withdrawal(uuid, text, text) from public;
grant execute on function public.fail_withdrawal(uuid, text, text) to service_role;

revoke execute on function public.fund_escrow(uuid, uuid, bigint, text) from public;
grant execute on function public.fund_escrow(uuid, uuid, bigint, text) to authenticated;

revoke execute on function public.release_escrow(uuid, uuid, text) from public;
grant execute on function public.release_escrow(uuid, uuid, text) to authenticated;

revoke execute on function public.refund_escrow(uuid, uuid, text) from public;
grant execute on function public.refund_escrow(uuid, uuid, text) to authenticated;
