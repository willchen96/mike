-- Add OpenRouter API key column to user_profiles
-- Run this migration in your Supabase SQL Editor

alter table public.user_profiles
  add column if not exists openrouter_api_key text;
