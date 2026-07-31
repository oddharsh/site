---
title: "aadhar.sh/garage/content-addressed chunking"
description: "Live FastCDC content-defined chunking + content-addressing in the browser: pure JS + crypto.subtle. Why a one-byte edit re-sends the whole file under fixed chunks but almost nothing under content-defined ones."
path: "/garage/chunks"
section: "garage"
kind: "content"
updated: "2026-06-07"
source: "https://aadhar.sh/garage/chunks"
---

> Site index: https://aadhar.sh/llms.txt
> Section index: https://aadhar.sh/garage/llms.txt
> This is the Markdown twin of a page on aadhar.sh. The HTML at the source
> URL below is the original, and is hand-written and unminified on purpose.

# Chunking & content-addressing

How systems store and sync big files by their *content*, not their name, and why a one-byte edit re-sends the whole file under naïve chunking, but almost nothing under content-defined chunking.

---

This site already runs on content-addressing: every photo is served at a content-stable URL with a `?v=N` cache-bust, the service worker treats `/images/*` as immutable (cache-first), and the originals live in R2. That's the *idea*. The systems-grade version (chunk a file by content, address each chunk by its hash, ship only the chunks that changed, and verify a slice without the whole) is what [mkit](https://github.com/officialunofficial/mkit) does. Everything below re-creates those primitives, self-contained and dependency-free, right in your browser.

## 1 · The boundary problem

Type in the box, then hit **Snapshot as v1** to freeze the current chunks. Now edit, especially **Insert a line at the top**. Watch the two strategies diverge: under **fixed-size** chunks every boundary shifts and almost every chunk's hash changes (so you'd re-upload the whole file); under **FastCDC** the boundaries ride the content, so only the chunks near your edit change.

### Fixed-size chunks every 40 bytes: the naïve approach

### FastCDC content-defined: min 16 · avg 40 · max 120 bytes

unhashed yet / no snapshotshared with v1 (free to skip)changed (must re-send)

Snapshot, then insert at the top: that's the whole argument for content-defined chunking in one gesture.

## 2 · FastCDC, briefly

A rolling *gear hash* slides over the bytes; wherever the hash's low bits hit a target pattern, that's a chunk boundary. Because the cut points follow the *data*, inserting or deleting bytes only disturbs the boundaries you touched. The rest line up exactly as before. `min`/`max` clamp pathological sizes; "normalized" chunking tightens the mask before the average and loosens it after, so sizes cluster near the target. ~60 lines, no deps: the copy that runs this page's demos is in the source itself. View Source and find `fastcdc`.

## 3 · Big files

Content-addressing earns its keep on large blobs. Drop any file (it never leaves your machine) and your browser FastCDC-chunks it locally (avg 8 KB), then SHA-256's each chunk into a content ID. The blocks run proportional to size so you can see the variable-length cuts; the demo counts out identical chunks (a `ChunkedBlob`'s dedup win).

Drop a file here, or click to choose. Stays local.

## 4 · Delta wire format & verified slices

Once both sides address chunks by hash, sync is a set difference: the sender lists its chunk IDs, the receiver names the few it lacks, and only those bytes cross the wire: the **delta wire format**. The last piece is trust: **Bao verified slices** wrap a BLAKE3 tree so you can stream-verify *any* byte range against the root hash without fetching the whole file. `crypto.subtle` has no BLAKE3, so the demos above use SHA-256 for the content IDs; the shape of the argument is identical, and mkit uses BLAKE3 + Bao for the real thing.

On the site: this is the same instinct as the `?v=N` immutable image URLs and the cache-first service worker: identity by content, not by name. If the photo originals ever needed incremental sync to R2, content-defined chunking is how you'd ship only what changed.

Inspired by [mkit's streaming demo](https://mkit.makechain.net/streaming) and [MakeChain](https://docs.makechain.net/): a protocol for cryptographically-signed, permissionless version control.

← back to the [garage](https://aadhar.sh/garage) · [aadhar.sh](https://aadhar.sh/)

FastCDC + content-addressing re-created in pure JS + Web Crypto · concepts credit officialunofficial/mkit

Source: https://aadhar.sh/garage/chunks
