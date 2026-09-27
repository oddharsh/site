function initWhenNear(id, fn, margin) {
  var target = document.getElementById(id);
  if (!target || !("IntersectionObserver" in window)) { fn(); return; }
  var observer = new IntersectionObserver(function(entries) {
    if (!entries.some(function(entry) { return entry.isIntersecting; })) return;
    observer.disconnect(); fn();
  }, { root: target.closest(".content"), rootMargin: (margin == null ? 300 : margin) + "px 0px" });
  observer.observe(target);
}

initWhenNear("demo-bpp", function(){var PX=400*266,body=document.getElementById('bpp-body');if(!body)return;var rows=[{k:'PNG',f:'lossless',u:'/garage/enc/c-png.png'},{k:'JPEG',f:'baseline q82',u:'/garage/enc/c-sips82.jpg'},{k:'jpegli',f:'q82',u:'/garage/enc/c-jl82.jpg'},{k:'zenjpeg',f:'q84 · shipped',u:'/garage/enc/c-zc84.jpg'},{k:'WebP',f:'q80',u:'/garage/enc/c-wp80.webp'},{k:'AVIF',f:'q63',u:'/garage/enc/c-av63.avif'}];void Promise.all(rows.map(function(r){return fetch(r.u+'?v=2').then(function(x){return x.blob()}).then(function(b){r.bytes=b.size;return r}).catch(function(){r.bytes=null;return r})})).then(function(rs){var png=(rs[0].bytes)||1;var lossy=rs.slice(1).map(function(r){return r.bytes}).filter(function(n){return n!=null});var min=lossy.length?Math.min.apply(null,lossy):0;body.innerHTML=rs.map(function(r){if(r.bytes==null)return'';var kb=(r.bytes/1024).toFixed(1),bpp=(r.bytes/PX).toFixed(2),pct=Math.round(r.bytes/png*100);var w=(r.bytes===min)?' class="win"':'';return'<tr'+w+'><td><b>'+r.k+'</b> <span class="dim">'+r.f+'</span></td><td class="mono">'+kb+' KB</td><td class="mono">'+bpp+'</td><td class="mono">'+pct+'%</td></tr>'}).join('')})}, 100);

// ── Demo: chroma subsampling (4:4:4 vs 4:2:2 vs 4:2:0) ────────────────
// The eye resolves brightness (luma) far better than color (chroma), so codecs
// store chroma at lower resolution. This renders a test card with fine LUMA
// detail (black/white) and fine CHROMA detail (red/green) at the same spatial
// frequency, converts to YCbCr, subsamples the chroma planes, and converts back.
// The luma detail stays crisp at every mode; the chroma detail blurs, for a
// large drop in stored samples that you can barely see.
initWhenNear("csCanvas", function(){
  var c = /** @type {HTMLCanvasElement | null} */ (document.getElementById('csCanvas')); if (!c) return;
  var ctx = c.getContext('2d');
  var sel = /** @type {HTMLSelectElement | null} */ (document.getElementById('csMode')), info = document.getElementById('csInfo');
  var W = c.width, H = c.height;
  // build the source test card once
  var src = ctx.createImageData(W, H), s = src.data;
  function set(x, y, r, g, b) { var i = (y * W + x) * 4; s[i] = r; s[i + 1] = g; s[i + 2] = b; s[i + 3] = 255; }
  for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
    var topHalf = y < H / 2, stripe = x & 1; // 1px stripes, so 2x2 chroma blocks straddle color edges
    if (topHalf) { var v = stripe ? 245 : 20; set(x, y, v, v, v); }            // luma detail: black/white
    else { stripe ? set(x, y, 220, 55, 55) : set(x, y, 45, 155, 80); }          // chroma detail: red/green (near-equal luma)
  }
  function rgb2y(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }
  function rgb2cb(r, g, b) { return -0.168736 * r - 0.331264 * g + 0.5 * b + 128; }
  function rgb2cr(r, g, b) { return 0.5 * r - 0.418688 * g - 0.081312 * b + 128; }
  function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }
  function render() {
    var mode = sel ? sel.value : "420";
    var bx = mode === "444" ? 1 : 2, by = mode === "420" ? 2 : 1; // chroma block size
    var Y = new Float32Array(W * H), Cb = new Float32Array(W * H), Cr = new Float32Array(W * H);
    for (var i = 0; i < W * H; i++) { var r = s[i * 4], g = s[i * 4 + 1], b = s[i * 4 + 2]; Y[i] = rgb2y(r, g, b); Cb[i] = rgb2cb(r, g, b); Cr[i] = rgb2cr(r, g, b); }
    // box-average chroma over bx-by blocks, then upsample by copying the block average
    for (var yy = 0; yy < H; yy += by) for (var xx = 0; xx < W; xx += bx) {
      var sb = 0, sr = 0, n = 0;
      for (var dy = 0; dy < by && yy + dy < H; dy++) for (var dx = 0; dx < bx && xx + dx < W; dx++) { var k = (yy + dy) * W + (xx + dx); sb += Cb[k]; sr += Cr[k]; n++; }
      var ab = sb / n, ar = sr / n;
      for (var dy2 = 0; dy2 < by && yy + dy2 < H; dy2++) for (var dx2 = 0; dx2 < bx && xx + dx2 < W; dx2++) { var k2 = (yy + dy2) * W + (xx + dx2); Cb[k2] = ab; Cr[k2] = ar; }
    }
    var out = ctx.createImageData(W, H), o = out.data;
    for (var j = 0; j < W * H; j++) {
      var yv = Y[j], cb = Cb[j] - 128, cr = Cr[j] - 128;
      o[j * 4] = clamp(yv + 1.402 * cr); o[j * 4 + 1] = clamp(yv - 0.344136 * cb - 0.714136 * cr); o[j * 4 + 2] = clamp(yv + 1.772 * cb); o[j * 4 + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);
    var pct = mode === "444" ? 100 : mode === "422" ? 67 : 50;
    if (info) info.textContent = (mode === "444" ? "4:4:4 full color" : mode === "422" ? "4:2:2 chroma halved horizontally" : "4:2:0 chroma quartered") + " · " + pct + "% of the raw samples";
  }
  if (sel) sel.addEventListener("change", render);
  render();
});

