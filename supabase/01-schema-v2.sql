-- Milena English Space v2 — schema compatible with the Kristina site architecture.
-- Run this file first in the SAME Supabase project that currently contains public.progress.
-- It creates new tables without deleting or changing the legacy progress table.

create extension if not exists pgcrypto;

create or replace function public.set_progress_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.homework_progress (
  id uuid primary key default gen_random_uuid(),
  student_id text not null,
  student_name text not null default '',
  lesson_id text not null,
  lesson_title text not null default '',
  status text not null default 'checked' check (status in ('checked', 'submitted')),
  answers jsonb not null default '{}'::jsonb check (jsonb_typeof(answers) = 'object'),
  score_correct integer,
  score_total integer,
  score_percent integer,
  checked_at timestamptz,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (student_id, lesson_id),
  check (score_correct is null or score_correct >= 0),
  check (score_total is null or score_total >= 0),
  check (score_correct is null or score_total is null or score_correct <= score_total),
  check (score_percent is null or score_percent between 0 and 100)
);

create table if not exists public.vocabulary_progress (
  id uuid primary key default gen_random_uuid(),
  student_id text not null,
  word_key text not null,
  word_id text not null default '',
  en text not null default '',
  ru text not null default '',
  source_topic_id text,
  status text not null check (status in ('known', 'difficult')),
  learned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (student_id, word_key)
);

create table if not exists public.vocabulary_topic_progress (
  id uuid primary key default gen_random_uuid(),
  student_id text not null,
  topic_id text not null,
  tests jsonb not null default '[]'::jsonb check (jsonb_typeof(tests) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (student_id, topic_id)
);

create table if not exists public.grammar_progress (
  id uuid primary key default gen_random_uuid(),
  student_id text not null,
  topic_id text not null,
  passed boolean not null default false,
  attempts integer not null default 0 check (attempts >= 0),
  best_score integer not null default 0 check (best_score between 0 and 100),
  passed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (student_id, topic_id)
);

create table if not exists public.telegram_recipients (
  id uuid primary key default gen_random_uuid(),
  student_id text not null unique,
  chat_id bigint not null unique,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.material_publications (
  id uuid primary key default gen_random_uuid(),
  student_id text not null,
  material_type text not null,
  material_id text not null,
  notification_version integer not null default 1 check (notification_version > 0),
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  payload jsonb not null default '{}'::jsonb,
  telegram_message_id bigint,
  error_message text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (student_id, material_type, material_id, notification_version)
);

create index if not exists homework_progress_student_idx on public.homework_progress (student_id, lesson_id);
create index if not exists vocabulary_progress_student_idx on public.vocabulary_progress (student_id, source_topic_id);
create index if not exists grammar_progress_student_idx on public.grammar_progress (student_id, topic_id);
create index if not exists material_publications_student_idx on public.material_publications (student_id, created_at desc);

do $$
declare table_name text;
begin
  foreach table_name in array array['homework_progress','vocabulary_progress','vocabulary_topic_progress','grammar_progress','telegram_recipients','material_publications']
  loop
    execute format('drop trigger if exists %I_set_updated_at on public.%I', table_name, table_name);
    execute format('create trigger %I_set_updated_at before update on public.%I for each row execute function public.set_progress_updated_at()', table_name, table_name);
  end loop;
end;
$$;

alter table public.homework_progress enable row level security;
alter table public.vocabulary_progress enable row level security;
alter table public.vocabulary_topic_progress enable row level security;
alter table public.grammar_progress enable row level security;
alter table public.telegram_recipients enable row level security;
alter table public.material_publications enable row level security;

revoke all on public.homework_progress, public.vocabulary_progress, public.vocabulary_topic_progress, public.grammar_progress from anon, authenticated;
grant select, insert, update, delete on public.homework_progress, public.vocabulary_progress, public.vocabulary_topic_progress, public.grammar_progress to anon;

-- This site has no login. The public anon key may work only with Milena's rows.
drop policy if exists milena_homework_select on public.homework_progress;
drop policy if exists milena_homework_insert on public.homework_progress;
drop policy if exists milena_homework_update on public.homework_progress;
drop policy if exists milena_homework_delete on public.homework_progress;
create policy milena_homework_select on public.homework_progress for select to anon using (student_id = 'milena');
create policy milena_homework_insert on public.homework_progress for insert to anon with check (student_id = 'milena');
create policy milena_homework_update on public.homework_progress for update to anon using (student_id = 'milena') with check (student_id = 'milena');
create policy milena_homework_delete on public.homework_progress for delete to anon using (student_id = 'milena');

drop policy if exists milena_vocabulary_select on public.vocabulary_progress;
drop policy if exists milena_vocabulary_insert on public.vocabulary_progress;
drop policy if exists milena_vocabulary_update on public.vocabulary_progress;
drop policy if exists milena_vocabulary_delete on public.vocabulary_progress;
create policy milena_vocabulary_select on public.vocabulary_progress for select to anon using (student_id = 'milena');
create policy milena_vocabulary_insert on public.vocabulary_progress for insert to anon with check (student_id = 'milena');
create policy milena_vocabulary_update on public.vocabulary_progress for update to anon using (student_id = 'milena') with check (student_id = 'milena');
create policy milena_vocabulary_delete on public.vocabulary_progress for delete to anon using (student_id = 'milena');

drop policy if exists milena_vocabulary_topic_select on public.vocabulary_topic_progress;
drop policy if exists milena_vocabulary_topic_insert on public.vocabulary_topic_progress;
drop policy if exists milena_vocabulary_topic_update on public.vocabulary_topic_progress;
drop policy if exists milena_vocabulary_topic_delete on public.vocabulary_topic_progress;
create policy milena_vocabulary_topic_select on public.vocabulary_topic_progress for select to anon using (student_id = 'milena');
create policy milena_vocabulary_topic_insert on public.vocabulary_topic_progress for insert to anon with check (student_id = 'milena');
create policy milena_vocabulary_topic_update on public.vocabulary_topic_progress for update to anon using (student_id = 'milena') with check (student_id = 'milena');
create policy milena_vocabulary_topic_delete on public.vocabulary_topic_progress for delete to anon using (student_id = 'milena');

drop policy if exists milena_grammar_select on public.grammar_progress;
drop policy if exists milena_grammar_insert on public.grammar_progress;
drop policy if exists milena_grammar_update on public.grammar_progress;
drop policy if exists milena_grammar_delete on public.grammar_progress;
create policy milena_grammar_select on public.grammar_progress for select to anon using (student_id = 'milena');
create policy milena_grammar_insert on public.grammar_progress for insert to anon with check (student_id = 'milena');
create policy milena_grammar_update on public.grammar_progress for update to anon using (student_id = 'milena') with check (student_id = 'milena');
create policy milena_grammar_delete on public.grammar_progress for delete to anon using (student_id = 'milena');

-- Telegram tables are server-only.
revoke all on public.telegram_recipients, public.material_publications from anon, authenticated;
grant all on public.telegram_recipients, public.material_publications to service_role;

insert into public.telegram_recipients (student_id, chat_id, enabled)
values ('milena', -1003981941831, true)
on conflict (student_id) do update
set chat_id = excluded.chat_id,
    enabled = excluded.enabled,
    updated_at = now();
