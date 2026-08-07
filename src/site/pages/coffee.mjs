import { renderDocument } from "../document.mjs";

export function renderCoffee({ stylesheet }) {
  const body = `
    <header>
      <p class="eyebrow">Control Panel · Scheduled Tasks</p>
      <h1>Coffee in New York</h1>
      <p class="lede">Choose a published half-hour, say who you are, and give me enough context to make the conversation useful. Every request is held until I confirm it.</p>
    </header>
    <section class="coffee-status" id="coffee-status"><h2>Checking the calendar</h2><p>The server publishes a slot only when the calendar snapshot is recent enough to trust.</p></section>
    <form class="coffee-form" action="/coffee/book" method="post">
      <label for="coffee-slot">Available time</label>
      <select id="coffee-slot" name="start" required disabled><option value="">No verified slots in this environment</option></select>
      <label for="coffee-name">Your name</label>
      <input id="coffee-name" name="name" autocomplete="name" maxlength="100" required>
      <label for="coffee-email">Email</label>
      <input id="coffee-email" name="email" type="email" autocomplete="email" maxlength="200" required>
      <label for="coffee-topic">What should we talk about?</label>
      <textarea id="coffee-topic" name="topic" maxlength="1000" rows="5" required></textarea>
      <label class="honeypot" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label>
      <button type="submit" disabled>Request this time</button>
    </form>
    <section class="coffee-notes"><h2>How it works</h2><ol><li>The server rechecks the slot at submission time.</li><li>An atomic reservation prevents two requests taking the same time.</li><li>I approve or decline from a signed, private link.</li><li>Confirmation arrives by email with a calendar invitation.</li></ol></section>`;

  return renderDocument({
    title: "Coffee",
    description: "Request a half-hour coffee with Aadharsh in New York.",
    path: "/coffee",
    stylesheet,
    body,
    tasks: [{ href: "/coffee/availability.json", label: "Open public availability as JSON" }, { href: "/coffee.md", label: "Read the booking contract" }],
    details: [{ term: "Timezone", value: "America/New_York" }, { term: "Duration", value: "30 minutes" }, { term: "Confirmation", value: "Required" }, { term: "Client script", value: "None" }],
    head: `<link rel="alternate" type="application/json" href="/coffee/availability.json"><link rel="alternate" type="text/markdown" href="/coffee.md">`,
  });
}

export function coffeeMarkdown() {
  return `# Coffee\n\nRequest a half-hour coffee with Aadharsh in New York.\n\n- Public availability: <https://aadhar.sh/coffee/availability.json>\n- Booking page: <https://aadhar.sh/coffee>\n- Slots are revalidated when submitted.\n- A request is pending until the host confirms it.\n`;
}
