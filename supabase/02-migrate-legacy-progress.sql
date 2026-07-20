-- Milena English Space v2 — migrate the existing public.progress row.
-- Run only AFTER 01-schema-v2.sql.
-- The legacy public.progress table remains untouched. A backup copy is also created.

begin;

do $$
begin
  if to_regclass('public.progress') is null then
    raise exception 'Legacy table public.progress was not found. Stop: there is nothing to migrate.';
  end if;
end;
$$;

do $$
begin
  if to_regclass('public.progress_legacy_backup') is null then
    execute 'create table public.progress_legacy_backup as table public.progress with no data';
  end if;
end;
$$;

delete from public.progress_legacy_backup where student = 'milena';
insert into public.progress_legacy_backup
select * from public.progress where student = 'milena';

create or replace function public.milena_legacy_lesson1_answers(payload jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  source jsonb := coalesce(payload -> 'answers', payload, '{}'::jsonb);
  ex1 jsonb := '{}'::jsonb;
  ex2 jsonb := '{}'::jsonb;
  ex4 jsonb := '{}'::jsonb;
  ex5_before jsonb := '{}'::jsonb;
  ex5_after jsonb := '{}'::jsonb;
  ex6 jsonb := '{}'::jsonb;
  ex7 jsonb := '{}'::jsonb;
begin
  select coalesce(jsonb_object_agg(ord::text,
    to_jsonb(case lower(item->>'answer')
      when 'a' then '0' when 'b' then '1' when 'c' then '2' when 'd' then '3'
      when 'e' then '4' when 'f' then '5' when 'g' then '6' when 'h' then '7'
      else '' end)), '{}'::jsonb)
  into ex1
  from jsonb_array_elements(coalesce(source->'ex1','[]'::jsonb)) with ordinality as x(item,ord);

  select coalesce(jsonb_object_agg(ord::text,
    to_jsonb(case lower(item->>'answer')
      when 'journalist' then '0' when 'pilot' then '1' when 'nurse' then '2'
      when 'engineer' then '3' when 'sales manager' then '4' when 'soldier' then '5'
      when 'scientist' then '6' when 'police officer' then '7' else '' end)), '{}'::jsonb)
  into ex2
  from jsonb_array_elements(coalesce(source->'ex2','[]'::jsonb)) with ordinality as x(item,ord);

  select coalesce(jsonb_object_agg(ord::text, to_jsonb(coalesce(item->>'answer',''))), '{}'::jsonb)
  into ex4
  from jsonb_array_elements(coalesce(source->'ex4','[]'::jsonb)) with ordinality as x(item,ord);

  select coalesce(jsonb_object_agg(ord::text,
    to_jsonb(case item->>'before_audio' when 'True' then '0' when 'False' then '1' else '' end)), '{}'::jsonb)
  into ex5_before
  from jsonb_array_elements(coalesce(source->'ex5','[]'::jsonb)) with ordinality as x(item,ord);

  select coalesce(jsonb_object_agg(ord::text,
    to_jsonb(case item->>'after_audio' when 'True' then '0' when 'False' then '1' else '' end)), '{}'::jsonb)
  into ex5_after
  from jsonb_array_elements(coalesce(source->'ex5','[]'::jsonb)) with ordinality as x(item,ord);

  ex6 := jsonb_build_object('1', case when coalesce((source->>'ex6_checked')::boolean,false) then '0' else '' end);

  select coalesce(jsonb_object_agg(ord::text,
    to_jsonb(case when coalesce((item->>'checked')::boolean,false) then '0' else '1' end)), '{}'::jsonb)
  into ex7
  from jsonb_array_elements(coalesce(source->'ex7','[]'::jsonb)) with ordinality as x(item,ord);

  return jsonb_build_object(
    'jobs-photo-match', ex1,
    'job-descriptions', ex2,
    'questions-order', ex4,
    'firefighter-prediction', ex5_before,
    'firefighter-check', ex5_after,
    'audio-confirmation', ex6,
    'firefighter-activities', ex7
  );
end;
$$;

insert into public.homework_progress (
  student_id, student_name, lesson_id, lesson_title, status, answers,
  score_correct, score_total, score_percent, checked_at, submitted_at, created_at, updated_at
)
select
  'milena',
  'Milena',
  'lesson-' || score_entry.key,
  coalesce(p.published_lessons -> score_entry.key ->> 'title', 'Lesson ' || score_entry.key),
  'submitted',
  case
    when score_entry.key = '1' then public.milena_legacy_lesson1_answers(p.hw_answers -> score_entry.key)
    else jsonb_build_object('legacy', coalesce(p.hw_answers -> score_entry.key, '{}'::jsonb))
  end,
  nullif(score_entry.value ->> 'score','')::integer,
  nullif(score_entry.value ->> 'max_score','')::integer,
  nullif(score_entry.value ->> 'percent','')::integer,
  coalesce(nullif(score_entry.value ->> 'updated_at','')::timestamptz, p.updated_at, now()),
  coalesce(nullif(score_entry.value ->> 'updated_at','')::timestamptz, p.updated_at, now()),
  coalesce(p.updated_at, now()),
  coalesce(nullif(score_entry.value ->> 'updated_at','')::timestamptz, p.updated_at, now())
from public.progress p
cross join lateral jsonb_each(coalesce(p.hw_scores,'{}'::jsonb)) as score_entry(key,value)
where p.student = 'milena'
on conflict (student_id, lesson_id) do update
set student_name = excluded.student_name,
    lesson_title = excluded.lesson_title,
    status = excluded.status,
    answers = excluded.answers,
    score_correct = excluded.score_correct,
    score_total = excluded.score_total,
    score_percent = excluded.score_percent,
    checked_at = excluded.checked_at,
    submitted_at = excluded.submitted_at,
    updated_at = excluded.updated_at;

insert into public.vocabulary_progress (
  student_id, word_key, word_id, en, ru, source_topic_id, status, learned_at, created_at, updated_at
)
select
  'milena',
  lower(trim(status_entry.key)),
  'lesson-1-' || regexp_replace(lower(trim(status_entry.key)), '[^a-z0-9]+', '-', 'g'),
  status_entry.key,
  '',
  'vocab-lesson-1',
  case when trim(both '"' from status_entry.value::text) = '2' then 'known' else 'difficult' end,
  case when trim(both '"' from status_entry.value::text) = '2'
    then coalesce(nullif(p.vocab_progress->'1'->>'updated_at','')::timestamptz, p.updated_at, now())
    else null end,
  coalesce(p.updated_at, now()),
  coalesce(nullif(p.vocab_progress->'1'->>'updated_at','')::timestamptz, p.updated_at, now())
from public.progress p
cross join lateral jsonb_each(coalesce(p.vocab_progress->'1'->'statuses','{}'::jsonb)) as status_entry(key,value)
where p.student = 'milena'
  and trim(both '"' from status_entry.value::text) in ('1','2')
on conflict (student_id, word_key) do update
set status = excluded.status,
    source_topic_id = excluded.source_topic_id,
    learned_at = excluded.learned_at,
    updated_at = excluded.updated_at;

insert into public.vocabulary_topic_progress (student_id, topic_id, tests, created_at, updated_at)
select
  'milena',
  'vocab-lesson-1',
  case when coalesce(p.vocab_progress->'1'->>'test_score','') <> ''
    then jsonb_build_array(jsonb_build_object(
      'scoreText', p.vocab_progress->'1'->>'test_score',
      'percent', coalesce(nullif(p.vocab_progress->'1'->>'test_percent','')::integer,0),
      'completedAt', coalesce(nullif(p.vocab_progress->'1'->>'updated_at','')::timestamptz, p.updated_at, now())
    ))
    else '[]'::jsonb end,
  coalesce(p.updated_at, now()),
  coalesce(nullif(p.vocab_progress->'1'->>'updated_at','')::timestamptz, p.updated_at, now())
from public.progress p
where p.student = 'milena'
on conflict (student_id, topic_id) do update
set tests = excluded.tests,
    updated_at = excluded.updated_at;

insert into public.grammar_progress (student_id, topic_id, passed, attempts, best_score, passed_at, created_at, updated_at)
select
  'milena',
  'legacy-grammar-lesson-' || grammar_entry.key,
  not coalesce((grammar_entry.value->>'needs_lesson')::boolean,false),
  1,
  greatest(0, least(100, coalesce(nullif(grammar_entry.value->>'percent','')::integer,0))),
  case when not coalesce((grammar_entry.value->>'needs_lesson')::boolean,false) then coalesce(p.updated_at,now()) else null end,
  coalesce(p.updated_at,now()),
  coalesce(p.updated_at,now())
from public.progress p
cross join lateral jsonb_each(coalesce(p.grammar_results,'{}'::jsonb)) as grammar_entry(key,value)
where p.student = 'milena'
on conflict (student_id, topic_id) do update
set passed = excluded.passed,
    attempts = greatest(public.grammar_progress.attempts, excluded.attempts),
    best_score = greatest(public.grammar_progress.best_score, excluded.best_score),
    passed_at = coalesce(public.grammar_progress.passed_at, excluded.passed_at),
    updated_at = excluded.updated_at;

commit;

-- The helper can be removed after a successful migration.
drop function if exists public.milena_legacy_lesson1_answers(jsonb);
