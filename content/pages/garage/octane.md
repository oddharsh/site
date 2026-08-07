---
title: "aadhar.sh/garage/octane: Octane, priced against no framework"
description: "Nextane ships 60.9% less client JavaScript than Next.js 16. Re-measuring that claim on the live demo, then adding the row every framework benchmark leaves out: a site that ships no framework at all."
path: "/garage/octane"
section: "garage"
kind: "content"
updated: "2026-07-31"
source: "https://aadhar.sh/garage/octane"
---

# Octane, priced against no framework

A benchmark told me Nextane ships 60.9% less client JavaScript than Next.js 16. That is a real number, honestly measured, and I checked it against the deployed demo. What the table cannot tell you is where zero sits, because every row in it is a framework. This site makes a useful zero: it ships no framework at all, so putting it on the same axis turns a ranking into a distance.

## The benchmark, and what it leaves out

[Nextane](https://github.com/southpolesteve/nextane) rebuilds the Next.js Pages Router on [Octane](https://github.com/octanejs/octane), a compiled React replacement descended from Inferno that drops the virtual DOM and has its compiler infer reactivity instead of asking you for dependency arrays. Its README publishes this, measured on one small hydrated `getServerSideProps` page:

| Runtime | Client JavaScript (gzip) | Against Next.js |
| --- | --- | --- |
| Next.js 16.2.12 | 110.0 KiB | baseline |
| Vinext 1.0.0-beta.4 | 77.8 KiB | 29.2% less |
| Nextane + Octane 0.1.21 | 43.0 KiB | 60.9% less |

The README is unusually candid about its own standing, calling the project a fun experiment rather than a serious framework and pointing you at Vinext for real work. That candour is why the number is worth trusting, and worth extending.

Every row here is a framework, so the table ranks. Ranking is a weaker thing than measuring, because a measurement needs an origin and this one has none.

## Re-measuring it on the live demo

The demo is deployed, so the claim is checkable without building anything. Here is what it puts on the wire, brotli as served and gzip so it lines up with the README's axis:

| Asset | Raw | gzip | brotli |
| --- | --- | --- | --- |
| document | 2,652 | 1,247 | 1,130 |
| styles.css | 3,406 | 1,364 | 1,224 |
| index-903Z56aL.js | 8,193 | 3,336 | 2,974 |
| router-bwM-JHXE.js | 125,152 | 40,048 | 35,159 |
| **JavaScript total** | **133,345** | **43,384** | **38,133** |

43,384 bytes gzip against a claimed 43.0 KiB. The benchmark holds, which is worth saying plainly, because a page that only re-measures claims it can knock down is not measuring.

One thing to notice before moving on. The document is 2,652 bytes and the JavaScript is 133,345. The page's actual content is 2% of what the page costs.

## Where the baseline lands

Predict before you reveal. The three framework rows are drawn below. This site's homepage and its heaviest page are hidden. Guess where they fall relative to the 43.0 KiB row that won the benchmark.

Client JavaScript per page load, gzip

The homepage loads one script, `nav.js`, at 14.9 KiB gzip. That script builds the wallpaper, the draggable desktop icons, the taskbar, the clock, the Start orb, and the Run palette that filters 158 photos plus every page on the site. The heaviest page here is [/lens](https://aadhar.sh/lens) at 36.6 KiB, and it still lands under the framework row that won.

Now the complication I would rather state than bury. Every script this site serves, summed across all 43 pages, is 49.0 KiB gzip, which is *more* than Nextane's 43.0. A visitor never downloads that sum, and a Nextane visitor pays 43.0 on their first page, so per page load the gap is real and roughly 3x. As a whole-site total the comparison reverses. Both numbers are true, they answer different questions, and only the per-page one describes what a browser does.

## The chunk is the framework, not the glue

The obvious objection is that most of that 125 KB is Next.js compatibility shim, which a plain Octane app would never load. I counted identifiers in the shipped chunk rather than arguing about it:

| Identifier in `router-bwM-JHXE.js` | Occurrences |
| --- | --- |
| `effect` | 48 |
| `octane` | 34 |
| `Suspense` | 9 |
| `prefetch` | 5 |
| `router` | 1 |

The chunk is named for the router and contains almost none of one. What fills it is the reactive runtime, Suspense, and the scheduler. So 43.0 KiB sits close to Octane's own floor in this build, and stripping the Next.js surface off the top would not recover much of it.

That reading rests on one alpha build. Octane calls itself alpha software and has beta in view, so a tuned release may tree-shake considerably further. Treat the number as current rather than settled.

## What the comparison actually measures

Here is where I argue against my own table. A framework competes with the version of your application you would otherwise hand-write and then maintain for years, which is a different opponent from a hand-written document. Octane's 43 KiB buys a component model, hydration, Suspense, and a compiler that tracks what your code reads so you stop maintaining dependency arrays. This site buys none of that because it needs none of it. It serves documents, and its interactivity is a desktop shell bolted on top of them.

So the honest reading is narrower than "frameworks are heavy." A framework's floor is set by its runtime, and this site's floor is set by how much behaviour it actually has. Those are different quantities. A benchmark containing only frameworks quietly makes them look like one quantity, and that is the thing the extra rows are for.

## Where Octane would win here

`nav.js` is the one module on this site with enough state to make the question live. It handles window dragging and resizing, taskbar state, a command palette filtering 158 photos alongside every page and six profiles, and icon positions that deliberately reset each visit. All of it is imperative DOM code, and all of it is 14.9 KiB.

The crossover is a maintenance threshold rather than a byte one. Octane's runtime alone is roughly three times what `nav.js` weighs today, so a rewrite loses on size until that module grows several times over. If it ever does, the calculation changes.

The idea underneath is worth taking even while the package is not. Octane compiles the reactivity bookkeeping away so the browser receives direct DOM updates with no virtual DOM in between. Hand-written imperative DOM code *is* that output. This site already stands where the compiler is trying to arrive, having paid in author effort rather than in runtime bytes, and that is the whole reason the framework has nothing to sell it.

## The objection I think is right

The strongest reading of this page is that it stacks the deck. I picked a document site as the zero, then reported that an application framework costs more than zero, which was never in doubt. Nobody building a dashboard can adopt this site's answer, because the answer is "have less behaviour."

I think that is fair, and it is why the middle sections exist rather than just the chart. What the extra rows buy is a scale rather than a verdict on Octane. A reader who has only ever seen framework-versus-framework tables can rank three options and still have no idea whether the winner is close to the metal or a long way from it. Now there is a distance on the axis, and 43.0 KiB reads as a genuine achievement against React and a large number against nothing at all. Both readings survive, and holding them together is the point.

What would change my mind: a tuned, non-alpha Octane build landing anywhere near `nav.js`'s 14.9 KiB. That would mean the runtime cost measured here is a property of an early build rather than of the architecture, and the crossover argument above would collapse with it. The beta is where that shows up.

shipped · the understanding check is part of the page, not a gate

Source: https://aadhar.sh/garage/octane
