-- 151b (review 39): the shop's default parts markup is cost information. Only logins that see costs read it, through
-- shop_markup() (151). Run AFTER the 151 app is live: the 150c app reads shop_settings with select *, which a column
-- grant would refuse.
do $do$
declare v_cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into v_cols
    from information_schema.columns where table_schema = 'public' and table_name = 'shop_settings' and column_name <> 'default_markup_pct';
  execute 'revoke select on public.shop_settings from authenticated, anon';
  execute format('grant select (%s) on public.shop_settings to authenticated', v_cols);
end $do$;
