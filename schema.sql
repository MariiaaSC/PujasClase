-- INVEST CLASS · Esquema para Supabase
-- Pégalo entero en Supabase > SQL Editor > New query > Run.
-- Las tablas quedan BLOQUEADAS (RLS sin políticas): con la clave publicable nadie puede leerlas.
-- Todo pasa por las funciones de abajo, que comprueban la sesión y las reglas.

create table users(
  id text primary key default 's'||replace(gen_random_uuid()::text,'-',''),
  username text unique not null,
  password text not null,
  name text not null,
  role text not null check (role in ('teacher','student')),
  budget numeric not null default 10000,
  created_at timestamptz not null default now());
create table presentations(
  id text primary key default 'p'||replace(gen_random_uuid()::text,'-',''),
  name text not null,
  description text not null default '',
  owners text[] not null default '{}',
  created_at timestamptz not null default now());
create table rounds(
  id text primary key default 'r'||replace(gen_random_uuid()::text,'-',''),
  name text not null,
  status text not null default 'closed',
  created_at timestamptz not null default now());
create table app_state(id int primary key default 1 check (id=1), current_round_id text);
insert into app_state values (1,null);
create table investments(
  user_id text references users(id) on delete cascade,
  presentation_id text references presentations(id) on delete cascade,
  amount numeric not null default 0,
  primary key (user_id,presentation_id));
create table movements(
  id bigint generated always as identity primary key,
  user_id text references users(id) on delete cascade,
  presentation_id text references presentations(id) on delete cascade,
  round_id text, delta numeric, amount_after numeric,
  moved_at timestamptz not null default now());
create table sessions(
  token uuid primary key default gen_random_uuid(),
  user_id text references users(id) on delete cascade,
  created_at timestamptz not null default now());

alter table users enable row level security;
alter table presentations enable row level security;
alter table rounds enable row level security;
alter table app_state enable row level security;
alter table investments enable row level security;
alter table movements enable row level security;
alter table sessions enable row level security;
revoke all on all tables in schema public from anon, authenticated;

-- Profesor inicial (usuario y contraseña como en el prototipo). CÁMBIALA antes de usarlo en clase.
insert into users(username,password,name,role) values ('profe','admin123','Profesor','teacher');

-- ---------- Ayudas internas ----------
create function ic_user(p_token uuid) returns users language plpgsql security definer set search_path=public as $$
declare u users;
begin
  select us.* into u from users us join sessions s on s.user_id=us.id where s.token=p_token;
  if not found then raise exception 'Sesión no válida. Vuelve a entrar.'; end if;
  return u;
end $$;
create function ic_teacher(p_token uuid) returns users language plpgsql security definer set search_path=public as $$
declare u users;
begin
  u:=ic_user(p_token);
  if u.role<>'teacher' then raise exception 'No autorizado.'; end if;
  return u;
end $$;
revoke execute on function ic_user(uuid), ic_teacher(uuid) from public, anon, authenticated;

-- ---------- Acceso ----------
create function login(p_username text, p_password text) returns json language plpgsql security definer set search_path=public as $$
declare u users; t uuid;
begin
  delete from sessions where created_at < now()-interval '2 days';
  select * into u from users where username=lower(trim(p_username)) and password=p_password;
  if not found then raise exception 'Usuario o contraseña incorrectos.'; end if;
  insert into sessions(user_id) values (u.id) returning token into t;
  return json_build_object('token',t);
end $$;

-- Estado que ve cada usuario: el profesor lo ve todo; el alumno solo lo suyo + totales anónimos.
create function get_state(p_token uuid) returns json language plpgsql security definer set search_path=public as $$
declare u users; teacher boolean;
begin
  u:=ic_user(p_token); teacher:=(u.role='teacher');
  return json_build_object(
    'me',json_build_object('id',u.id,'username',u.username,'name',u.name,'role',u.role),
    'currentRoundId',(select current_round_id from app_state),
    'rounds',coalesce((select json_agg(json_build_object('id',id,'name',name,'status',status,'createdAt',created_at) order by created_at,id) from rounds),'[]'::json),
    'presentations',coalesce((select json_agg(json_build_object('id',id,'name',name,'description',description,
        'owners',case when teacher then to_json(owners) when u.id=any(owners) then json_build_array(u.id) else '[]'::json end) order by created_at,id) from presentations),'[]'::json),
    'users',coalesce((select json_agg(json_build_object('id',x.id,'username',x.username,'password',case when teacher then x.password end,'name',x.name,'role',x.role,'budget',x.budget) order by x.created_at,x.id) from users x where teacher or x.id=u.id),'[]'::json),
    'investments',coalesce((select json_object_agg(q.user_id,q.inv) from (select i.user_id, json_object_agg(i.presentation_id,i.amount) inv from investments i where teacher or i.user_id=u.id group by i.user_id) q),'{}'::json),
    'movements',coalesce((select json_agg(json_build_object('userId',m.user_id,'presentationId',m.presentation_id,'roundId',m.round_id,'delta',m.delta,'after',m.amount_after,'date',m.moved_at) order by m.id) from movements m where m.user_id=u.id),'[]'::json),
    'totals',coalesce((select json_object_agg(p.id,(select coalesce(sum(i.amount),0) from investments i join users x on x.id=i.user_id where i.presentation_id=p.id and x.role='student')) from presentations p),'{}'::json));
end $$;

