-- Creates a pending payment intent for the CALLING user (auth.uid()), never
-- for a user_id supplied by the client. Credits nothing -- this only ever
-- creates a row that the (simulated) provider will later reference by id
-- in a signed webhook.
create function public.create_deposit_intent(p_amount_paise bigint)
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

  insert into public.payment_intents (user_id, amount_paise, status)
  values (auth.uid(), p_amount_paise, 'pending')
  returning id into v_intent_id;

  return v_intent_id;
end;
$$;

revoke execute on function public.create_deposit_intent(bigint) from public;
grant execute on function public.create_deposit_intent(bigint) to authenticated;
