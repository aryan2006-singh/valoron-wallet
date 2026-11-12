-- ============================================================================
-- Backend hardening pass. Fixes, in order of severity:
--
-- 1. Deposit intents could be credited more than once. credit_deposit was
--    idempotent on the provider's payment_id only, and nothing checked the
--    intent's status, so the same intent paid with N different payment_ids
--    (e.g. calling /api/dev/simulate-provider N times) credited the user N
--    times. credit_deposit now takes the intent id, locks the intent row,
--    requires it to be 'pending', and marks it 'completed' in the SAME
--    transaction as the ledger write (previously a separate, non-atomic
--    UPDATE from the route handler).
--
-- 2. Idempotency keys were one global namespace shared by every user and
--    every operation. If user B reused a key user A had already used, B's
--    request silently returned A's transaction id and did nothing, while the
--    API reported success. Keys are now scoped per (operation, user), and
--    each key remembers a fingerprint of the request it was first used for:
--    replaying a key with DIFFERENT parameters (e.g. a different amount) is
--    rejected with P1007 instead of quietly returning the old result.
--
-- 3. enforce_rate_limit was check-then-insert with no lock, so a burst of
--    parallel requests could all read the same count and all pass. It now
--    takes a per-(user, action) transaction-scoped advisory lock first.
--    Idempotent replays are also no longer counted against the limit (the
--    key is claimed before the limit is checked).
--
-- 4. Smaller things: deposit intents are now rate limited; escrow
--    release/refund audit rows record auth.uid() rather than the
--    caller-supplied p_caller_id; payout-failure reasons are length-capped;
--    and a service-role-only check_ledger_integrity() reconciliation
--    function is added.
--
-- Function signatures used by the API routes are unchanged except
-- credit_deposit, which only the payment webhook calls.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Scoped, fingerprinted idempotency keys
-- ---------------------------------------------------------------------------
alter table public.idempotency_keys drop constraint idempotency_keys_pkey;
alter table public.idempotency_keys
  add column scope text not null default 'legacy',
  add column request_fingerprint text;
alter table public.idempotency_keys alter column scope drop default;
alter table public.idempotency_keys add primary key (scope, key);

drop function public.claim_idempotency_key(text, uuid);

