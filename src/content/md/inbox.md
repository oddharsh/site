# Inbox

When someone links to a page here from their own site, their post can arrive as
a Webmention (https://www.w3.org/TR/webmention/), the standards-track
descendant of the trackback. The inbox shows the ones that were verified and
then approved by hand, rendered as mail.

**This twin describes the inbox rather than mirroring it, because the mail
changes as mentions arrive.** The page is built once per deploy, and the
approved mentions arrive after load from `/inbox/mail.html`, an HTML fragment
with one row per mention: who sent it, the subject, the kind, the page it
mentions and when it was received. Read that fragment for the current list.

## Sending a mention

- Endpoint: `https://aadhar.sh/webmention`. POST `source` and `target`, form
  encoded (`application/x-www-form-urlencoded`).
- `target` has to be a page on this site that accepts mentions, and `source`
  has to be a public http(s) URL.
- The source is fetched as `AadharshBot` to confirm it really links to the
  target. That check is what keeps the endpoint from being a spam door.
- Mentions are moderated, so nothing appears in the inbox automatically.
- Sending a mention again after the link is gone retracts it.

The IndieWeb wiki (https://indieweb.org/Webmention) keeps the working notes:
who sends, who receives, and what breaks between them.