-- ---------- Alumno ----------
create function set_investment(p_token uuid, p_presentation text, p_target numeric) returns void language plpgsql security definer set search_path=public as $$
declare u users; r rounds; prev numeric; d numeric; inv numeric; bud numeric;
begin
  u:=ic_user(p_token);
  if u.role<>'student' then raise exception 'Solo los alumnos pueden invertir.'; end if;
  select * into r from rounds where id=(select current_round_id from app_state);
  if not found or r.status<>'open' then raise exception 'No hay una ronda abierta.'; end if;
  if not exists(select 1 from presentations where id=p_presentation) then raise exception 'La presentación no existe.'; end if;
  if exists(select 1 from presentations where id=p_presentation and u.id=any(owners)) then raise exception 'No puedes invertir en tu propia presentación.'; end if;
  if p_target is null or p_target<0 then raise exception 'Introduce una cantidad válida.'; end if;
  select budget into bud from users where id=u.id for update;
  select coalesce(sum(amount),0) into inv from investments where user_id=u.id;
  select amount into prev from investments where user_id=u.id and presentation_id=p_presentation;
  prev:=coalesce(prev,0); d:=p_target-prev;
  if d=0 then raise exception 'La inversión no ha cambiado.'; end if;
  if bud-inv-d<0 then raise exception 'No tienes suficiente presupuesto disponible.'; end if;
  insert into investments values (u.id,p_presentation,p_target) on conflict (user_id,presentation_id) do update set amount=excluded.amount;
  insert into movements(user_id,presentation_id,round_id,delta,amount_after) values (u.id,p_presentation,r.id,d,p_target);
end $$;

-- ---------- Profesor ----------
create function create_student(p_token uuid, p_username text, p_password text) returns void language plpgsql security definer set search_path=public as $$
declare un text:=lower(trim(coalesce(p_username,'')));
begin
  perform ic_teacher(p_token);
  if un='' or coalesce(p_password,'')='' then raise exception 'Rellena todos los campos.'; end if;
  if exists(select 1 from users where username=un) then raise exception 'Ese usuario ya existe.'; end if;
  insert into users(username,password,name,role) values (un,p_password,upper(left(un,1))||substr(un,2),'student');
end $$;

create function change_budget(p_token uuid, p_user text, p_amount numeric) returns void language plpgsql security definer set search_path=public as $$
declare u users; inv numeric;
begin
  perform ic_teacher(p_token);
  if p_amount is null or p_amount=0 then return; end if;
  select * into u from users where id=p_user and role='student' for update;
  if not found then return; end if;
  select coalesce(sum(amount),0) into inv from investments where user_id=u.id;
  if u.budget+p_amount<inv then raise exception '% ya tiene % € invertidos; no puedes dejar su presupuesto por debajo de esa cantidad.',u.name,inv; end if;
  update users set budget=budget+p_amount where id=u.id;
end $$;

create function change_budget_all(p_token uuid, p_amount numeric) returns void language plpgsql security definer set search_path=public as $$
declare bad text;
begin
  perform ic_teacher(p_token);
  if p_amount is null or p_amount=0 then return; end if;
  if not exists(select 1 from users where role='student') then raise exception 'Todavía no hay alumnos.'; end if;
  select string_agg(x.name,', ') into bad from users x where x.role='student' and x.budget+p_amount<coalesce((select sum(i.amount) from investments i where i.user_id=x.id),0);
  if bad is not null then raise exception 'No se puede restar tanto: % tendría menos presupuesto que lo ya invertido.',bad; end if;
  update users set budget=budget+p_amount where role='student';
end $$;

create function delete_student(p_token uuid, p_user text) returns void language plpgsql security definer set search_path=public as $$
begin
  perform ic_teacher(p_token);
  delete from users where id=p_user and role='student';
  update presentations set owners=array_remove(owners,p_user);
end $$;

create function create_round(p_token uuid, p_name text) returns void language plpgsql security definer set search_path=public as $$
declare rid text;
begin
  perform ic_teacher(p_token);
  if trim(coalesce(p_name,''))='' then raise exception 'Escribe un nombre.'; end if;
  update rounds set status='closed';
  insert into rounds(name,status) values (trim(p_name),'open') returning id into rid;
  update app_state set current_round_id=rid;
end $$;

create function set_round(p_token uuid, p_round text, p_open boolean) returns void language plpgsql security definer set search_path=public as $$
begin
  perform ic_teacher(p_token);
  if p_open then
    update rounds set status='closed';
    update rounds set status='open' where id=p_round;
    update app_state set current_round_id=p_round;
  else
    update rounds set status='closed' where id=p_round;
    update app_state set current_round_id=null where current_round_id=p_round;
  end if;
end $$;

create function add_presentation(p_token uuid, p_name text, p_desc text, p_owners text[]) returns void language plpgsql security definer set search_path=public as $$
begin
  perform ic_teacher(p_token);
  if trim(coalesce(p_name,''))='' then raise exception 'Escribe un nombre.'; end if;
  if exists(select 1 from unnest(coalesce(p_owners,'{}')) o where not exists(select 1 from users where id=o and role='student')) then raise exception 'Algún autor no existe.'; end if;
  insert into presentations(name,description,owners) values (trim(p_name),coalesce(p_desc,''),coalesce(p_owners,'{}'));
end $$;

create function delete_presentation(p_token uuid, p_presentation text) returns void language plpgsql security definer set search_path=public as $$
begin
  perform ic_teacher(p_token);
  delete from presentations where id=p_presentation;
end $$;