// ── Demo: chroma through a downscale (why a 4:2:2 camera earns a 4:4:4 tile) ──
// The camera stores one color sample per 2x1 pixels (4:2:2). Shrinking the
// frame by f makes each tile pixel an average of an f-by-f patch, which holds
// f/2 color samples across and f down. Past 2x every tile pixel has color
// measured for it alone, so the tile carries full color at its own size, and
// 4:2:0 is the step that averages it back down to one sample per 2x2 block.
// The dots are the camera's color samples; each cell is one tile pixel,
// filled with the average of the samples inside it (nearest one when none).
initWhenNear("crCanvas", function(){
  var el = /** @type {HTMLCanvasElement | null} */ (document.getElementById('crCanvas')); if (!el) return;
  var ctx2d = el.getContext('2d'); if (!ctx2d) return;
  // non-null aliases: var narrowing does not reach the render closure
  var c = /** @type {HTMLCanvasElement} */ (el), ctx = /** @type {CanvasRenderingContext2D} */ (ctx2d);
  var rng = /** @type {HTMLInputElement | null} */ (document.getElementById('crScale'));
  var sel = /** @type {HTMLSelectElement | null} */ (document.getElementById('crMode'));
  var outF = document.getElementById('crF'), info = document.getElementById('crInfo');
  var COLS = 8, ROWS = 4, CELL = Math.floor(Math.min(c.width / COLS, c.height / ROWS));
  var X0 = Math.floor((c.width - COLS * CELL) / 2), Y0 = Math.floor((c.height - ROWS * CELL) / 2);
  // a pure-chroma field in tile-pixel units: Cr flips every column, Cb every
  // row, luma held flat, so the only detail in the picture is color detail
  // at exactly one tile pixel, the finest a 4:4:4 tile can hold
  // A camera sample is an AREA average over its footprint (w wide, h tall in
  // tile pixels), which for a sine is the sine times a sinc factor. At 1x the
  // footprint is two columns wide and the column-by-column Cr cancels to zero:
  // 4:2:2 genuinely cannot record color that flips every pixel.
  function sinc(w) { var a = Math.PI * w / 2; return a < 1e-6 ? 1 : Math.sin(a) / a; }
  function field(u, v, w, h) { return { cb: 34 * sinc(h) * Math.sin(Math.PI * v), cr: 58 * sinc(w) * Math.sin(Math.PI * u) }; }
  function rgb(cb, cr) {
    function k(x) { return Math.round(x < 0 ? 0 : x > 255 ? 255 : x); }
    var y = 150; return "rgb(" + k(y + 1.402 * cr) + "," + k(y - 0.344136 * cb - 0.714136 * cr) + "," + k(y + 1.772 * cb) + ")";
  }
  function render() {
    var f = rng ? parseFloat(rng.value) : 8.6, mode = sel ? sel.value : "444";
    // camera color samples, in tile-pixel units: 2 camera pixels wide, 1 tall
    var sx = 2 / f, sy = 1 / f, pts = [];
    for (var y = sy / 2; y < ROWS; y += sy) for (var x = sx / 2; x < COLS; x += sx) {
      var fv = field(x, y, sx, sy); pts.push({ x: x, y: y, cb: fv.cb, cr: fv.cr });
    }
    var cells = [];
    for (var j = 0; j < ROWS; j++) for (var i = 0; i < COLS; i++) {
      var cb = 0, cr = 0, n = 0, best = pts[0], bd = Infinity;
      for (var p = 0; p < pts.length; p++) {
        var q = pts[p];
        if (q.x >= i && q.x < i + 1 && q.y >= j && q.y < j + 1) { cb += q.cb; cr += q.cr; n++; }
        var d = Math.abs(q.x - i - 0.5) + Math.abs(q.y - j - 0.5); if (d < bd) { bd = d; best = q; }
      }
      cells.push(n ? { cb: cb / n, cr: cr / n } : { cb: best.cb, cr: best.cr });
    }
    if (mode === "420") {
      // the tile stored at 4:2:0: one color per 2x2 block of tile pixels
      for (var bj = 0; bj < ROWS; bj += 2) for (var bi = 0; bi < COLS; bi += 2) {
        var ab = 0, ar = 0, m = 0, idx = [];
        for (var dj = 0; dj < 2 && bj + dj < ROWS; dj++) for (var di = 0; di < 2 && bi + di < COLS; di++) { var t = (bj + dj) * COLS + bi + di; idx.push(t); ab += cells[t].cb; ar += cells[t].cr; m++; }
        for (var z = 0; z < idx.length; z++) cells[idx[z]] = { cb: ab / m, cr: ar / m };
      }
    }
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    for (var r = 0; r < ROWS; r++) for (var s = 0; s < COLS; s++) {
      var cc = cells[r * COLS + s]; ctx.fillStyle = rgb(cc.cb, cc.cr); ctx.fillRect(X0 + s * CELL, Y0 + r * CELL, CELL, CELL);
    }
    // camera samples as small outlined dots, so they read as a count
    var rad = Math.max(1.2, Math.min(4, CELL * Math.min(sx, sy) * 0.28));
    ctx.lineWidth = 1; ctx.strokeStyle = "rgba(20,30,50,.55)";
    for (var p2 = 0; p2 < pts.length; p2++) {
      var pt = pts[p2]; ctx.beginPath(); ctx.arc(X0 + pt.x * CELL, Y0 + pt.y * CELL, rad, 0, 2 * Math.PI);
      ctx.fillStyle = rgb(pt.cb, pt.cr); ctx.fill(); ctx.stroke();
    }
    // tile-pixel grid, with the 4:2:0 blocks drawn heavier when they apply
    ctx.strokeStyle = "rgba(255,255,255,.9)";
    for (var gx = 0; gx <= COLS; gx++) { ctx.lineWidth = mode === "420" && gx % 2 === 0 ? 3 : 1; ctx.beginPath(); ctx.moveTo(X0 + gx * CELL, Y0); ctx.lineTo(X0 + gx * CELL, Y0 + ROWS * CELL); ctx.stroke(); }
    for (var gy = 0; gy <= ROWS; gy++) { ctx.lineWidth = mode === "420" && gy % 2 === 0 ? 3 : 1; ctx.beginPath(); ctx.moveTo(X0, Y0 + gy * CELL); ctx.lineTo(X0 + COLS * CELL, Y0 + gy * CELL); ctx.stroke(); }
    var across = f / 2, down = f;
    if (outF) outF.textContent = f.toFixed(1) + "x";
    if (info) {
      var per = across.toFixed(1) + " across × " + down.toFixed(1) + " down";
      info.textContent = across < 1
        ? "each tile pixel gets " + per + ": neighbors still share one camera sample, so 4:4:4 would store copies"
        : mode === "420"
          ? "each tile pixel gets " + per + ", then 4:2:0 averages every 2x2 block back to one color"
          : "each tile pixel gets " + per + ": its color was measured for it alone, and 4:4:4 keeps all of it";
    }
  }
  if (rng) rng.addEventListener("input", render);
  if (sel) sel.addEventListener("change", render);
  render();
});

