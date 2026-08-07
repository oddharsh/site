interface Field {
  k: string;
  v: string;
}

interface Group {
  title: string;
  fields: Field[];
}

function shown(value: unknown, fallback = "not supplied"): string {
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function requestProfile(request: Request, env: Env): { groups: Group[]; request: Record<string, unknown>; edge: Record<string, unknown> } {
  const cf = request.cf ?? {};
  const headers = request.headers;
  const requestData = {
    ip: headers.get("cf-connecting-ip"),
    userAgent: headers.get("user-agent"),
    acceptLanguage: headers.get("accept-language"),
    referer: headers.get("referer"),
    dnt: headers.get("dnt") === "1",
    cookies: headers.has("cookie") ? "present" : "none",
  };
  const edge = {
    colo: cf.colo ?? null,
    country: cf.country ?? null,
    region: cf.region ?? null,
    city: cf.city ?? null,
    timezone: cf.timezone ?? null,
    asn: cf.asn ?? null,
    organization: cf.asOrganization ?? null,
    httpProtocol: cf.httpProtocol ?? null,
    tlsVersion: cf.tlsVersion ?? null,
  };
  const groups: Group[] = [
    {
      title: "Network adapter",
      fields: [
        { k: "IP address", v: shown(requestData.ip) },
        { k: "ISP / ASN", v: `${shown(edge.organization)}${edge.asn ? ` (AS${edge.asn})` : ""}` },
        { k: "Country", v: shown(edge.country) },
        { k: "Region", v: shown(edge.region) },
        { k: "City", v: shown(edge.city) },
        { k: "Timezone", v: shown(edge.timezone) },
        { k: "Cloudflare colo", v: shown(edge.colo) },
      ],
    },
    {
      title: "Transport & security",
      fields: [
        { k: "HTTP version", v: shown(edge.httpProtocol) },
        { k: "TLS version", v: shown(edge.tlsVersion) },
        { k: "Accept-Encoding", v: shown(headers.get("accept-encoding")) },
      ],
    },
    {
      title: "Computer",
      fields: [
        { k: "User agent", v: shown(requestData.userAgent) },
        { k: "Languages", v: shown(requestData.acceptLanguage) },
        { k: "Do-not-track", v: requestData.dnt ? "set (1)" : "not set" },
      ],
    },
    {
      title: "This session",
      fields: [
        { k: "Referrer", v: shown(requestData.referer, "none") },
        { k: "Cookies sent", v: requestData.cookies },
        { k: "Serving version", v: shown(env.CF_VERSION_METADATA?.id, "local development") },
      ],
    },
  ];
  return { groups, request: requestData, edge };
}

export function requestDetailsHtml(groups: Group[]): string {
  return groups.map((group) => `<div class="request-group"><dt>${escapeHtml(group.title)}</dt><dd><dl>${group.fields.map((field) => `<dt>${escapeHtml(field.k)}</dt><dd>${escapeHtml(field.v)}</dd>`).join("")}</dl></dd></div>`).join("");
}
