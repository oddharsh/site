// photo-jxl.ts — send JPEG XL browsers to an original's lossless twin.
//
// Every full-resolution original is a JPEG in R2, and most now have a twin
// beside it: the same JPEG transcoded to JPEG XL losslessly, which rebuilds
// the exact file and is about 8% smaller (tools/photos/jxl-originals.ts). A
// link to an original carries the twin's URL in data-jxl, and this script
// moves the twin into href, but only in a browser that has just decoded a real
// JPEG XL image. Every other browser, crawler and no-JS visitor follows the
// JPEG, so the .jpg URL stays the canonical one and a saved file is named for
// the bytes it holds.
//
// WHY AT INTERACTION, NOT AT LOAD. The homepage grid arrives through an island
// fetch after its scripts run, and the contact sheet hydrates tiles as they
// scroll in, so a one-time pass over the links would miss most of them. A
// delegated listener rewrites the one link being used, just before it is
// followed: pointerdown precedes a click, a middle click and a long-press menu,
// and focusin precedes a keyboard Enter. Capturing, so a handler that stops
// propagation further down can't skip it.
//
// The probe is the 25-byte, 1px lossless JPEG XL /pixel-peeper gates its
// format axis on: onload alone isn't enough, because a browser that fails to
// decode can still fire load on a broken image, so the width has to read 1.
//
// A static `html` literal, like photos.ts's GALLERY_DEFER: it interpolates
// nothing, so it opens no unescaped door. index.html carries a byte-identical
// copy, because a static document can't import it; a contract test holds the
// two together. This module touches no Worker global, so build.ts can import
// it through photo-grid.ts.
import { html } from "./html.ts";

export const JXL_SWAP = html`<script>(()=>{const i=new Image();i.onload=()=>{if(i.naturalWidth!==1)return;const swap=e=>{const a=e.target instanceof Element&&e.target.closest("a[data-jxl]");if(a){a.href=a.dataset.jxl;a.removeAttribute("data-jxl")}};for(const t of["pointerdown","focusin","click"])addEventListener(t,swap,true)};i.src="data:image/jxl;base64,/woAEBBQXAgIAAEALABLGIsVwklBHoAAAA=="})()</script>`;

/** The URL of an original's twin, built the way photos.ts builds `full`'s. */
export const jxlUrl = (key: string) => `/images/full/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
