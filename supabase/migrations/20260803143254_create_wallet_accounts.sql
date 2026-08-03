create type account_type as enum (
  'available',
  'escrow',
  'payout',
  'platform_fee',
  'platform_genesis',
  'external_settlement'
);
create table public.wallet_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete cascade,
  account_type account_type not null,
  created_at timestamptz not null default now()
);
create unique index wallet_accounts_user_type_unique
  on public.wallet_accounts (user_id, account_type)
  where user_id is not null;

create unique index wallet_accounts_platform_type_unique
  on public.wallet_accounts (account_type)
  where user_id is null;

create table public.account_balances (
  account_id uuid primary key references public.wallet_accounts(id) on delete cascade,
  balance_paise bigint not null default 0
);
create function public.enforce_non_negative_balance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account_type public.account_type;
begin
  select wa.account_type into v_account_type
  from public.wallet_accounts wa
  where wa.id = new.account_id;

  if v_account_type <> 'platform_genesis' and new.balance_paise < 0 then
    raise exception 'balance cannot go negative for account %', new.account_id
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger enforce_non_negative_balance_trigger
    before update on public.account_balances
    for each row execute function public.enforce_non_negative_balance();
 
create function public.provision_user_accounts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_available_id uuid;
  v_escrow_id uuid;
  v_payout_id uuid;
begin
  insert into public.wallet_accounts (user_id, account_type)
  values (new.id, 'available') returning id into v_available_id;
  insert into public.account_balances (account_id, balance_paise) values (v_available_id, 0);

  insert into public.wallet_accounts (user_id, account_type)
  values (new.id, 'escrow') returning id into v_escrow_id;
  insert into public.account_balances (account_id, balance_paise) values (v_escrow_id, 0);

  insert into public.wallet_accounts (user_id, account_type)
  values (new.id, 'payout') returning id into v_payout_id;
  insert into public.account_balances (account_id, balance_paise) values (v_payout_id, 0);

  return new;
end;
$$;
create trigger on_user_created_provision_accounts
  after insert on public.users
  for each row execute function public.provision_user_accounts();

insert into public.wallet_accounts (user_id, account_type) values
  (null, 'platform_fee'),
  (null, 'platform_genesis'),
  (null, 'external_settlement');

insert into public.account_balances (account_id, balance_paise)
select id, 0 from public.wallet_accounts where user_id is null;