# My Reading

Things I've saved to read, newest first. The list lives on Curius, at
`https://curius.app/aadharsh-pannirselvam`, and this page is the on-site copy.

**This twin describes the list rather than mirroring it, because the list moves
a few times a day.** The page is built once per deploy, and the links arrive
after load from `/reading/list.html`, an HTML fragment. Read that fragment for
the current list: each entry carries the title and link, the domain, the date
it was saved, the snippet or highlight saved with it, and a star on favourites.

## Where the entries come from

- `AadharshBot` fetches the list from Curius, identified and signed like every
  other request this site makes, and caches it for six hours so a page load
  costs Curius nothing.
- Where a saved link has been discussed on Hacker News, the entry links that
  thread with its comment count. Those lookups run on a schedule, so a link
  saved in the last few hours may not have one yet.
- When Curius can't be read, the fragment says so rather than showing an empty
  list as if nothing were saved. The canonical list is always on Curius.
