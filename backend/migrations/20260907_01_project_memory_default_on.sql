-- Migration date: 2026-09-07
-- Project memory is on by default. The scoped-memory rollout
-- (20260905_01_scoped_memory_files.sql) backfilled every project that already
-- existed as opted out, so those projects opened with memory off even though
-- new projects are created with it on.
--
-- The data update also advances the learning cutoff so a project does not
-- learn conversations from the interval in which its memory was disabled.
-- The scheduler replacement keeps lazy recovery coherent with the default:
-- a missing project-memory row is created enabled, just like every other
-- project-memory entry point.
--
-- Only rows that still carry their backfilled state are flipped. A project
-- somebody deliberately turned off went through wipe_memory_file, which stamps
-- last_source = 'settings', updated_by, and advances epoch/version, so those
-- rows fail this predicate and stay off. A project created with the memory
-- toggle cleared writes its row inside create_project's transaction, giving it
-- the same created_at as the project itself; the backfill ran later, so that
-- explicit opt-out is preserved too.
update public.memory_files as file
set enabled = true,
    learning_cutoff_at = greatest(file.learning_cutoff_at, now()),
    updated_at = now()
from public.projects as project
where file.project_id = project.id
  and file.scope = 'project'
  and file.enabled = false
  and file.epoch = 0
  and file.version = 0
  and file.status = 'idle'
  and file.current_version_id is null
  and file.last_source is null
  and file.last_error_code is null
  and file.updated_by is null
  and file.created_at > project.created_at;

-- This function is several hundred lines and already carries the concurrency,
-- attribution, and authorization fences installed by the scoped-memory
-- migration. Upgrade exactly its one lazy project-file default in place so a
-- deployment cannot accidentally regress a later scheduler hardening. The
-- guards make the migration idempotent while failing closed on an unexpected
-- function definition.
do $project_memory_scheduler_default$
declare
  scheduler regprocedure := to_regprocedure(
    'public.schedule_memory_consolidation(text,uuid,uuid,uuid,uuid,uuid,integer)'
  );
  definition text;
  upgraded text;
  disabled_literal constant text :=
    'values (''project'', activity.project_id, false)';
  enabled_literal constant text :=
    'values (''project'', activity.project_id, true)';
  disabled_occurrences integer;
begin
  if scheduler is null then
    raise exception 'schedule_memory_consolidation is not installed';
  end if;

  definition := pg_get_functiondef(scheduler);
  disabled_occurrences :=
    (length(definition) - length(replace(definition, disabled_literal, '')))
    / length(disabled_literal);

  if disabled_occurrences = 0
     and position(enabled_literal in definition) > 0 then
    return;
  end if;
  if disabled_occurrences <> 1 then
    raise exception
      'unexpected schedule_memory_consolidation project-memory default';
  end if;

  upgraded := replace(definition, disabled_literal, enabled_literal);
  execute upgraded;
end;
$project_memory_scheduler_default$;
