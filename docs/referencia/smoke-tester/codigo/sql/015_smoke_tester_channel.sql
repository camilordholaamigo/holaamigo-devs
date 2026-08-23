-- ============================================================
-- 015_smoke_tester_channel.sql
-- Smoke Tester: real WhatsApp testing via Callbell.
-- Adds the Callbell channel and the target phone (the agent we
-- are testing). The runner sends messages FROM the channel and
-- captures replies via the webhook filter.
-- ============================================================

alter table public.smoke_test_suites
  add column if not exists channel_uuid text,
  add column if not exists target_phone text;

-- Index test_phone so the webhook can quickly find an active
-- suite when a Callbell event arrives at our channel.
create index if not exists idx_smoke_suites_test_phone
  on public.smoke_test_suites (test_phone);

-- Track which result is currently expecting a reply, so the
-- webhook can append the agent's response to the right row
-- without races between sequences.
alter table public.smoke_test_results
  add column if not exists awaiting_reply boolean not null default false,
  add column if not exists last_buyer_at  timestamptz;

create index if not exists idx_smoke_results_awaiting
  on public.smoke_test_results (awaiting_reply)
  where awaiting_reply = true;
