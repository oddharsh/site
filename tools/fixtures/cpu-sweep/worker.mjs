// A Worker for cpu-sweep's own test: /spin burns 12 ms of CPU, everything else
// answers at once. The sweep has to read the first as over its 8 ms gate and
// the second as under it, or it can't tell a slow route from a fast one. /icu
// is a route's first date format and collation, which a warm process makes cheap.
// /copy answers 500 unless a declared binding survives a copy of env, as cal's
// { ...env, BASE_PATH } needs.
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/copy") {
      const copy = { ...env };
      const keys = await copy.BOOKINGS?.list?.({ prefix: "held:" });
      return new Response(null, { status: Array.isArray(keys?.keys) && copy.HOST_TIMEZONE ? 200 : 500 });
    }
    if (new URL(request.url).pathname === "/icu") {
      new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric" }).format(0);
      "b".localeCompare("a");
    }
    if (new URL(request.url).pathname === "/spin") {
      const start = process.cpuUsage();
      for (;;) { const d = process.cpuUsage(start); if ((d.user + d.system) / 1000 >= 12) break; }
    }
    return new Response("ok");
  },
};
