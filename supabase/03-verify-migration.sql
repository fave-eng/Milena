-- Milena English Space v2 — verification. Run after migration.

select 'legacy rows' as check_name, count(*)::text as result
from public.progress where student = 'milena'
union all
select 'backup rows', count(*)::text from public.progress_legacy_backup where student = 'milena'
union all
select 'new homework rows', count(*)::text from public.homework_progress where student_id = 'milena'
union all
select 'new vocabulary rows', count(*)::text from public.vocabulary_progress where student_id = 'milena'
union all
select 'new vocabulary topic rows', count(*)::text from public.vocabulary_topic_progress where student_id = 'milena'
union all
select 'new grammar rows', count(*)::text from public.grammar_progress where student_id = 'milena';

select
  lesson_id,
  status,
  score_correct,
  score_total,
  score_percent,
  jsonb_object_keys(answers) as migrated_answer_block
from public.homework_progress
where student_id = 'milena'
order by lesson_id, migrated_answer_block;

select status, count(*)
from public.vocabulary_progress
where student_id = 'milena'
group by status
order by status;

select student_id, chat_id, enabled
from public.telegram_recipients
where student_id = 'milena';

select tablename, policyname, roles, cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('homework_progress','vocabulary_progress','vocabulary_topic_progress','grammar_progress')
order by tablename, cmd;
