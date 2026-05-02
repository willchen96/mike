alter table public.user_profiles
  add column if not exists openai_api_key text;
