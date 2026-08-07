/* Compatibility entry point. The Lens document is now server-rendered. */
export function openLens(url) {
  const target = new URL("/lens", location.origin);
  target.searchParams.set("url", url);
  history.replaceState(null, "", target);
  location.assign(target);
}
