// Room Durable Object. Replaced in the next commit with the full
// implementation (seats, presence, host/kick, timers, wire handling);
// this skeleton exists so every commit has a valid module graph.
export class Room {
  constructor(state, env) {
    this.state = state
    this.env = env
  }

  async fetch() {
    return new Response('not implemented', { status: 501 })
  }
}
