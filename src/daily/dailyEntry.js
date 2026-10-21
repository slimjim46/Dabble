// The plaza's entry point into the daily challenge, or nothing at all.
//
// The daily challenge is a v2 feature that only exists where VITE_DAILY_CHALLENGE
// is set (a local/preview setting, never production). The link is a pure
// function of the env object — the same pattern as roomsEntryHref — so the
// plaza renders exactly as before when the flag is unset (no button, no empty
// space, no request).
export function dailyEntryHref(env) {
  return env && env.VITE_DAILY_CHALLENGE ? '/daily' : null
}
