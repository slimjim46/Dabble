// The plaza's entry point into the rooms feature, or nothing at all.
//
// Rooms only exist where VITE_ROOMS_URL points at a running Worker, and that
// variable is a local/preview setting that is never set in production. The
// link is therefore decided here as a pure function of the env object, so
// tests/roomClient.test.mjs can prove it is absent when the variable is unset
// (the plaza must render exactly as before: no button, no empty space, no
// request) and present when it is set.
//
// The returned href is always the relative path '/rooms'. The plaza never
// carries the Worker URL — that lives only in src/rooms/RoomsApp.jsx — so
// production can never be pointed at the dev Worker from here.
export function roomsEntryHref(env) {
  return env && env.VITE_ROOMS_URL ? '/rooms' : null
}
