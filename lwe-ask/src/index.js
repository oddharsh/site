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
      note: "The CAPTCHA-gated LWE answer API was retired. The canonical explainers remain available as HTML and Markdown.",
      documentation: "https://aadhar.sh/lwe",
    }, { status: 410, headers });
  },
};
