// Durable Object: contador de fallos con bloqueo. Una instancia por clave
// ("emp:<numero>" o "ip:<ip>"). Un DO procesa solicitudes de forma serializada,
// por lo que los contadores son atómicos.
export class RateLimiter {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const { action, max, windowMs, lockMs } = await request.json();
    const now = Date.now();
    let s = (await this.state.storage.get("s")) || { fails: 0, first: 0, lockedUntil: 0 };

    if (action === "reset") {
      await this.state.storage.delete("s");
      return json({ locked: false });
    }

    if (s.lockedUntil && s.lockedUntil <= now) s = { fails: 0, first: 0, lockedUntil: 0 };
    if (s.first && now - s.first > windowMs && !s.lockedUntil) s = { fails: 0, first: 0, lockedUntil: 0 };

    if (action === "fail" && !s.lockedUntil) {
      if (!s.first) s.first = now;
      s.fails += 1;
      if (s.fails >= max) s.lockedUntil = now + lockMs;
      await this.state.storage.put("s", s);
    }

    const locked = s.lockedUntil > now;
    return json({ locked, retryAfterMs: locked ? s.lockedUntil - now : 0, fails: s.fails });
  }
}

function json(o) {
  return new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
}

export async function limiter(env, key, action, cfg) {
  const id = env.RATE_LIMITER.idFromName(key);
  const stub = env.RATE_LIMITER.get(id);
  const res = await stub.fetch("https://rl/", {
    method: "POST",
    body: JSON.stringify({ action, ...cfg }),
  });
  return res.json();
}
