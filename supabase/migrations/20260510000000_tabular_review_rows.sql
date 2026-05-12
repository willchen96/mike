-- Folder-aware tabular reviews.
-- Rows are now first-class records; a row can represent either one document or
-- a direct project subfolder containing multiple source documents.

-- Ensure helper functions exist (omitted from initial migration).
create or replace function public.current_user_id_text()
returns text
language sql
stable
set search_path = public, auth
as $$
  select auth.uid()::text;
$$;

create or replace function public.current_user_email()
returns text
language sql
stable
set search_path = public, auth
as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''));
$$;

create or replace function public.email_is_shared(shared_with jsonb)
returns boolean
language sql
stable
set search_path = public
as $$
  select public.current_user_email() <> ''
    and exists (
      select 1
      from jsonb_array_elements_text(coalesce(shared_with, '[]'::jsonb)) as emails(email)
      where lower(emails.email) = public.current_user_email()
    );
$$;

create or replace function public.project_is_accessible(target_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.projects p
    where p.id = target_project_id
      and (
        p.user_id = public.current_user_id_text()
        or public.email_is_shared(p.shared_with)
      )
  );
$$;

create or replace function public.review_is_accessible(target_review_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.tabular_reviews r
    where r.id = target_review_id
      and (
        r.user_id = public.current_user_id_text()
        or public.email_is_shared(r.shared_with)
        or (
          r.project_id is not null
          and public.project_is_accessible(r.project_id)
        )
      )
  );
$$;

alter table public.tabular_reviews
  add column if not exists document_grouping text not null default 'document'
  check (document_grouping in ('document', 'folder'));

create table if not exists public.tabular_review_rows (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.tabular_reviews(id) on delete cascade,
  label text not null,
  row_type text not null check (row_type in ('document', 'folder')),
  folder_id uuid references public.project_subfolders(id) on delete set null,
  document_id uuid references public.documents(id) on delete set null,
  sort_index integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_tabular_review_rows_review
  on public.tabular_review_rows(review_id, sort_index);

create table if not exists public.tabular_review_row_sources (
  row_id uuid not null references public.tabular_review_rows(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  sort_index integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (row_id, document_id)
);

create index if not exists idx_tabular_review_row_sources_document
  on public.tabular_review_row_sources(document_id);

alter table public.tabular_cells
  add column if not exists row_id uuid references public.tabular_review_rows(id) on delete cascade;

alter table public.tabular_cells
  alter column document_id drop not null;

create index if not exists idx_tabular_cells_review_row
  on public.tabular_cells(review_id, row_id, column_index);

-- Backfill one row per existing document-backed row.
with source_docs as (
  select distinct c.review_id, c.document_id, d.filename
  from public.tabular_cells c
  join public.documents d on d.id = c.document_id
  where c.row_id is null
),
numbered as (
  select
    review_id,
    document_id,
    filename,
    row_number() over (partition by review_id order by filename, document_id) - 1 as sort_index
  from source_docs
),
inserted as (
  insert into public.tabular_review_rows (review_id, label, row_type, document_id, sort_index)
  select review_id, filename, 'document', document_id, sort_index
  from numbered n
  where not exists (
    select 1
    from public.tabular_review_rows r
    where r.review_id = n.review_id
      and r.row_type = 'document'
      and r.document_id = n.document_id
  )
  returning id, review_id, document_id
)
insert into public.tabular_review_row_sources (row_id, document_id, sort_index)
select id, document_id, 0
from inserted
on conflict do nothing;

insert into public.tabular_review_row_sources (row_id, document_id, sort_index)
select r.id, r.document_id, 0
from public.tabular_review_rows r
where r.row_type = 'document'
  and r.document_id is not null
on conflict do nothing;

update public.tabular_cells c
set row_id = r.id
from public.tabular_review_rows r
where c.row_id is null
  and c.review_id = r.review_id
  and c.document_id = r.document_id;

alter table public.tabular_review_rows enable row level security;
alter table public.tabular_review_row_sources enable row level security;

drop policy if exists "Users can view accessible tabular review rows" on public.tabular_review_rows;
create policy "Users can view accessible tabular review rows"
  on public.tabular_review_rows for select
  using (public.review_is_accessible(review_id));

drop policy if exists "Review owners can insert tabular review rows" on public.tabular_review_rows;
create policy "Review owners can insert tabular review rows"
  on public.tabular_review_rows for insert
  with check (
    exists (
      select 1
      from public.tabular_reviews r
      where r.id = review_id
        and r.user_id = public.current_user_id_text()
    )
  );

drop policy if exists "Review owners can update tabular review rows" on public.tabular_review_rows;
create policy "Review owners can update tabular review rows"
  on public.tabular_review_rows for update
  using (
    exists (
      select 1
      from public.tabular_reviews r
      where r.id = review_id
        and r.user_id = public.current_user_id_text()
    )
  )
  with check (
    exists (
      select 1
      from public.tabular_reviews r
      where r.id = review_id
        and r.user_id = public.current_user_id_text()
    )
  );

drop policy if exists "Review owners can delete tabular review rows" on public.tabular_review_rows;
create policy "Review owners can delete tabular review rows"
  on public.tabular_review_rows for delete
  using (
    exists (
      select 1
      from public.tabular_reviews r
      where r.id = review_id
        and r.user_id = public.current_user_id_text()
    )
  );

drop policy if exists "Users can view accessible tabular row sources" on public.tabular_review_row_sources;
create policy "Users can view accessible tabular row sources"
  on public.tabular_review_row_sources for select
  using (
    exists (
      select 1
      from public.tabular_review_rows r
      where r.id = row_id
        and public.review_is_accessible(r.review_id)
    )
  );

drop policy if exists "Review owners can insert tabular row sources" on public.tabular_review_row_sources;
create policy "Review owners can insert tabular row sources"
  on public.tabular_review_row_sources for insert
  with check (
    exists (
      select 1
      from public.tabular_review_rows trr
      join public.tabular_reviews review on review.id = trr.review_id
      where trr.id = row_id
        and review.user_id = public.current_user_id_text()
    )
  );

drop policy if exists "Review owners can update tabular row sources" on public.tabular_review_row_sources;
create policy "Review owners can update tabular row sources"
  on public.tabular_review_row_sources for update
  using (
    exists (
      select 1
      from public.tabular_review_rows trr
      join public.tabular_reviews review on review.id = trr.review_id
      where trr.id = row_id
        and review.user_id = public.current_user_id_text()
    )
  )
  with check (
    exists (
      select 1
      from public.tabular_review_rows trr
      join public.tabular_reviews review on review.id = trr.review_id
      where trr.id = row_id
        and review.user_id = public.current_user_id_text()
    )
  );

drop policy if exists "Review owners can delete tabular row sources" on public.tabular_review_row_sources;
create policy "Review owners can delete tabular row sources"
  on public.tabular_review_row_sources for delete
  using (
    exists (
      select 1
      from public.tabular_review_rows trr
      join public.tabular_reviews review on review.id = trr.review_id
      where trr.id = row_id
        and review.user_id = public.current_user_id_text()
    )
  );

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.tabular_review_rows to authenticated;
grant select, insert, update, delete on public.tabular_review_row_sources to authenticated;
