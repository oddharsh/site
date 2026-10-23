// One IIFE around the whole file: every LWE demo shares one typecheck program
// as a global script, so a top-level name here would collide with the same
// helper in another page's demo file.
(function () {
function initWhenNear(id, fn, margin?: any) {
  var target = document.getElementById(id);
  if (!target || !("IntersectionObserver" in window)) { fn(); return; }
  var observer = new IntersectionObserver(function(entries) {
    if (!entries.some(function(entry) { return entry.isIntersecting; })) return;
    observer.disconnect(); fn();
  }, { root: target.closest(".content"), rootMargin: (margin == null ? 300 : margin) + "px 0px" });
  observer.observe(target);
}

// ── The rasterizer every demo shares ───────────────────────────────────
// The page draws its own text instead of trusting the browser's, because the
// browser's text already went through the reader's OS: a Mac set to 0 and a
// Mac left at the default would show different "0" rows, and Windows would
// add ClearType. So each line is filled at S times its size, and every output
// pixel (or third of a pixel, for subpixel) averages its S*S block of
// samples. That is plain area coverage with no hinting, which is what
// macOS 27.2 draws at AppleFontSmoothing 0 (the "0" rows of the measurement
// match it: identical ink for black-on-white and white-on-black).
var work = document.createElement("canvas");
var wctx = work.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;

function raster(text, family, px, grow, sub, dx) {
  var S = 8 * sub, step = S / sub;
  wctx.font = px * S + "px " + family;
  var tw = wctx.measureText(text).width / S;
  // The width reserves the 0.6 px growth cap whatever grow is, so a line
  // drawn at 0 and the same line grown share dimensions and can be
  // compared pixel for pixel.
  var W = Math.ceil(tw + 0.6 + 3), H = Math.ceil(px * 1.4) + 2;
  work.width = W * S; work.height = H * S;
  wctx.font = px * S + "px " + family;
  // macOS puts the baseline on a whole pixel; the horizontal origin keeps
  // its fraction, so dx moves the glyphs by part of a pixel.
  var bx = (1 + (dx || 0)) * S, by = Math.round(px * 1.05) * S;
  wctx.fillStyle = "#000"; wctx.fillText(text, bx, by);
  // A stroke of width g adds g/2 to each side of every edge, so the stem
  // grows by exactly g in total: the quantity the measurement reports.
  if (grow > 0) { wctx.lineWidth = grow * S; wctx.lineJoin = "round"; wctx.strokeStyle = "#000"; wctx.strokeText(text, bx, by); }
  var d = wctx.getImageData(0, 0, W * S, H * S).data;
  var cols = W * sub, cov = new Float32Array(cols * H);
  for (var y = 0; y < H * S; y++) {
    var row = ((y / S) | 0) * cols, base = y * W * S * 4;
    for (var x = 0; x < W * S; x++) cov[row + ((x / step) | 0)] += d[base + x * 4 + 3];
  }
  var norm = 1 / (255 * step * S);
  for (var i = 0; i < cov.length; i++) cov[i] *= norm;
  return { w: W, h: H, cols: cols, cov: cov };
}

// FreeType's default LCD filter, five taps over thirds of a pixel. Without
// it, a stem edge that lights only the red third reads as a red line; the
// filter spreads each third into its neighbours until the fringe is faint.
var FIR = [8 / 256, 77 / 256, 86 / 256, 77 / 256, 8 / 256];
function lcdFilter(cov, cols, h) {
  var out = new Float32Array(cov.length);
  for (var y = 0; y < h; y++) for (var x = 0; x < cols; x++) {
    var s = 0;
    for (var k = 0; k < 5; k++) { var xx = x + k - 2; if (xx >= 0 && xx < cols) s += FIR[k] * cov[y * cols + xx]; }
    out[y * cols + x] = s;
  }
  return out;
}

// Blend in encoded sRGB, the way the measured 0 renders do: a pixel half
// covered by black text on white comes out at code 128 (or 127).
function blend(fg, bg, a) { return Math.round(bg + (fg - bg) * Math.min(1, a)); }

// The growth AppKit adds when smoothing is on, fitted to stems measured on
// macOS 27.2 (Helvetica "l", 9 to 96 pt, at 1x and 2x): it scales with
// pixels per em and stops at 0.6 px. Light text on a dark ground grows 2.75
// times faster, which is why dark mode looks heaviest on a 1x screen.
function growth(ppem, dark) { return Math.min((dark ? 0.032 : 0.0116) * ppem, 0.6); }

// ── Demo 1: the dial ───────────────────────────────────────────────────
initWhenNear("demo-dial", function() {
  var $ = function(id) { return document.getElementById(id) as any; };
  var val = $("fsVal"), fam = $("fsFont"), size = $("fsSize"), pol = $("fsPol"), sc = $("fsScale"), txt = $("fsText");
  var cv = $("fsRowV"), mv = $("fsMagV"), out = $("fsOut"), lab = $("fsValL"), labV = $("fsRowVL");
  if (!val || !cv) return;
  var NAMES = ["off", "light", "medium", "strong"];
  // The ink smoothing adds over 0 is drawn in this color in the magnifier.
  var MARK = [232, 115, 12];
  var tint = document.createElement("canvas");
  // Draws the true render at actual size and returns the largest gain any
  // pixel got, which the readout prints as the magnifier's scale.
  function draw(canvas, mag, r, base, dark, scale) {
    var fg = dark ? 255 : 0, bg = dark ? 0 : 255;
    canvas.width = r.w; canvas.height = r.h;
    canvas.style.width = r.w / scale + "px";
    var ctx = canvas.getContext("2d") as CanvasRenderingContext2D, img = ctx.createImageData(r.w, r.h);
    var Z = 7, cw = Math.min(r.w, Math.round(46 * scale)), peak = 0, i;
    for (i = 0; i < r.w * r.h; i++) {
      var v = blend(fg, bg, r.cov[i]);
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
      peak = Math.max(peak, Math.min(1, r.cov[i]) - Math.min(1, base.cov[i]));
    }
    ctx.putImageData(img, 0, 0);
    // The magnified copy is a difference map: each square shows what 0
    // drew, pulled toward orange by its gain as a fraction of the peak gain.
    // At 13 px a pixel gains about 7% of ink, which an unscaled tint shows
    // too faintly to find; scaling to the peak makes the pattern visible,
    // and the readout states the peak so the scale is never hidden.
    var tx = (tint.width = r.w, tint.height = r.h, tint.getContext("2d") as CanvasRenderingContext2D), timg = tx.createImageData(r.w, r.h);
    for (i = 0; i < r.w * r.h; i++) {
      var c0 = blend(fg, bg, base.cov[i]), t = peak > 0 ? Math.max(0, Math.min(1, r.cov[i]) - Math.min(1, base.cov[i])) / peak : 0;
      for (var k = 0; k < 3; k++) timg.data[i * 4 + k] = Math.round(c0 + (MARK[k] - c0) * t);
      timg.data[i * 4 + 3] = 255;
    }
    tx.putImageData(timg, 0, 0);
    mag.width = cw * Z; mag.height = r.h * Z;
    var mx = mag.getContext("2d");
    mx.imageSmoothingEnabled = false;
    mx.drawImage(tint, 0, 0, cw, r.h, 0, 0, cw * Z, r.h * Z);
    mx.strokeStyle = dark ? "rgba(255,255,255,.10)" : "rgba(0,0,0,.08)";
    mx.beginPath();
    for (var x = 0; x <= cw; x++) { mx.moveTo(x * Z + 0.5, 0); mx.lineTo(x * Z + 0.5, r.h * Z); }
    for (var y = 0; y <= r.h; y++) { mx.moveTo(0, y * Z + 0.5); mx.lineTo(cw * Z, y * Z + 0.5); }
    mx.stroke();
    return peak;
  }
  function ink(r) { var s = 0; for (var i = 0; i < r.cov.length; i++) s += Math.min(1, r.cov[i]); return s; }
  function render() {
    var v = +val.value, dark = pol.value === "dark", scale = +sc.value, pt = +size.value;
    var px = pt * scale, text = txt.value || "Hamburgefonstiv";
    var g = v > 0 ? growth(px, dark) : 0;
    // The 0 render is never shown on its own: it is the baseline the orange
    // in the magnifier and the ink readout are both measured against.
    var r0 = raster(text, fam.value, px, 0, 1, 0), rv = raster(text, fam.value, px, g, 1, 0);
    var peak = draw(cv, mv, rv, r0, dark, scale);
    lab.textContent = v + " (" + NAMES[v] + ")";
    labV.textContent = "AppleFontSmoothing " + v;
    var more = Math.round((ink(rv) / ink(r0) - 1) * 100);
    out.innerHTML = v === 0
      ? "<b>0:</b> plain area coverage, with no growth. Slide right to see what any other value adds."
      : "<b>" + v + ":</b> every stem grows by <span class=\"mono\">" + g.toFixed(2) + " px</span> at " + px + " pixels per em, for <span class=\"mono\">+" + more + "%</span> ink over 0. In the magnifier, full <span class=\"fs-mark\">orange</span> is the biggest gain, <span class=\"mono\">+" + Math.round(peak * 100) + "%</span> of one pixel. "
        + (v === 1 ? "Slide to 2 or 3: on macOS 27.2 they draw the same bytes as 1." : "Same bitmap as 1. The old light, medium and strong names survive only in the key's history.");
  }
  [val, fam, size, pol, sc].forEach(function(el) { el.addEventListener("input", render); });
  txt.addEventListener("input", render);
  render();
});

// ── Demo 2: one letter, three ways to fill a pixel ─────────────────────
initWhenNear("demo-grid", function() {
  var $ = function(id) { return document.getElementById(id) as any; };
  var cnv = $("pgCanvas"), mode = $("pgMode"), glyph = $("pgGlyph"), off = $("pgOff"), stripes = $("pgStripes"), out = $("pgOut"), offL = $("pgOffL");
  if (!cnv) return;
  var PX = 13, Z = 24;
  function render() {
    var m = mode.value, dx = +off.value, sub = m === "lcd" ? 3 : 1;
    var r = raster(glyph.value, "Georgia, serif", PX, 0, sub, dx);
    var cov = m === "lcd" ? lcdFilter(r.cov, r.cols, r.h) : r.cov;
    // Crop to the rows the letter touches, plus one blank row each side, so
    // the magnified grid spends its height on the glyph.
    var W = r.w, y0 = r.h, y1 = 0;
    for (var yy = 0; yy < r.h; yy++) for (var xx = 0; xx < r.cols; xx++) if (cov[yy * r.cols + xx] > 0.004) { y0 = Math.min(y0, yy); y1 = Math.max(y1, yy); }
    y0 = Math.max(0, y0 - 1); y1 = Math.min(r.h - 1, y1 + 1);
    var H = y1 - y0 + 1;
    cnv.width = W * Z; cnv.height = H * Z;
    cnv.style.width = Math.min(W * Z, 560) + "px";
    var ctx = cnv.getContext("2d");
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W * Z, H * Z);
    var colored = 0;
    for (var y = y0; y <= y1; y++) for (var x = 0; x < W; x++) {
      var rgb;
      if (m === "lcd") rgb = [0, 1, 2].map(function(k) { return blend(0, 255, cov[y * r.cols + x * 3 + k]); });
      else {
        var a = cov[y * W + x];
        var g = m === "mono" ? (a >= 0.5 ? 0 : 255) : blend(0, 255, a);
        rgb = [g, g, g];
      }
      if (Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2]) > 2) colored++;
      if (stripes.checked) {
        // What the panel physically lights: three vertical bars per pixel,
        // each at its own channel's level. Greyscale lights all three alike.
        var bw = Z / 3;
        ctx.fillStyle = "rgb(" + rgb[0] + ",0,0)"; ctx.fillRect(x * Z, (y - y0) * Z, bw - 1, Z - 1);
        ctx.fillStyle = "rgb(0," + rgb[1] + ",0)"; ctx.fillRect(x * Z + bw, (y - y0) * Z, bw - 1, Z - 1);
        ctx.fillStyle = "rgb(0,0," + rgb[2] + ")"; ctx.fillRect(x * Z + 2 * bw, (y - y0) * Z, bw - 1, Z - 1);
      } else {
        ctx.fillStyle = "rgb(" + rgb.join(",") + ")"; ctx.fillRect(x * Z, (y - y0) * Z, Z - 1, Z - 1);
      }
    }
    offL.textContent = "+" + dx.toFixed(2) + " px";
    var name = { mono: "1-bit", grey: "greyscale", lcd: "subpixel" }[m];
    out.innerHTML = "<b>" + name + "</b>, " + PX + " px Georgia: <span class=\"mono\">" + colored + "</span> of " + W * H + " pixels carry color. "
      + (m === "mono" ? "Each pixel is in or out, so the curve becomes stairs." : m === "grey" ? "Edge pixels turn grey in proportion to how much the letter covers them." : "Each third of a pixel gets its own coverage, so edges land three times more precisely. " + (stripes.checked ? "Each bar is one stripe at its own level, and the uneven bars are the color it costs." : "Tick the stripes to see the color it costs."));
  }
  [mode, glyph, off, stripes].forEach(function(el) { el.addEventListener("input", render); });
  render();
});

