-- 117: Shop colour theme (decided Oct 6, 2026)
--
-- Owners and Admins (edit_settings) choose the app's colour theme in Settings → Appearance:
-- one of the ready-made palettes, or a custom colour. Stored as {"preset":"teal"} or
-- {"preset":"custom","accent":"#0E9F7E"}. Everyone sees the shop's theme.

alter table public.shop_settings
  add column theme jsonb not null default '{"preset":"teal"}'::jsonb;

alter table public.shop_settings
  add constraint shop_settings_theme check (
    jsonb_typeof(theme) = 'object'
    and theme ? 'preset'
    and (theme->>'preset') ~ '^[a-z]{1,20}$'
    and (theme->>'preset' <> 'custom' or coalesce(theme->>'accent', '') ~ '^#[0-9A-Fa-f]{6}$')
  );
