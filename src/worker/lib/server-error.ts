// What a visitor gets when a handler throws.
//
// Before this, nothing above route() caught, so an uncaught throw fell through
// to Cloudflare's generic error page: no way back into the site, and nothing a
// visitor could quote when reporting it. This answers 500 in the format the
// caller asked for (a Luna window for a browser, the /openapi.json Error object
// for JSON and API-shaped paths, plain text otherwise), carrying the cf-ray as
// the reference.
//
// Catching does NOT hide the failure from Workers Issues: Issues records any 5xx
// response and any console.error, as well as uncaught throws
// (developers.cloudflare.com/workers/observability/issues/), and the caller
// logs the error before calling this. The triage routine
// (docs/routines/workers-issue-triage.md) still fires.
//
// Node-safe (gotcha 16): the contract suite imports it outside workerd.

import { lunaPage } from "./chrome.ts";
import { html } from "./html.ts";
import { namesHtml, wantsJson } from "./http.ts";
import { API_CALL_PATH } from "./not-found.ts";

export function serverError(request: Request): Response {
  const url = new URL(request.url);
  const ray = request.headers.get("cf-ray") || "";
  const head = request.method === "HEAD";
  const json = wantsJson(request) || (API_CALL_PATH.test(url.pathname) && !namesHtml(request));

  if (json) {
    const body = {
      ok: false,
      error: `The server failed while answering ${url.pathname}.`,
      code: "internal_error",
      status: 500,
      hint: ray ? `Retry, and quote ray ${ray} if it keeps failing.` : "Retry in a moment.",
      docs: `${url.origin}/developers`,
    };
    return new Response(head ? null : `${JSON.stringify(body, null, 2)}\n`, {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", vary: "accept" },
    });
  }

  if (namesHtml(request)) {
    const page = lunaPage({
      title: "The page cannot be displayed",
      path: url.pathname,
      robots: "noindex",
      status: 500,
      cache: "no-store",
      headers: { vary: "accept" },
      body: html`<h1>The page cannot be displayed</h1>
<p>Something broke on the server while it built <code>${url.pathname}</code>. The error is logged, and reloading may work.</p>${ray ? html`
<p>If it keeps happening, <a href="/contact">get in touch</a> and quote ray <code>${ray}</code>.</p>` : ""}
<p><a href="/">Back to the homepage</a></p>`,
    });
    return head ? new Response(null, page) : page;
  }

  const text = `500 Internal Server Error: ${url.pathname}\n${ray ? `ray: ${ray}\n` : ""}`;
  return new Response(head ? null : text, {
    status: 500,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", vary: "accept" },
  });
}
