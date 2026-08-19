create table if not exists todos (
  id text primary key,
  list_id text not null,
  owner_id text not null,
  text text not null,
  completed boolean not null default false,
  updated_at timestamptz not null default now()
);

create index if not exists todos_list_owner_idx on todos (list_id, owner_id);

insert into todos (id, list_id, owner_id, text, completed, updated_at)
values
  ('todo-1', 'list-1', 'user-1', 'Wire Electric to Postgres', false, now()),
  ('todo-2', 'list-1', 'user-1', 'Watch the optimistic write sync back', false, now()),
  ('private-todo', 'list-1', 'user-2', 'Must not cross the auth shape', false, now())
on conflict (id) do update set
  list_id = excluded.list_id,
  owner_id = excluded.owner_id,
  text = excluded.text,
  completed = excluded.completed,
  updated_at = excluded.updated_at;
