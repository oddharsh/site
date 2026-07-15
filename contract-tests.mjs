#!/usr/bin/env node
// contract-tests.mjs — representation-boundary tests for the homepage Worker.
//
// These are deliberately dependency-free and deterministic. They test the
// public shape of the page/fragment and JSON/HTML handlers without starting a
// local Worker or making third-party network requests. verify-routes.mjs adds
// the same assertions against a deployed or local HTTP surface.

import assert from "node:assert/strict";
import test from "node:test";

import {
  handleLensFetch,
  handleLensFragment,
  renderLensFragments,
  renderLensShell,
} from "./holding/_worker.js/lens.js";
import {
  handleRnTracks,
  handleRnTracksHtml,
  renderTrackListHtml,
} from "./holding/_worker.js/rn.js";

const PLAYLIST_ID = "4IRq9W1N2tOWHhH0O3vXiF";
const TRACKS = {
  playlist_id: PLAYLIST_ID,
  playlist_name: "rn",
  tracks: [{
    id: "track-1",
    title: "A <song>",
    artists_text: "An Artist",
    artists: [{
      id: "artist-1",
      name: "An Artist",
      spotify_url: "https://open.spotify.com/artist/artist-1",
      image_url: null,
    }],
    song_link_url: "https://song.link/s/track-1",
    duration_ms: 65000,
    image_url: null,
    is_explicit: false,
  }],
};

function context() {
  return { waitUntil() {} };
}

function kvForTracks() {
  return {
    async get(key, type) {
      if (key === "playlist-id") return PLAYLIST_ID;
      if (key === `tracks:${PLAYLIST_ID}`) return type === "json" ? TRACKS : JSON.stringify(TRACKS);
      if (key === `tracks:${PLAYLIST_ID}:fresh`) return "1";
      return null;
    },
  };
}

function assertFullDocument(html) {
  assert.match(html, /^<!DOCTYPE html>/i);
  assert.match(html, /<html\b/i);
  assert.match(html, /<head\b/i);
  assert.match(html, /<body\b/i);
  assert.match(html, /<\/html>/i);
  assert.doesNotMatch(html, /id="lx-fragments"/);
}

function assertFragment(html) {
  assert.match(html, /id="lx-fragments"/);
  assert.doesNotMatch(html, /<(?:!doctype|html|head|body)\b/i);
}

test("Lens shell is a complete document, not a fragment", () => {
  const response = renderLensShell();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /^text\/html/);
  return response.text().then(assertFullDocument);
});

test("Lens fragment renderer stays partial and carries its hydration marker", () => {
  const html = renderLensFragments(
    { ok: false, error: "invalid target" },
    { view: "both", lens: "readiness", counterfactuals: {} },
  );
  assertFragment(html);
  assert.match(html, /id="lx-initial-data"/);
});

test("track HTML renderer emits rows only", () => {
  const html = renderTrackListHtml(TRACKS);
  assert.match(html, /^<li\b/);
  assert.match(html, /np-title/);
  assert.match(html, /A &lt;song&gt;/);
  assert.doesNotMatch(html, /<(?:!doctype|html|head|body)\b/i);
});

test("track endpoints keep JSON and HTML contracts independent of Accept", async () => {
  const env = { RN_KV: kvForTracks() };
  const request = new Request("https://aadhar.sh/rn/tracks", {
    headers: { accept: "text/html" },
  });
  const json = await handleRnTracks(request, env, context());
  assert.equal(json.status, 200);
  assert.match(json.headers.get("content-type") || "", /^application\/json/);
  assert.equal(json.headers.get("vary"), null);
  assert.deepEqual(await json.json(), TRACKS);

  const html = await handleRnTracksHtml(
    new Request("https://aadhar.sh/rn/tracks.html", { headers: { accept: "application/json" } }),
    env,
    context(),
  );
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-type") || "", /^text\/html/);
  assert.equal(html.headers.get("vary"), null);
  const body = await html.text();
  assert.match(body, /^<li\b/);
  assert.doesNotMatch(body, /<(?:!doctype|html|head|body)\b/i);
});

test("Lens endpoints keep JSON and HTML contracts independent of Accept", async () => {
  const json = await handleLensFetch(
    new Request("https://aadhar.sh/lens/fetch?url=javascript%3Aalert(1)", {
      headers: { accept: "text/html" },
    }),
    {},
    context(),
  );
  assert.equal(json.status, 400);
  assert.match(json.headers.get("content-type") || "", /^application\/json/);
  assert.equal(json.headers.get("vary"), null);
  assert.equal((await json.json()).ok, false);

  const fragment = await handleLensFragment(
    new Request("https://aadhar.sh/lens/fragment?url=javascript%3Aalert(1)", {
      headers: { accept: "application/json" },
    }),
    {},
    context(),
  );
  assert.equal(fragment.status, 400);
  assert.match(fragment.headers.get("content-type") || "", /^text\/html/);
  assert.equal(fragment.headers.get("vary"), null);
  assertFragment(await fragment.text());
});
