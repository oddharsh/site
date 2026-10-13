---
title: "There and back"
description: "Rebuild a page here from its Markdown twin and convert it back, and find out what the page you are reading was made from."
path: "/garage/round-trip"
section: "garage"
kind: "content"
source: "https://aadhar.sh/garage/round-trip"
---

# There and back

Every page on this site has a [Markdown][markdown] twin for agents, listed in [llms.txt](https://aadhar.sh/llms.txt), and the build writes most of them by pressing the HTML down with `html-to-md.ts`. This page runs the other direction. It takes a twin, rebuilds HTML from it with a 250-line parser, and shows what came home. On 2026-10-13 I ran 59 twins through the trip, and it found five bugs in the converter that writes them, all fixed in [#1309](https://github.com/oddharsh/site/pull/1309).

## Take a page on the trip

Pick a page. Your browser fetches the page and its twin from this site, rebuilds the twin as HTML with [`md-to-html.js`](https://aadhar.sh/garage/md-to-html.src.js), and counts what each leg kept.

## The test is a fixed point

A twin is written in a small language: headings, paragraphs, lists, quotes, code fences, tables, links, images and three kinds of emphasis. If the parser reads that language exactly, then pressing its output down again has to hand back the same twin, byte for byte. That gives the trip a pass condition, and either converter can fail it.

Of the 46 twins the build writes from pages in `src/pages/`, all 46 now come back byte for byte. Before the fixes below, 42 did. The 13 hand-written twins in `src/content/md/` each settle after one trip, and every change is one of form: an autolink like `<https://…>` comes back as a bracketed link, a table rule gains spaces, and a fence loses its `json` label because the generator never writes one. No hand twin lost a word.

## What the trip caught

The trip carries two checks, and between them they found five bugs in the converter that writes twins. Each read like ordinary text, so a person reading the twin would not notice, and every agent that read one got it.

The [fixed point][fixed-point] failed on four twins, and three of those failures were one bug. The escaper treated any text run that started like a list marker as the start of a line, even mid-sentence. On /garage/horizon and /lwe/fhe that wrote `\+`, which Markdown reads back as a plus sign. On /garage/octane it wrote `Next.js \16.`, and a backslash before a digit is not an escape, so readers saw the backslash. The fourth failure was on /garage/wire, where a line break inside a table cell became three spaces.

The word count catches what the fixed point cannot, because a twin that already lost something still closes. /garage/wire and /garage/workers each lost a table caption, 197 words on wire, because the table renderer walked the rows and never visited `<caption>`. /garage/iroh read `QUIChole-punching`, because the converter dropped a text node that held only a space, and that one bug fused 33 pairs of words across 17 pages. The /lwe heading read `**Learning With Errors**explaining`, because its CSS sets the tagline apart as a block and the heading path never asked.

The trip also caught my first fix. Keeping that lone space made the homepage twin read `2026  · You`, where an HTML comment split two runs of whitespace, and the fixed point failed on it before the fix shipped.

## What never makes the trip

Across those 46 pages the HTML weighs 2.6 MB. The twins weigh 746 KB, and the rebuilt HTML weighs 836 KB. The difference is the part of a page that does something: 198 scripts, 358 buttons, 68 form controls, 21 canvases and 57 style blocks. The converter drops all of them on purpose, because a button's label without its behavior would read to an agent as a claim.

The words come through. Against the page's own reading text, the rebuilt HTML keeps every word on 44 of the 46 pages. The other two lose only superscripts: `2^n` three times on /lwe/dac and `2^256` on /lwe/lean.

Two marks cannot come back. A [superscript][superscript] becomes `^2` and a subscript becomes `_2`, and neither has a closing mark, so the parser cannot tell them from a caret or an underscore in prose. It leaves both as text.

## The page you just read

Everything above came out of a Markdown file. The HTML your browser loaded for this address holds the window, the quiz and the scripts, and none of these paragraphs. The words arrived as [/garage/round-trip.md](https://aadhar.sh/garage/round-trip.md), the same file an agent gets when it asks this address for Markdown, and the parser from the demo built this page out of it when you opened it. The dotted terms came out of it too: each one is a reference link, defined in a glossary at the end of the file, and it comes back with the same markup every hand-written page here gives a term.

So this page has no generated twin that could drift. The twin is the source, and a test holds it to the fixed point: pressing the rendered page down again has to hand back the file byte for byte. The page a person reads and the twin an agent reads cannot disagree, because one is made from the other on every visit.

[markdown]: https://commonmark.org/ "A plain-text writing format where # starts a heading, two asterisks make text bold and [text](url) makes a link. CommonMark is its precise specification."
[fixed-point]: https://en.wikipedia.org/wiki/Fixed_point_(mathematics) "A value a function hands back unchanged. A twin that converts to HTML and back to the same bytes is a fixed point of the round trip."
[superscript]: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/sup "Text set slightly above the line in smaller type, like the 2 in x squared. HTML marks it with the sup element."
