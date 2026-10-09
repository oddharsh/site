// A Worker for cpu-sweep's own test: /spin burns 12 ms of CPU, everything else
// answers at once. The sweep has to read the first as over its 8 ms gate and
// the second as under it, or it can't tell a slow route from a fast one. /icu
// is a route's first date format and collation, which a warm process makes cheap.
export default {
  async fetch(request) {
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
