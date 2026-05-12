alter table public.user_profiles
  add column if not exists tabular_max_pages integer not null default 250
  check (tabular_max_pages >= 10 and tabular_max_pages <= 2000);