// live byte sizes for the zoomed comparison grids
['demo-fmtgrid','demo-encgrid','demo-chromagrid'].forEach(function(id){initWhenNear(id,function(){var root=document.getElementById(id),ns=root?root.querySelectorAll('[data-zsize]'):[];for(var i=0;i<ns.length;i++){(function(n){void fetch(n.getAttribute('data-zsize')).then(function(r){return r.blob();}).then(function(b){n.textContent=(b.size/1024).toFixed(1)+' KB';}).catch(function(){n.textContent='';});})(ns[i]);}})});

// ── Demo: progressive JPEG, the same coefficients in a different order ──
// Each pane holds a JPEG whose bytes are cut at the slider and closed with an
// EOI marker, then handed to the browser's own decoder (createImageBitmap on a
// blob, which the page CSP's img-src never sees because nothing is fetched), so
// what you see is what this browser paints from that many bytes. The scan table is read
// out of the file itself: every SOS header names its channels (Y, Cb, Cr), its
// band of the 64 DCT coefficients (Ss..Se) and its bit precision (Ah/Al).
/** @typedef {{at:number,data:number,end:number,comps:string[],ss:number,se:number,ah:number,al:number}} Scan */
/** @param {Uint8Array} b */
function jpegScans(b) {
  /** @type {Record<number,string>} */
  const names = {};
  /** @type {Scan[]} */
  const scans = [];
  let i = 2, nc = 0;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xd9) break;
    // stuffed 0xFF00, fill bytes and restart markers sit inside entropy data
    if (m === 0xff || m === 0 || (m >= 0xd0 && m <= 0xd7)) { i++; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (m >= 0xc0 && m <= 0xc2) {
      nc = b[i + 9];
      for (let k = 0; k < nc; k++) names[b[i + 10 + k * 3]] = nc === 1 ? "Y" : ["Y", "Cb", "Cr"][k];
    }
    if (m === 0xda) {
      const ns = b[i + 4], comps = [];
      for (let k = 0; k < ns; k++) comps.push(names[b[i + 5 + k * 2]]);
      const p = i + 5 + ns * 2;
      scans.push({ at: i, data: i + 2 + len, end: b.length, comps, ss: b[p], se: b[p + 1], ah: b[p + 2] >> 4, al: b[p + 2] & 15 });
    }
    i += 2 + len;
  }
  for (let k = 0; k + 1 < scans.length; k++) scans[k].end = scans[k + 1].at;
  // the scan that brings the last channel in: Chrome paints nothing until the
  // first data byte of this one (measured, and it is exact to the byte)
  const seen = new Set();
  let gate = -1;
  for (let k = 0; k < scans.length && gate < 0; k++) {
    scans[k].comps.forEach(function (c) { seen.add(c); });
    if (seen.size === nc) gate = k;
  }
  return { scans, gate };
}
/** @param {Scan} s */
function scanLabel(s) {
  let t = s.ss === 0 ? "DC (block averages)" : "AC " + s.ss + "–" + s.se;
  if (s.ah === 0 && s.al > 0) t += ", top bits only";
  else if (s.ah > 0) t += ", refines bit " + s.al;
  return t;
}
/** @param {string} id */
function progressiveDemo(id) {
  const root = document.getElementById(id);
  if (!root) return;
  const panes = Array.from(root.querySelectorAll("[data-pj-src]"));
  const rangeQ = /** @type {HTMLInputElement | null} */ (root.querySelector("input[type=range]"));
  const outQ = root.querySelector("output");
  const pickQ = /** @type {HTMLSelectElement | null} */ (root.querySelector("select"));
  const bodyQ = root.querySelector("tbody");
  if (!rangeQ || !outQ || !pickQ || !bodyQ || !panes.length) return;
  // rebound after the guard: the checker drops the narrowing inside the callbacks below
  const range = rangeQ, out = outQ, pick = pickQ, body = bodyQ;
  void Promise.all(panes.map(function (p) {
    return fetch(p.getAttribute("data-pj-src") || "").then(function (r) { return r.arrayBuffer(); }).then(function (a) { return new Uint8Array(a); });
  })).then(function (files) {
    const info = files.map(jpegScans);
    const max = Math.max.apply(null, files.map(function (f) { return f.length; }));
    // a decode can resolve after a newer one, so each pane keeps its latest ticket
    const ticket = panes.map(function () { return 0; });
    range.max = String(max);
    range.value = String(Math.round(max * 0.3));
    panes.forEach(function (p, k) {
      const sz = p.querySelector("[data-pj-size]");
      if (sz) sz.textContent = files[k].length.toLocaleString("en-US") + " B";
    });
    let queued = false;
    function paint() {
      queued = false;
      const n = Number(range.value);
      out.textContent = (n / 1024).toFixed(1) + " KB arrived (" + Math.round(n / max * 100) + "%)";
      panes.forEach(function (p, k) {
        const f = files[k], cut = Math.min(n, f.length), sc = info[k].scans;
        const cv = /** @type {HTMLCanvasElement | null} */ (p.querySelector("canvas")), state = p.querySelector("[data-pj-state]");
        const ctx = cv && cv.getContext("2d");
        if (!cv || !ctx) return;
        const whole = sc.filter(function (s) { return s.end <= cut; }).length;
        if (state) state.textContent = cut >= f.length ? "complete" : whole + " of " + sc.length + (sc.length === 1 ? " scan" : " scans") + " whole";
        let bytes = f;
        if (cut < f.length) { bytes = new Uint8Array(cut + 2); bytes.set(f.subarray(0, cut)); bytes[cut] = 0xff; bytes[cut + 1] = 0xd9; }
        const t = ++ticket[k];
        createImageBitmap(new Blob([bytes], { type: "image/jpeg" })).then(function (bm) {
          if (t === ticket[k]) { ctx.drawImage(bm, 0, 0, cv.width, cv.height); p.classList.remove("pj-none"); }
          bm.close();
        }, function () { if (t === ticket[k]) p.classList.add("pj-none"); });
      });
      table();
    }
    function table() {
      const k = Number(pick.value), sc = info[k].scans, n = Math.min(Number(range.value), files[k].length);
      body.textContent = "";
      sc.forEach(function (s, j) {
        const tr = document.createElement("tr");
        tr.className = n >= s.end ? "pj-done" : n > s.data ? "pj-part" : "pj-wait";
        if (j === info[k].gate && sc.length > 1) tr.className += " pj-gate";
        [String(j + 1), s.comps.join(" "), scanLabel(s), Math.round(s.at / files[k].length * 100) + "%"].forEach(function (t) {
          const td = document.createElement("td");
          td.textContent = t;
          tr.appendChild(td);
        });
        body.appendChild(tr);
      });
    }
    function schedule() { if (!queued) { queued = true; requestAnimationFrame(paint); } }
    range.addEventListener("input", schedule);
    pick.addEventListener("change", table);
    root.querySelectorAll("[data-pj-step]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const dir = Number(btn.getAttribute("data-pj-step")), n = Number(range.value);
        const k = Number(pick.value), f = files[k];
        // the byte where each scan is whole, plus the start of the next scan's data
        const stops = info[k].scans.map(function (s) { return s.end; }).concat([f.length]);
        const next = dir > 0 ? stops.filter(function (s) { return s > n; })[0] : stops.filter(function (s) { return s < n; }).pop();
        range.value = String(next == null ? (dir > 0 ? max : 0) : next);
        paint();
      });
    });
    root.querySelectorAll("[data-pj-jump]").forEach(function (btn) {
      btn.addEventListener("click", function () { range.value = btn.getAttribute("data-pj-jump") || "0"; paint(); });
    });
    paint();
  }).catch(function () { root.classList.add("pj-failed"); });
}

initWhenNear("demo-progressive", function () { progressiveDemo("pj-lwe"); });
