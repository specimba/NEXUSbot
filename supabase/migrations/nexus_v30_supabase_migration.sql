-- ============================================================================
-- NEXUS-OS v30.0 (Deployment v6) — Idempotent Supabase SQL Schema Migration
-- Engineered for kick.com/specimba (Baş Mimar: Canberk Karaerkek)
-- Project: https://vwottesqbdgcsmvvvzok.supabase.co
-- ============================================================================

-- 1. Permanent Knowledge & Lore Vault (Confirmed Project Schema)
create table if not exists public.nexus_knowledge (
    id bigserial primary key,
    topic text not null,
    category text default 'general',
    keywords text default '',
    summary text not null,
    source text default 'seed',
    updated_at timestamptz default now()
);

-- 2. Cross-Session Viewer Dossiers Table
create table if not exists public.nexus_dossiers (
    handle text primary key,
    display_name text default '',
    role text not null default 'İzleyici',
    total_interactions integer default 1,
    last_prompt text default '',
    last_reply text default '',
    banned_topics text[] default '{}',
    updated_at timestamptz default now()
);

-- 3. Stream Interaction Events Log (+ v30 RSI `judged` column)
create table if not exists public.nexus_stream_events (
    id bigserial primary key,
    sender text not null,
    intent text not null default 'FAST_BANTER',
    prompt text not null,
    reply text not null,
    model_label text default '',
    latency_ms integer default 0,
    judged boolean default false,
    created_at timestamptz default now()
);

alter table public.nexus_stream_events
    add column if not exists judged boolean default false;

-- 4. Pillar 2A: Non-Negotiable RSI Kill-Switch & Harness Version Config (`public.rsi_config`)
create table if not exists public.rsi_config (
    id integer primary key default 1,
    enabled boolean not null default true,
    current_harness_version text not null default 'v30.0',
    updated_by text default 'specimba',
    updated_at timestamptz default now(),
    constraint rsi_config_singleton check (id = 1)
);

insert into public.rsi_config (id, enabled, current_harness_version, updated_by)
values (1, true, 'v30.0', 'specimba')
on conflict (id) do nothing;

-- 5. Pillar 2B: Cross-Family Judge Evaluations Table (`public.nexus_rsi_evaluations`)
create table if not exists public.nexus_rsi_evaluations (
    id bigserial primary key,
    sender text not null,
    intent text not null,
    prompt text not null,
    reply text not null,
    generator_model text not null,
    judge_model text not null,
    score integer not null check (score >= 1 and score <= 10),
    failure_category text not null default 'PERFECT',
    critique text default '',
    proposed_rule text default '',
    created_at timestamptz default now()
);

create index if not exists idx_nexus_rsi_eval_cat_score
    on public.nexus_rsi_evaluations (failure_category, score, created_at desc);

-- 6. Pillar 2C: Evidence-Gated Active Persona Rules (`public.nexus_persona_rules`)
create table if not exists public.nexus_persona_rules (
    id bigserial primary key,
    rule_text text not null,
    failure_category text not null,
    falsifiable_condition text default '',
    evidence_refs text[] default '{}',
    proposed_by_judge text default '',
    active boolean not null default true,
    created_at timestamptz default now()
);

create index if not exists idx_nexus_persona_rules_active
    on public.nexus_persona_rules (active, created_at desc);

-- 7. Pillar 3: Server-Side Grok Imagine 2.0 Viewer Credits Ledger (`public.viewer_credits`)
create table if not exists public.viewer_credits (
    handle text primary key,
    balance_usd numeric(10, 2) not null default 5.00,
    total_granted_usd numeric(10, 2) not null default 5.00,
    spent_usd numeric(10, 2) not null default 0.00,
    images_generated integer not null default 0,
    referral_claimed boolean not null default false,
    last_image_prompt text default '',
    last_image_url text default '',
    updated_at timestamptz default now()
);

-- Enable Row Level Security (Service Role key inside nexus-cortex bypasses RLS safely)
alter table public.nexus_knowledge enable row level security;
alter table public.nexus_dossiers enable row level security;
alter table public.nexus_stream_events enable row level security;
alter table public.rsi_config enable row level security;
alter table public.nexus_rsi_evaluations enable row level security;
alter table public.nexus_persona_rules enable row level security;
alter table public.viewer_credits enable row level security;

do $$
begin
    if not exists (
        select 1 from pg_policies where tablename = 'nexus_knowledge' and policyname = 'Allow anon read nexus_knowledge'
    ) then
        create policy "Allow anon read nexus_knowledge" on public.nexus_knowledge for select using (true);
    end if;
end $$;