// ── Demo 3: one stem against the pixel grid ────────────────────────────
// A vertical stem is a rectangle, so its coverage is exact interval overlap
// and needs no sampling at all.
initWhenNear("demo-stem", function() {
  var $ = function(id) { return document.getElementById(id) as any; };
  var cnv = $("stCanvas"), pos = $("stPos"), wid = $("stW"), posL = $("stPosL"), widL = $("stWL"), out = $("stOut");
  if (!cnv) return;
  var COLS = 6, Z = 34, ROWH = 46, LABEL = 178;
  function overlap(a0, a1, b0, b1) { return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)); }
  function cover(x0, w, sub) {
    var n = COLS * sub, c = new Float32Array(n);
    for (var i = 0; i < n; i++) c[i] = overlap(x0, x0 + w, i / sub, (i + 1) / sub) * sub;
    return c;
  }
  var ROWS = [
    { name: "macOS, smoothing 0", snap: false, lcd: false, grow: 0 },
    { name: "macOS, smoothing on", snap: false, lcd: false, grow: 0.15 },
    { name: "snapped to the grid", snap: true, lcd: false, grow: 0 },
    { name: "snapped + ClearType", snap: true, lcd: true, grow: 0 },
  ];
  function render() {
    var x = 2 + +pos.value, w = +wid.value;
    cnv.width = LABEL + COLS * Z; cnv.height = ROWS.length * ROWH;
    var ctx = cnv.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cnv.width, cnv.height);
    var notes: string[] = [];
    ROWS.forEach(function(row, ri) {
      // Grid fitting, the way hinted fonts do it: the stem's width rounds to
      // whole pixels (never below one) and its left edge to a pixel boundary.
      var sx = row.snap ? Math.round(x) : x - row.grow / 2, sw = row.snap ? Math.max(1, Math.round(w)) : w + row.grow;
      var sub = row.lcd ? 3 : 1, c = cover(sx, sw, sub);
      if (row.lcd) c = lcdFilter(c, COLS * 3, 1);
      var y0 = ri * ROWH + 6, touched = 0, peak = 0;
      ctx.fillStyle = "#3c4656"; ctx.font = "11px Tahoma, Verdana, sans-serif"; ctx.textBaseline = "middle";
      ctx.fillText(row.name, 4, y0 + Z / 2);
      for (var i = 0; i < COLS; i++) {
        var rgb = sub === 3 ? [0, 1, 2].map(function(k) { return blend(0, 255, c[i * 3 + k]); }) : [blend(0, 255, c[i]), blend(0, 255, c[i]), blend(0, 255, c[i])];
        var dark = 1 - Math.min(rgb[0], rgb[1], rgb[2]) / 255;
        if (Math.min(rgb[0], rgb[1], rgb[2]) < 250) touched++;
        peak = Math.max(peak, dark);
        ctx.fillStyle = "rgb(" + rgb.join(",") + ")"; ctx.fillRect(LABEL + i * Z, y0, Z - 2, Z);
        ctx.strokeStyle = "#c7d0dc"; ctx.strokeRect(LABEL + i * Z + 0.5, y0 + 0.5, Z - 3, Z - 1);
      }
      notes.push(touched + " col" + (touched === 1 ? "" : "s") + ", darkest " + Math.round(peak * 100) + "%");
    });
    posL.textContent = "+" + (+pos.value).toFixed(2) + " px";
    widL.textContent = w.toFixed(2) + " px";
    out.innerHTML = ROWS.map(function(r, i) { return "<span class=\"st-n\">" + r.name + ":</span> <span class=\"mono\">" + notes[i] + "</span>"; }).join("<br>");
  }
  [pos, wid].forEach(function(el) { el.addEventListener("input", render); });
  render();
});