-- Returns p_transaction_id if this call claimed the key (the caller should go
-- ahead and perform the operation), or the transaction id that the key was
-- originally claimed for (the caller should return that and do nothing).
-- Raises P1007 if the key was first used for a different request.
create function public.claim_idempotency_key(
  p_scope text,
  p_key text,
  p_transaction_id uuid,
  p_fingerprint text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing record;
begin
  insert into public.idempotency_keys (scope, key, transaction_id, request_fingerprint)
  values (p_scope, p_key, p_transaction_id, p_fingerprint)
  on conflict (scope, key) do nothing;

  if found then
    return p_transaction_id;
  end if;

  select transaction_id, request_fingerprint into v_existing
  from public.idempotency_keys
  where scope = p_scope and key = p_key;

  if v_existing.request_fingerprint is distinct from p_fingerprint then
    raise exception 'idempotency key reused with different request parameters'
      using errcode = 'P1007';
  end if;

  return v_existing.transaction_id;
end;
$$;

revoke execute on function public.claim_idempotency_key(text, text, uuid, text) from public;

-- ---------------------------------------------------------------------------
-- Race-free rate limiter
-- ---------------------------------------------------------------------------
create or replace function public.enforce_rate_limit(p_user_id uuid, p_action text, p_max_per_hour int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  -- Serialize concurrent callers for the same (user, action) so the count
  -- below can't be read by two transactions at once. Released at commit.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_action, 0));

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

-- ---------------------------------------------------------------------------
-- Deposit intents: record which provider payment completed them
-- ---------------------------------------------------------------------------
alter table public.payment_intents
  add column provider_payment_id text unique,
  add column completed_at timestamptz;

create or replace function public.create_deposit_intent(p_amount_paise bigint)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_intent_id uuid;
begin
  if auth.uid() is null then
    raise exception 'must be authenticated to create a deposit intent' using errcode = 'P1002';
  end if;

  if p_amount_paise <= 0 then
    raise exception 'amount_paise must be positive' using errcode = 'P1005';
  end if;

  perform public.enforce_rate_limit(auth.uid(), 'create_deposit_intent', 30);

  insert into public.payment_intents (user_id, amount_paise, status)
  values (auth.uid(), p_amount_paise, 'pending')
  returning id into v_intent_id;

  return v_intent_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- credit_deposit: now keyed on the intent, credited at most once per intent
-- ---------------------------------------------------------------------------
drop function public.credit_deposit(uuid, bigint, text, text);

create function public.credit_deposit(
  p_intent_id uuid,
  p_provider_payment_id text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transaction_id uuid := gen_random_uuid();
  v_claimed_transaction_id uuid;
  v_intent record;
  v_genesis_account_id uuid;
  v_user_available_id uuid;
begin
  -- Lock the intent first: every webhook delivery for this intent queues
  -- here, so the status check below can't be raced.
  select * into v_intent from public.payment_intents where id = p_intent_id for update;

  if v_intent is null then
    raise exception 'payment intent % not found', p_intent_id using errcode = 'P1004';
  end if;

  -- Same payment_id redelivered (provider retry): return the original result.
  -- Same payment_id claimed for a DIFFERENT intent: P1007.
  v_claimed_transaction_id := public.claim_idempotency_key(
    'credit_deposit', p_provider_payment_id, v_transaction_id, p_intent_id::text);
  if v_claimed_transaction_id <> v_transaction_id then
    return v_claimed_transaction_id;
  end if;

  -- A new payment_id for an intent that is already paid: never credit twice.
  if v_intent.status <> 'pending' then
    raise exception 'payment intent % is already %', p_intent_id, v_intent.status using errcode = 'P1003';
  end if;

  select id into v_genesis_account_id
  from public.wallet_accounts
  where account_type = 'platform_genesis' and user_id is null;

  select id into v_user_available_id
  from public.wallet_accounts
  where user_id = v_intent.user_id and account_type = 'available';

  if v_user_available_id is null then
    raise exception 'no available account for user %', v_intent.user_id using errcode = 'P1004';
  end if;

  perform 1 from public.wallet_accounts
    where id in (v_genesis_account_id, v_user_available_id)
    order by id
    for update;

  insert into public.ledger_entries
    (account_id, amount_paise, entry_type, transaction_id, idempotency_key, reference_type, reference_id)
  values
    (v_genesis_account_id, -v_intent.amount_paise, 'deposit', v_transaction_id, p_provider_payment_id, 'deposit', p_intent_id),
    (v_user_available_id, v_intent.amount_paise, 'deposit', v_transaction_id, p_provider_payment_id, 'deposit', p_intent_id);

  update public.account_balances set balance_paise = balance_paise - v_intent.amount_paise where account_id = v_genesis_account_id;
  update public.account_balances set balance_paise = balance_paise + v_intent.amount_paise where account_id = v_user_available_id;

  update public.payment_intents
  set status = 'completed', provider_payment_id = p_provider_payment_id, completed_at = now()
  where id = p_intent_id;

  insert into public.audit_log (actor_id, action, target_id, result, detail)
  values (v_intent.user_id, 'credit_deposit', p_intent_id, 'success',
    jsonb_build_object('amount_paise', v_intent.amount_paise, 'provider_payment_id', p_provider_payment_id,
                       'transaction_id', v_transaction_id));

  return v_transaction_id;
end;
$$;

revoke execute on function public.credit_deposit(uuid, text) from public;
grant execute on function public.credit_deposit(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- send_support
-- ---------------------------------------------------------------------------
create or replace function public.send_support(
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

  v_claimed_transaction_id := public.claim_idempotency_key(
    'send_support:' || p_sender_id, p_idempotency_key, v_transaction_id,
    p_recipient_id || ':' || p_amount_paise);
  if v_claimed_transaction_id <> v_transaction_id then
    return v_claimed_transaction_id;
  end if;

  perform public.enforce_rate_limit(p_sender_id, 'send_support', 60);

  select id into v_sender_available_id from public.wallet_accounts where user_id = p_sender_id and account_type = 'available';
  select id into v_recipient_available_id from public.wallet_accounts where user_id = p_recipient_id and account_type = 'available';
  select id into v_platform_fee_id from public.wallet_accounts where account_type = 'platform_fee' and user_id is null;

  if v_recipient_available_id is null then
    raise exception 'recipient % does not exist', p_recipient_id using errcode = 'P1004';
  end if;

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

  -- Only write non-zero legs: for a 1-3 paise send the fee rounds down to 0,
  -- and ledger_entries rejects zero-amount rows.
  insert into public.ledger_entries
    (account_id, amount_paise, entry_type, transaction_id, idempotency_key, reference_type, reference_id)
  select * from (values
    (v_sender_available_id, -p_amount_paise, 'support_send', v_transaction_id, p_idempotency_key, 'support', v_transaction_id),
    (v_recipient_available_id, v_recipient_amount, 'support_receive', v_transaction_id, p_idempotency_key, 'support', v_transaction_id),
    (v_platform_fee_id, v_fee_amount, 'support_fee', v_transaction_id, p_idempotency_key, 'support', v_transaction_id)
  ) as legs(account_id, amount_paise, entry_type, transaction_id, idempotency_key, reference_type, reference_id)
  where legs.amount_paise <> 0;

  update public.account_balances set balance_paise = balance_paise - p_amount_paise where account_id = v_sender_available_id;
  update public.account_balances set balance_paise = balance_paise + v_recipient_amount where account_id = v_recipient_available_id;
  update public.account_balances set balance_paise = balance_paise + v_fee_amount where account_id = v_platform_fee_id;

  insert into public.audit_log (actor_id, action, target_id, result, detail)
  values (p_sender_id, 'send_support', p_recipient_id, 'success',
    jsonb_build_object('amount_paise', p_amount_paise, 'fee_amount', v_fee_amount, 'recipient_amount', v_recipient_amount));

  return v_transaction_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- request_withdrawal
-- ---------------------------------------------------------------------------
create or replace function public.request_withdrawal(
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

  v_claimed_transaction_id := public.claim_idempotency_key(
    'request_withdrawal:' || p_caller_id, p_idempotency_key, v_transaction_id,
    p_amount_paise || ':' || p_destination);
  if v_claimed_transaction_id <> v_transaction_id then
    return v_claimed_transaction_id;
  end if;

  perform public.enforce_rate_limit(p_caller_id, 'request_withdrawal', 10);

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

-- ---------------------------------------------------------------------------
-- settle_withdrawal / fail_withdrawal (service_role only, via payout webhook)
-- ---------------------------------------------------------------------------
create or replace function public.settle_withdrawal(
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
  select * into v_request from public.withdrawal_requests where id = p_request_id for update;

  if v_request is null then
    raise exception 'withdrawal request % not found', p_request_id using errcode = 'P1004';
  end if;

  v_claimed_transaction_id := public.claim_idempotency_key(
    'settle_withdrawal', p_idempotency_key, v_transaction_id, p_request_id::text);
  if v_claimed_transaction_id <> v_transaction_id then
    return v_claimed_transaction_id;
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

create or replace function public.fail_withdrawal(
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
  select * into v_request from public.withdrawal_requests where id = p_request_id for update;

  if v_request is null then
    raise exception 'withdrawal request % not found', p_request_id using errcode = 'P1004';
  end if;

  v_claimed_transaction_id := public.claim_idempotency_key(
    'fail_withdrawal', p_idempotency_key, v_transaction_id, p_request_id::text);
  if v_claimed_transaction_id <> v_transaction_id then
    return v_claimed_transaction_id;
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
  values (null, 'fail_withdrawal', p_request_id, 'success', jsonb_build_object('reason', left(p_reason, 500)));

  return v_transaction_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- fund_escrow
-- ---------------------------------------------------------------------------
create or replace function public.fund_escrow(
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

  v_claimed_transaction_id := public.claim_idempotency_key(
    'fund_escrow:' || p_funder_id, p_idempotency_key, v_transaction_id,
    p_worker_id || ':' || p_amount_paise);
  if v_claimed_transaction_id <> v_transaction_id then
    return v_claimed_transaction_id;
  end if;

  perform public.enforce_rate_limit(p_funder_id, 'fund_escrow', 30);

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

-- ---------------------------------------------------------------------------
-- release_escrow / refund_escrow
-- ---------------------------------------------------------------------------
create or replace function public.release_escrow(
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

  v_claimed_transaction_id := public.claim_idempotency_key(
    'escrow_settle:' || auth.uid(), p_idempotency_key, v_transaction_id, 'release:' || p_hold_id);
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

  select * into v_hold from public.escrow_holds where id = p_hold_id;

  if v_hold.status <> 'held' then
    raise exception 'escrow hold % is not held (status: %)', p_hold_id, v_hold.status using errcode = 'P1003';
  end if;

  v_fee_amount := (v_hold.amount_paise * 30) / 100;
  v_worker_amount := v_hold.amount_paise - v_fee_amount;

  insert into public.ledger_entries
    (account_id, amount_paise, entry_type, transaction_id, idempotency_key, reference_type, reference_id)
  select * from (values
    (v_funder_escrow_id, -v_hold.amount_paise, 'escrow_release', v_transaction_id, p_idempotency_key, 'escrow', p_hold_id),
    (v_worker_available_id, v_worker_amount, 'escrow_release', v_transaction_id, p_idempotency_key, 'escrow', p_hold_id),
    (v_platform_fee_id, v_fee_amount, 'escrow_release', v_transaction_id, p_idempotency_key, 'escrow', p_hold_id)
  ) as legs(account_id, amount_paise, entry_type, transaction_id, idempotency_key, reference_type, reference_id)
  where legs.amount_paise <> 0;

  update public.account_balances set balance_paise = balance_paise - v_hold.amount_paise where account_id = v_funder_escrow_id;
  update public.account_balances set balance_paise = balance_paise + v_worker_amount where account_id = v_worker_available_id;
  update public.account_balances set balance_paise = balance_paise + v_fee_amount where account_id = v_platform_fee_id;

  update public.escrow_holds set status = 'released' where id = p_hold_id;

  insert into public.audit_log (actor_id, action, target_id, result, detail)
  values (auth.uid(), 'release_escrow', p_hold_id, 'success',
    jsonb_build_object('worker_amount', v_worker_amount, 'fee_amount', v_fee_amount));

  return v_transaction_id;
end;
$$;

create or replace function public.refund_escrow(
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

  v_claimed_transaction_id := public.claim_idempotency_key(
    'escrow_settle:' || auth.uid(), p_idempotency_key, v_transaction_id, 'refund:' || p_hold_id);
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
  values (auth.uid(), 'refund_escrow', p_hold_id, 'success', jsonb_build_object('amount_paise', v_hold.amount_paise));

  return v_transaction_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reconciliation: every account's cached balance must equal the sum of its
-- ledger entries, and the whole ledger must sum to zero. Returns one row per
-- discrepancy (no rows = healthy). service_role only.
-- ---------------------------------------------------------------------------
create function public.check_ledger_integrity()
returns table (problem text, account_id uuid, cached_balance_paise bigint, ledger_sum_paise bigint)
language sql
security definer
set search_path = public
stable
as $$
  select 'balance_mismatch', ab.account_id, ab.balance_paise, coalesce(sum(le.amount_paise), 0)::bigint
  from public.account_balances ab
  left join public.ledger_entries le on le.account_id = ab.account_id
  group by ab.account_id, ab.balance_paise
  having ab.balance_paise <> coalesce(sum(le.amount_paise), 0)
  union all
  select 'ledger_not_zero_sum', null::uuid, null::bigint, sum(amount_paise)::bigint
  from public.ledger_entries
  having coalesce(sum(amount_paise), 0) <> 0;
$$;

revoke execute on function public.check_ledger_integrity() from public;
grant execute on function public.check_ledger_integrity() to service_role;
