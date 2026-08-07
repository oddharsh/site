import { DurableObject } from "cloudflare:workers";

export class Counter extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let count = await this.ctx.storage.get<number>("n") ?? 0;
    if (!url.searchParams.has("peek") && request.method !== "HEAD") {
      count += 1;
      await this.ctx.storage.put("n", count);
    }
    return Response.json({ n: count });
  }
}

export async function hit(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const speculative = /prefetch|prerender/i.test(request.headers.get("sec-purpose") ?? "");
  const bot = /bot|crawl|spider|slurp/i.test(request.headers.get("user-agent") ?? "");
  const peek = request.method === "HEAD" || url.searchParams.has("peek") || speculative || bot;
  const stub = env.COUNTER.getByName("homepage-visits");
  const read = async () => {
    const response = await stub.fetch(`https://counter.invalid/${peek ? "?peek=1" : ""}`);
    return (await response.json<{ n: number }>()).n;
  };

  if (url.searchParams.has("tick")) {
    ctx.waitUntil(read().then((count) => env.RN_KV.put("counter:n", String(count))).catch(() => undefined));
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }

  const count = await read().catch(() => null);
  const digits = typeof count === "number" ? String(count).padStart(6, "0") : "------";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="58" height="14" viewBox="0 0 58 14" role="img" aria-label="visitor ${digits}"><rect width="58" height="14" fill="#0c2d58"/><text x="3" y="11" font-family="Courier New,monospace" font-size="11" fill="#fff">${digits}</text></svg>`;
  return new Response(svg, {
    headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
  });
}