// ── Demo 4: what macOS does with a given monitor ───────────────────────
// macOS draws a HiDPI mode at twice the "looks like" size and then scales
// that framebuffer to the panel's native pixels. Only when twice the looks-
// like width equals the native width does nothing get resampled.
initWhenNear("demo-ppi", function() {
  var $ = function(id) { return document.getElementById(id) as any; };
  var pre = $("ppPreset"), mode = $("ppMode"), out = $("ppOut");
  if (!pre) return;
  // def is the mode each panel ships in, or the one most owners pick.
  var PRESETS = [
    { n: "24-inch 1920x1080", d: 24, w: 1920, h: 1080, def: "1x" },
    { n: "27-inch 2560x1440", d: 27, w: 2560, h: 1440, def: "1x" },
    { n: "27-inch 3840x2160 (4K)", d: 27, w: 3840, h: 2160, def: "2560" },
    { n: "32-inch 3840x2160 (4K)", d: 31.5, w: 3840, h: 2160, def: "2560" },
    { n: "27-inch 5120x2880 (5K)", d: 27, w: 5120, h: 2880, def: "2560" },
    { n: "32-inch 6016x3384 (6K)", d: 32, w: 6016, h: 3384, def: "3008" },
    { n: "MacBook Air 13.6-inch 2560x1664", d: 13.6, w: 2560, h: 1664, def: "1470" },
  ];
  pre.innerHTML = PRESETS.map(function(p, i) { return "<option value=\"" + i + "\"" + (i === 1 ? " selected" : "") + ">" + p.n + "</option>"; }).join("");
  function modes(p) {
    var list = [{ k: "1x", t: "native at 1x, looks like " + p.w + "x" + p.h }];
    [p.w / 2, 1470, 1920, 2304, 2560, 3008, 3200, 3360].forEach(function(lw) {
      lw = Math.round(lw);
      if (lw < p.w / 2 || lw >= p.w || list.some(function(m) { return m.k === "" + lw; })) return;
      list.push({ k: "" + lw, t: "HiDPI, looks like " + lw + "x" + Math.round(lw * p.h / p.w) });
    });
    return list;
  }
  function fillModes() {
    var p = PRESETS[+pre.value], ms = modes(p);
    mode.innerHTML = ms.map(function(m) { return "<option value=\"" + m.k + "\">" + m.t + "</option>"; }).join("");
    mode.value = p.def;
  }
  function render() {
    var p = PRESETS[+pre.value], ppi = Math.sqrt(p.w * p.w + p.h * p.h) / p.d, m = mode.value;
    var lw = m === "1x" ? p.w : +m, backing = m === "1x" ? p.w : lw * 2, factor = p.w / backing;
    var perPt = p.w / lw, stem = 0.088 * 13 * perPt;
    var rows = [
      ["pixel density", Math.round(ppi) + " PPI"],
      ["macOS draws at", m === "1x" ? p.w + "x" + p.h + " (1x)" : backing + "x" + Math.round(backing * p.h / p.w) + " (2x)"],
      ["then resamples by", factor === 1 ? "nothing, exact fit" : factor.toFixed(3)],
      ["a 13 pt Helvetica stem", stem.toFixed(2) + " panel pixels"],
    ];
    var verdict = m === "1x"
      ? (ppi < 150 ? "1x with no subpixel stripes and no hinting: every stem is a grey smear one or two pixels wide. This is where AppleFontSmoothing 0 earns its keep." : "Native at 1x on a dense panel: sharp, and very small.")
      : factor === 1 ? "Exact 2x. Text is rasterized at panel resolution and nothing resamples it afterwards. This is the case macOS is built for."
      : "Drawn at 2x, then scaled by " + factor.toFixed(3) + " to fit. Every glyph gets filtered twice, once by the rasterizer and once by the scaler.";
    out.innerHTML = "<table class=\"pp-tbl\">" + rows.map(function(r) { return "<tr><td>" + r[0] + "</td><td class=\"mono\">" + r[1] + "</td></tr>"; }).join("") + "</table><p class=\"pp-v\">" + verdict + "</p>";
  }
  pre.addEventListener("input", function() { fillModes(); render(); });
  mode.addEventListener("input", render);
  fillModes(); render();
});
})();
