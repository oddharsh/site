const headers = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex",
};

export default {
  fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    return Response.json({
      error: "gone",
      status: 410,
      note: "The Cloudflare feature-demo API was retired by the blank-slate site. The preserved write-up is at /garage/cloudflare.",
      documentation: "https://aadhar.sh/garage/cloudflare",
    }, { status: 410, headers });
  },
};
