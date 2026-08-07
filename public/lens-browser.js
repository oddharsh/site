/* Compatibility client for callers that used the original Browser Run helper. */
export const LensBrowser = Object.freeze({
  endpoint: "/lens/browser",
  async inspect(url) {
    const endpoint = new URL(this.endpoint, location.origin);
    endpoint.searchParams.set("url", url);
    const response = await fetch(endpoint, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Browser inspection failed (${response.status})`);
    return response.json();
  },
});
