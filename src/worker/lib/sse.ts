// Completed events from a byte-capped, UTF-8-decoded body; the decoder strips
// its BOM. No connection, retry or Last-Event-ID state: one bounded request.
export function* sseEvents(text: string) {
  let event = "";
  let data: string[] = [];
  // Discard the final unterminated line. EOF does not dispatch an event;
  // only a blank line does. CRLF, CR and LF are equivalent line endings.
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (const line of lines.slice(0, -1)) {
    if (line === "") {
      if (data.length) yield { event, data: data.join("\n") };
      event = "";
      data = [];
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
  }
}
