-- Claude Enhancer: reliable Pro subscriptions (source of truth for free/pro)
-- Run once in Supabase SQL Editor

create table if not exists public.pro_subscriptions (
  email text primary key,
  email_hash text not null,
  plan text not null default 'pro' check (plan in ('free', 'pro')),
  cycle text not null check (cycle in ('monthly', 'yearly', 'lifetime')),
  amount numeric,
  currency text,
  gst numeric,
  expires_at timestamptz,
  provider text,
  payment_id text,
  license_key text,
  status text not null default 'active' check (status in ('active', 'expired', 'revoked')),
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists pro_subscriptions_email_hash_idx on public.pro_subscriptions (email_hash);
create index if not exists pro_subscriptions_status_expires_idx on public.pro_subscriptions (status, expires_at);

alter table public.pro_subscriptions enable row level security;

-- Service role bypasses RLS; no public policies (extension talks via Vercel API only)

comment on table public.pro_subscriptions is 'Paid Pro seats keyed by billing email. Null expires_at = lifetime.';
