-- Phase 5a: bounding boxes for visible-stroke proximity queries.
--
-- strokes_near() is the cheap "what did I tap?" query for Phase 5 clients: it
-- narrows thousands of strokes down to a handful with one GiST index lookup,
-- instead of shipping every stroke's points to the browser.
--
-- Additive on the existing strokes table; does not touch any existing trigger.
alter table public.strokes add column if not exists bbox box null;

-- Immutable geometry helper: bounding box of a flat [x, y, x, y, ...] array.
create or replace function public.stroke_bbox(points jsonb)
returns box
language plpgsql
immutable
set search_path = ''
as $$
declare
  vals double precision[];
  xs double precision[];
  ys double precision[];
begin
  if points is null or jsonb_typeof(points) <> 'array' then
    return null;
  end if;

  select array_agg((e.value #>> '{}')::double precision order by e.ord)
  into vals
  from jsonb_array_elements(points) with ordinality as e(value, ord)
  where jsonb_typeof(e.value) = 'number';

  if vals is null or array_length(vals, 1) is null then
    return null;
  end if;

  select array_agg(vals[i]), array_agg(vals[i + 1])
  into xs, ys
  from generate_series(1, array_length(vals, 1) - 1, 2) as i;

  return box(
    point((select min(x) from unnest(xs) as x), (select min(y) from unnest(ys) as y)),
    point((select max(x) from unnest(xs) as x), (select max(y) from unnest(ys) as y))
  );
end;
$$;
revoke execute on function public.stroke_bbox(jsonb) from public, anon;
grant execute on function public.stroke_bbox(jsonb) to authenticated;

-- A NEW BEFORE INSERT trigger. Its name sorts after strokes_before_insert
-- ('b' < 's'), so validation and the ink/limit checks run first; by the time it
-- computes the box the points are known to be a valid, in-range even-length
-- array.
create or replace function public.strokes_set_bbox()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.bbox := public.stroke_bbox(new.points);
  return new;
end;
$$;

drop trigger if exists strokes_set_bbox on public.strokes;
create trigger strokes_set_bbox
  before insert on public.strokes
  for each row
  execute function public.strokes_set_bbox();

create index if not exists strokes_bbox_gist_idx
  on public.strokes using gist (bbox);

-- Filtered backfill in batches of 1000 so the table never locks for long.
do $$
declare
  touched integer;
begin
  loop
    update public.strokes
    set bbox = public.stroke_bbox(points)
    where id in (
      select id from public.strokes
      where bbox is null
      limit 1000
    );
    get diagnostics touched = row_count;
    exit when touched = 0;
  end loop;
end $$;

-- Up to 10 visible strokes whose bounding box overlaps the point +/- radius,
-- newest first. Radius is capped at 40 (the widest stroke). Aggregates only
-- what the caller needs to draw a hit: no user_id, no created_at.
create or replace function public.strokes_near(
  p_x real,
  p_y real,
  p_radius real default 8
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with r as (
    select greatest(least(coalesce(p_radius, 8::real), 40::real), 0::real)::double precision as radius
  ),
  area as (
    select box(
      point(p_x::double precision - r.radius, p_y::double precision - r.radius),
      point(p_x::double precision + r.radius, p_y::double precision + r.radius)
    ) as b
    from r
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', hit.id,
        'user_name', hit.user_name,
        'color', hit.color,
        'width', hit.width,
        'points', hit.points
      )
      order by hit.created_at desc, hit.id desc
    ),
    '[]'::jsonb
  )
  from (
    select s.id, s.user_name, s.color, s.width, s.points, s.created_at
    from public.strokes s, area
    where s.hidden = false
      and s.bbox is not null
      and s.bbox && area.b
    order by s.created_at desc, s.id desc
    limit 10
  ) hit;
$$;
revoke execute on function public.strokes_near(real, real, real) from public, anon;
grant execute on function public.strokes_near(real, real, real) to authenticated;
