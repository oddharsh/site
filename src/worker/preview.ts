const getWrites = new Set([
  "/hit", "/approve", "/decline", "/ledger/prefetch", "/webmention/approve", "/webmention/decline",
]);

export function previewRefusal(request: Request): Response | null {
  const url = new URL(request.url);
  const productionHost = url.hostname === "aadhar.sh" || url.hostname === "www.aadhar.sh";
  const localHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (productionHost || localHost) return null;
  const unsafe = !["GET", "HEAD", "OPTIONS"].includes(request.method) || getWrites.has(url.pathname);
  if (!unsafe) return null;
  return Response.json({ error: "Writes are disabled on version previews." }, {
    status: 403,
    headers: { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
  });
}
