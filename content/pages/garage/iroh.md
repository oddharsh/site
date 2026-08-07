---
title: "aadhar.sh/garage/iroh"
description: "iroh hit 1.0: dial a machine by its public key, not its IP. A garage look at the P2P library, a native in-browser NodeId generator you can run, and an honest verdict on why a megabyte of wasm does not ride a lean static site."
path: "/garage/iroh"
section: "garage"
kind: "content"
updated: "2026-06-15"
source: "https://aadhar.sh/garage/iroh"
---

# Dial by key

iroh hit 1.0. It is a networking library where you reach another machine by its public key, not its IP address: a 32-byte ed25519 identity that stays put while the network under it changes, with QUIC hole-punching for a direct encrypted link and a relay only as a fallback. I went looking for a way to use it here. This is where I landed, plus a small piece of it you can run right now.

## The core idea, natively

An iroh `NodeId` is just an ed25519 public key, printed in base32. You do not dial `203.0.113.7`; you dial the key, and iroh finds a path to it. The browser can mint that identity with no library at all. Press the button: it generates a real key with the Web Crypto API (a true ed25519 keypair where your browser supports it, a 256-bit random identity where it does not), then encodes the public half the way iroh prints a NodeId.

NodeId · base32 · what iroh dials

the same key, in hex

**That string is the address.** A real iroh ticket wraps this NodeId with a relay URL and any known direct addresses, postcard-serialized, so a peer can start dialing before discovery even finishes. Nothing left your machine to make this.

## Can it live on this site?

Short version: not without weighing the place down, so it does not. The honest reasons:

- **It needs a build this site does not have.** There is no drop-in browser package for iroh. You write a small Rust wrapper crate and compile it with `wasm-bindgen` (the `wasm32-unknown-unknown` target, then a release build whose stated job is to *shrink the wasm*). aadhar.sh has no build step on purpose. Every page is hand-written and inlined.
- **The payload is a megabyte-class wasm blob.** The whole bet here is the opposite: pages around 20KB brotli, zero font bytes, nothing loaded that the page does not use. A multi-MB binary, even lazy-loaded on one page, is the wrong shape for it.
- **It wants infrastructure the edge cannot host.** Browser endpoints cannot hole-punch on their own, so they lean on a relay. Cloudflare Workers are request-and-response with no long-lived QUIC socket, so the site cannot be its own relay. You would borrow iroh's public one or stand up a box elsewhere.
- **There is no second peer.** A personal homepage is one-to-many: you read it, the photos come from a CDN, which is exactly what a CDN is for. P2P shines when two devices talk to each other, not when a thousand readers fetch the same gallery.

So iroh stays a library I admire from across the room. It is the right tool the day this becomes something genuinely peer-to-peer (a "beam this photo straight to your phone, no server in the middle" trick, or a private channel between two of my own machines) and the wrong tool for a lean content site. The garage rule holds: an experiment that would make every *other* page heavier does not get to ship. This page is plain HTML and a few lines of native crypto. It loads nothing iroh, and it changed nothing about how the rest of the site is served.

[← back to the garage](https://aadhar.sh/garage)

Source: https://aadhar.sh/garage/iroh
