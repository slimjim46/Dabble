create table if not exists public.daily_prompt_pool (
  id      bigint generated always as identity primary key,
  prompt  text not null unique check (char_length(prompt) between 1 and 40),
  used_on date null
);
alter table public.daily_prompt_pool enable row level security;
revoke all on table public.daily_prompt_pool from anon, authenticated;

insert into public.daily_prompt_pool (prompt) values
('A sleepy cat'),('A robot eating pizza'),('A dragon wearing a tiny hat'),
('A haunted toaster'),('A snail on a skateboard'),('Your dream treehouse'),
('A penguin in the desert'),('A cloud with feelings'),('The world''s worst superhero'),
('A cactus in love'),('A ghost afraid of the dark'),('A fish riding a bicycle'),
('An octopus playing drums'),('A potato with big plans'),('The last slice of pizza'),
('A wizard making breakfast'),('A tiny elephant'),('A castle made of cheese'),
('A bear on a surfboard'),('A snowman on vacation'),('A dog driving a bus'),
('A very fancy sandwich'),('A monster under the bed'),('An astronaut on a picnic'),
('A giraffe in a scarf'),('A pirate with a pet crab'),('A hedgehog baker'),
('A spaceship made of food'),('A lighthouse at midnight'),('A frog king'),
('A llama in sunglasses'),('The moon''s night off'),('A robot learning to dance'),
('A sloth in a hurry'),('A mermaid at the bus stop'),('A volcano with hiccups'),
('A duck in a raincoat'),('A knight afraid of sheep'),('A banana detective'),
('A flying carpet traffic jam'),('A raccoon heist'),('A teapot house'),
('A giant sunflower'),('A yeti on a ski lift'),('A haunted library'),
('A squirrel with a jetpack'),('A rainbow slide'),('An alien at the supermarket'),
('A whale in the sky'),('A cozy cabin in the snow'),('A turtle racing a rabbit'),
('A very polite monster'),('A dinosaur at the dentist'),('A broccoli superhero'),
('A walking house'),('A tiny dragon''s birthday'),('A bee with a briefcase'),
('A pizza planet'),('A bridge made of candy'),('An owl professor'),
('A mushroom village'),('A robot gardener'),('A unicorn stuck in traffic'),
('A shark learning to swim'),('A lost balloon'),('A wizard''s messy desk'),
('A bunny astronaut'),('A coffee-powered robot'),('A jellyfish disco'),
('A train through the clouds'),('A scarecrow''s day off'),('A crab in a tuxedo'),
('A cake with a secret'),('A cow on the moon'),('A tiny town in a teacup'),
('A parrot pirate captain'),('A friendly tornado'),('A fox reading a book'),
('A bathtub boat'),('A dancing lighthouse'),('Your favorite food as a person'),
('A sandwich with legs'),('A haunted pumpkin patch'),('A snail''s fast car'),
('A kangaroo with a backpack'),('A mountain with a face'),('A city in a fish tank'),
('A knight and his tiny horse'),('The coziest place ever'),('Something that glows'),
('A monster''s lunchbox'),('A robot''s first snow'),('A bear''s picnic'),
('A lazy dragon'),('A door to somewhere magical'),('A zebra with polka dots'),
('A tiny pirate ship in a puddle'),('A town on a turtle''s back'),('A cat wizard')
on conflict (prompt) do nothing;

create or replace function public.ensure_daily_prompts(p_days_ahead integer default 7)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  d date;
  picked bigint;
  picked_text text;
  added integer := 0;
begin
  if p_days_ahead < 0 or p_days_ahead > 30 then
    raise exception 'p_days_ahead out of range' using errcode = '22023';
  end if;
  for d in
    select g::date
    from generate_series(
      (now() at time zone 'utc')::date,
      (now() at time zone 'utc')::date + p_days_ahead,
      interval '1 day') g
  loop
    if exists (select 1 from public.daily_prompts where prompt_date = d) then
      continue;  -- never overwrite a prompt you set by hand
    end if;
    -- least recently used first, so the pool recycles by itself
    select id, prompt into picked, picked_text
    from public.daily_prompt_pool
    order by used_on asc nulls first, random()
    limit 1
    for update skip locked;
    if picked is null then
      raise exception 'daily_prompt_pool is empty' using errcode = 'P0001';
    end if;
    insert into public.daily_prompts (prompt_date, prompt)
    values (d, picked_text)
    on conflict (prompt_date) do nothing;
    update public.daily_prompt_pool set used_on = d where id = picked;
    added := added + 1;
  end loop;
  return added;
end;
$$;
revoke execute on function public.ensure_daily_prompts(integer) from public, anon, authenticated;
