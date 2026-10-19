-- v2 prep (SPEC-v2-game-platform.md, "Open decisions"): two spare progression
-- columns on players, unused for now. They have to exist before the room client
-- hardcodes what a player looks like, so v2 Phase 8 can land without another
-- schema change.
--
-- Deliberately no new policies and no new grants: xp and level inherit the
-- existing table privileges, so a client still cannot write them
-- (update on public.players is revoked from authenticated in
-- 20261017220100_phase3_players.sql and nothing has re-granted it since).

alter table public.players add column if not exists xp    integer not null default 0;
alter table public.players add column if not exists level integer not null default 1;

comment on column public.players.xp is 'Total experience points. Spare; unused until v2 Phase 8.';
comment on column public.players.level is 'Progression level derived from xp. Spare; unused until v2 Phase 8.';
