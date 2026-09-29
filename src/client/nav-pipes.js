// nav-pipes.js — the 3D Pipes screen saver (sspipes.scr), as an idle island.
//
// nav.js owns WHEN: it keeps one timestamp per input event and imports this
// module only after one quiet minute (XP defaulted to ten), or when the Run
// palette's "3D Pipes" row asks for a preview. This module owns WHAT: one
// top-layer overlay, one WebGL2 context, and the teardown when the visitor
// comes back. Nothing here loads for a visitor who never goes idle.
//
// What it keeps from the original: pipes grow cell by cell through a 3D grid,
// each one a random solid colour, turning at ball joints or elbows ("Mixed",
// chosen per pipe), and the finished screen clears in a block dissolve before
// the next round starts.
//
// What it does better, which is the point of rebuilding it:
//   • RESPONSIVE GRID. XP drew one fixed grid into whatever screen it got. Each
//     round here sizes the grid to the viewport's aspect and pixel size, so a
//     phone in portrait gets a tall, narrow volume and an ultrawide gets a long
//     one. A resize mid-round refits the camera at once, and a large aspect
//     change (a rotated phone) dissolves early so the next grid fits.
//   • TIME-BASED GROWTH. The original advanced one step per rendered frame, so
//     its speed was the speed of the machine. Here a segment takes STEP_MS of
//     wall-clock time and extrudes smoothly inside it, at whatever rate the
//     display refreshes (120 Hz panels get 120 Hz pipes).
//   • INSTANT WAKE. XP tore down a fullscreen GL window before your desktop
//     came back. The overlay here disappears on the first real input, and the
//     click that woke it is swallowed so it cannot also open a link.
//   • CHEAP. Every pipe piece is an INSTANCE of one of three meshes, so a frame
//     is three draw calls however full the screen gets, and each new piece is a
//     60-byte buffer upload.
//
// Reduced motion renders one finished frame and holds it. No WebGL2 falls back
// to XP's own "Blank" saver, a black screen, which is period-correct as well as
// safe.

var STEP_MS = 55;            // one cell of growth
var DISSOLVE_MS = 1100;      // the block wipe between rounds
var FILL = 0.55;             // share of cells claimed before a round ends
var TURN = 0.3;              // chance a pipe turns when it could go straight
var R_PIPE = 0.16;           // pipe radius, in cells
var R_BALL = 0.26;           // ball joint radius
var BEND = 1.6 * R_PIPE;     // elbow bend radius; segments trim this much at a turn
var GRACE_MS = 600;          // mouse drift ignored right after the saver starts
var DRIFT_PX = 6;            // mouse movement that counts as the visitor coming back

// XP's pipes were flat primaries under one hard light. Stored sRGB, used linear.
var PALETTE = [
  [0.90, 0.12, 0.10], [0.12, 0.72, 0.18], [0.16, 0.32, 0.95], [0.96, 0.84, 0.12],
  [0.84, 0.20, 0.84], [0.10, 0.78, 0.84], [0.96, 0.52, 0.10], [0.82, 0.82, 0.82]
].map((c) => c.map((v) => Math.pow(v, 2.2)));

var DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

var VERT = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec3 iPos;
layout(location=3) in vec3 iX;
layout(location=4) in vec3 iY;
layout(location=5) in vec3 iZ;
layout(location=6) in vec3 iCol;
uniform mat4 uViewProj;
out vec3 vN; out vec3 vW; out vec3 vCol;
void main() {
  mat3 m = mat3(iX, iY, iZ);
  vec3 w = iPos + m * aPos;
  // m scales the xy plane and z independently, and every mesh normal lies in
  // that plane or along z, so the plain matrix carries normals correctly.
  vN = m * aNrm; vW = w; vCol = iCol;
  gl_Position = uViewProj * vec4(w, 1.0);
}`;
var FRAG = `#version 300 es
precision highp float;
in vec3 vN; in vec3 vW; in vec3 vCol;
uniform vec3 uEye;
out vec4 o;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(uEye - vW);
  vec3 l = normalize(vec3(-0.45, 0.75, 0.9));
  float key = max(dot(n, l), 0.0);
  float fill = max(dot(n, normalize(vec3(0.6, -0.2, 0.5))), 0.0) * 0.18;
  float spec = pow(max(dot(n, normalize(l + v)), 0.0), 42.0) * 0.65;
  vec3 c = vCol * (0.12 + 0.8 * key + fill) + vec3(spec);
  o = vec4(pow(c, vec3(1.0 / 2.2)), 1.0);
}`;
var WIPE_VERT = `#version 300 es
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;
var WIPE_FRAG = `#version 300 es
precision highp float;
uniform float uT; uniform float uTile;
out vec4 o;
void main() {
  vec2 t = floor(gl_FragCoord.xy / uTile);
  if (fract(sin(dot(t, vec2(12.9898, 78.233))) * 43758.5453) > uT) discard;
  o = vec4(0.0, 0.0, 0.0, 1.0);
}`;

// ── meshes: interleaved position + normal, unit-sized, instanced into place ──
function mesh(verts, idx) { return { data: new Float32Array(verts), idx: new Uint16Array(idx) }; }

// radius 1, from z=0 to z=1, capped at both ends so a growing head is closed
function cylinder(S) {
  var v = [], ix = [];
  for (var z = 0; z <= 1; z++) {
    for (var s = 0; s <= S; s++) {
      var a = s / S * Math.PI * 2, c = Math.cos(a), n = Math.sin(a);
      v.push(c, n, z, c, n, 0);
    }
  }
  for (var q = 0; q < S; q++) ix.push(q, q + 1, q + S + 2, q, q + S + 2, q + S + 1);
  for (var e = 0; e <= 1; e++) {
    var base = v.length / 6, nz = e ? 1 : -1;
    v.push(0, 0, e, 0, 0, nz);
    for (var r = 0; r <= S; r++) {
      var b = r / S * Math.PI * 2;
      v.push(Math.cos(b), Math.sin(b), e, 0, 0, nz);
    }
    for (var t = 0; t < S; t++) ix.push(base, base + 1 + t, base + 2 + t);
  }
  return mesh(v, ix);
}

function sphere(lat, lon) {
  var v = [], ix = [];
  for (var i = 0; i <= lat; i++) {
    var th = i / lat * Math.PI, st = Math.sin(th), ct = Math.cos(th);
    for (var j = 0; j <= lon; j++) {
      var ph = j / lon * Math.PI * 2, x = st * Math.cos(ph), y = ct, z = st * Math.sin(ph);
      v.push(x, y, z, x, y, z);
    }
  }
  for (var a = 0; a < lat; a++) {
    for (var b = 0; b < lon; b++) {
      var p = a * (lon + 1) + b, q = p + lon + 1;
      ix.push(p, q, p + 1, p + 1, q, q + 1);
    }
  }
  return mesh(v, ix);
}

// A quarter torus in pipe-radius units. Local +x is the direction the pipe
// ARRIVES in and local +y the direction it LEAVES in; the arc runs from -x·k to
// +y·k around the joint's centre, which is exactly where the two trimmed
// straight segments stop and start.
function elbow(k, rings, S) {
  var v = [], ix = [];
  for (var i = 0; i <= rings; i++) {
    var th = i / rings * Math.PI / 2, sn = Math.sin(th), cs = Math.cos(th);
    var cx = -k + k * sn, cy = k - k * cs, rx = sn, ry = -cs;
    for (var j = 0; j <= S; j++) {
      var ph = j / S * Math.PI * 2, a = Math.cos(ph), b = Math.sin(ph);
      var nx = a * rx, ny = a * ry, nz = b;
      v.push(cx + nx, cy + ny, nz, nx, ny, nz);
    }
  }
  for (var r = 0; r < rings; r++) {
    for (var s = 0; s < S; s++) {
      var p = r * (S + 1) + s, q = p + S + 1;
      ix.push(p, q, p + 1, p + 1, q, q + 1);
    }
  }
  return mesh(v, ix);
}

/**
 * @param {{ onExit?: () => void }} [options]
 * @returns {{ stop: () => void }}
 */
export function startPipes(options) {
  var D = document;
  var onExit = (options && options.onExit) || (() => {});
  var still = matchMedia("(prefers-reduced-motion: reduce)").matches;

  var host = D.createElement("div");
  host.className = "axp-pipes";
  host.setAttribute("aria-hidden", "true");
  // The top layer puts the saver above everything, the Run <dialog> included,
  // which no z-index can do. The fixed-position styles below are the fallback
  // for an engine without popovers, and they override the popover UA sheet.
  var popover = "popover" in HTMLElement.prototype;
  if (popover) host.setAttribute("popover", "manual");
  host.style.cssText = "position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;" +
    "margin:0;padding:0;border:0;background:#000;z-index:2147483647;cursor:none;overflow:hidden;touch-action:none";
  var canvas = D.createElement("canvas");
  canvas.style.cssText = "display:block;width:100%;height:100%";
  host.appendChild(canvas);
  D.body.appendChild(host);
  if (popover) host.showPopover();

  var gl = canvas.getContext("webgl2", { antialias: true, alpha: false, powerPreference: "low-power" });
  var raf = 0, done = false, born = performance.now();
  /** @type {{ start: () => void, dispose: () => void } | null} */
  var render = null;
  // A context that fails to build a program leaves the black host in place,
  // which is the Blank saver: still a screen saver, still dismissable.
  if (gl) { try { render = scene(gl); } catch (e) { render = null; } }

  // ── wake ────────────────────────────────────────────────────────────────────
  var ox = -1, oy = -1;
  function onMove(e) {
    if (e.pointerType === "touch") return;               // a touch arrives as pointerdown
    if (performance.now() - born < GRACE_MS) { ox = e.clientX; oy = e.clientY; return; }
    if (ox < 0) { ox = e.clientX; oy = e.clientY; return; }
    if (Math.abs(e.clientX - ox) + Math.abs(e.clientY - oy) > DRIFT_PX) stop();
  }
  // A press must not reach the page: the overlay stays in place (transparent)
  // until the click that follows it has been caught, so the link under the
  // cursor never receives it. Removing the overlay on pointerdown would hand
  // pointerup, and with it the click, to whatever was underneath.
  function onDown(e) {
    e.preventDefault(); e.stopPropagation();
    if (done) return;
    halt();
    host.style.opacity = "0";
  }
  // The click is dispatched in the same task as pointerup, so a zero timeout
  // from pointerup lands after it has been swallowed. pointercancel means no
  // click is coming at all.
  function onUp(e) { e.stopPropagation(); if (done) setTimeout(teardown, 0); }
  function onClick(e) { e.preventDefault(); e.stopPropagation(); if (done) teardown(); }
  function onKey(e) { e.preventDefault(); e.stopPropagation(); stop(); }
  function onLost() { if (!done) stop(); }
  /** @type {Array<[string, (e: any) => void]>} */
  var listen = [["pointermove", onMove], ["pointerdown", onDown], ["pointerup", onUp], ["pointercancel", onUp],
    ["click", onClick], ["keydown", onKey], ["wheel", stop]];
  listen.forEach((l) => { addEventListener(l[0], l[1], { capture: true, passive: l[0] === "pointermove" || l[0] === "wheel" }); });

  function halt() {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    // dispose() loses the context on purpose, and that fires webglcontextlost;
    // `done` is already set, so onLost cannot tear the overlay down early and
    // hand the pending click to the page.
    if (render) render.dispose();
    onExit();
  }
  function teardown() {
    listen.forEach((l) => { removeEventListener(l[0], l[1], { capture: true }); });
    if (popover && host.matches(":popover-open")) host.hidePopover();
    host.remove();
  }
  function stop() { halt(); teardown(); }

  canvas.addEventListener("webglcontextlost", onLost);
  if (render) render.start();
  return { stop: stop };

  // ── the scene ───────────────────────────────────────────────────────────────
  /** @param {WebGL2RenderingContext} gl */
  function scene(gl) {
    function shader(type, src) {
      var s = gl.createShader(type);
      if (!s) throw new Error("pipes: no shader");
      gl.shaderSource(s, src); gl.compileShader(s);
      return s;
    }
    function program(vs, fs) {
      var p = gl.createProgram();
      if (!p) throw new Error("pipes: no program");
      gl.attachShader(p, shader(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("pipes: " + gl.getProgramInfoLog(p));
      return p;
    }
    var prog = program(VERT, FRAG), wipe = program(WIPE_VERT, WIPE_FRAG);
    var uViewProj = gl.getUniformLocation(prog, "uViewProj"), uEye = gl.getUniformLocation(prog, "uEye");
    var uT = gl.getUniformLocation(wipe, "uT"), uTile = gl.getUniformLocation(wipe, "uTile");
    var wipeVao = gl.createVertexArray();

    var FLOATS = 15;          // pos 3 + basis 9 + colour 3
    var kinds = [cylinder(18), sphere(10, 18), elbow(BEND / R_PIPE, 10, 18)].map((m) => {
      var vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      var vb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.bufferData(gl.ARRAY_BUFFER, m.data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      var eb = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, eb);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.idx, gl.STATIC_DRAW);
      var ib = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, ib);
      for (var a = 0; a < 5; a++) {
        gl.enableVertexAttribArray(2 + a);
        gl.vertexAttribPointer(2 + a, 3, gl.FLOAT, false, FLOATS * 4, a * 12);
        gl.vertexAttribDivisor(2 + a, 1);
      }
      gl.bindVertexArray(null);
      return { vao: vao, ib: ib, n: m.idx.length, count: 0, cap: 0, buffers: [vb, eb, ib] };
    });
    var CYL = kinds[0], BALL = kinds[1], ELBOW = kinds[2];

    // ── round state ───────────────────────────────────────────────────────────
    var X = 0, Y = 0, Z = 0, cells = new Uint8Array(0), claimed = 0, gridAspect = 1;
    /** @type {any[]} */ var pipes = [];
    var clock = 0, last = 0, wipeAt = -1, W = 1, H = 1, dpr = 1;
    var tmp = new Float32Array(FLOATS);

    function at(x, y, z) { return (z * Y + y) * X + x; }
    function inside(x, y, z) { return x >= 0 && y >= 0 && z >= 0 && x < X && y < Y && z < Z; }
    function free(c) { return inside(c[0], c[1], c[2]) && !cells[at(c[0], c[1], c[2])]; }
    function claim(c) { cells[at(c[0], c[1], c[2])] = 1; claimed++; }
    function step(c, d) { return [c[0] + DIRS[d][0], c[1] + DIRS[d][1], c[2] + DIRS[d][2]]; }
    function centre(c) { return [c[0] - (X - 1) / 2, c[1] - (Y - 1) / 2, c[2] - (Z - 1) / 2]; }
    function exits(c) {
      var out = [];
      for (var d = 0; d < 6; d++) if (free(step(c, d))) out.push(d);
      return out;
    }
    function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

    function put(kind, i, pos, bx, by, bz, col) {
      tmp.set(pos, 0); tmp.set(bx, 3); tmp.set(by, 6); tmp.set(bz, 9); tmp.set(col, 12);
      gl.bindBuffer(gl.ARRAY_BUFFER, kind.ib);
      gl.bufferSubData(gl.ARRAY_BUFFER, i * FLOATS * 4, tmp);
    }
    function add(kind, pos, bx, by, bz, col) {
      if (kind.count >= kind.cap) return -1;
      put(kind, kind.count, pos, bx, by, bz, col);
      return kind.count++;
    }
    function scale(v, s) { return [v[0] * s, v[1] * s, v[2] * s]; }
    function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
    // two unit vectors square to an axis direction d
    function sides(d) { var u = DIRS[(d + 2) % 6]; return [u, cross(DIRS[d], u)]; }
    function ball(c, col) {
      add(BALL, centre(c), [R_BALL, 0, 0], [0, R_BALL, 0], [0, 0, R_BALL], col);
    }
    function segment(p, len) {
      var s = sides(p.d);
      put(CYL, p.seg, p.from, scale(s[0], R_PIPE), scale(s[1], R_PIPE), scale(DIRS[p.d], Math.max(len, 1e-4)), p.col);
    }

    function spawn(p) {
      /** @type {number[] | null} */
      var c = null;
      for (var tries = 0; tries < 60 && !c; tries++) {
        var r = [Math.floor(Math.random() * X), Math.floor(Math.random() * Y), Math.floor(Math.random() * Z)];
        if (free(r) && exits(r).length) c = r;
      }
      if (!c) { p.dead = true; return; }
      p.col = pick(PALETTE);
      p.elbows = Math.random() < 0.5;
      p.c = c; claim(c);
      p.d = pick(exits(c)); claim(step(c, p.d));
      ball(c, p.col);
      begin(p, 0);
    }
    // Start the segment from p.c toward p.d. The move OUT of the next cell is
    // chosen now, one step ahead, because an elbow there changes where this
    // segment has to stop.
    function begin(p, trimStart) {
      var n = step(p.c, p.d), opts = exits(n), next = -1;
      if (opts.length) next = opts.indexOf(p.d) >= 0 && Math.random() > TURN ? p.d : pick(opts);
      if (next >= 0) claim(step(n, next));
      var turn = next >= 0 && next !== p.d;
      var trimEnd = turn && p.elbows ? BEND : 0;
      p.from = centre(p.c).map((v, i) => v + DIRS[p.d][i] * trimStart);
      p.full = 1 - trimStart - trimEnd;
      p.next = next; p.turn = turn; p.t0 += STEP_MS;
      p.seg = CYL.count < CYL.cap ? CYL.count++ : -1;
      if (p.seg < 0) { p.dead = true; return; }
      segment(p, 0);
    }
    function finish(p) {
      segment(p, p.full);
      var n = step(p.c, p.d);
      if (p.next < 0) { ball(n, p.col); spawn(p); return; }
      var trim = 0;
      if (p.turn) {
        if (p.elbows) {
          var a = DIRS[p.d], b = DIRS[p.next];
          add(ELBOW, centre(n), scale(a, R_PIPE), scale(b, R_PIPE), scale(cross(a, b), R_PIPE), p.col);
          trim = BEND;
        } else ball(n, p.col);
      }
      p.c = n; p.d = p.next;
      begin(p, trim);
    }
    function grow(p) {
      if (p.dead) return;
      while (!p.dead && clock - (p.t0 - STEP_MS) >= STEP_MS) finish(p);
      if (!p.dead) segment(p, p.full * Math.min(1, (clock - (p.t0 - STEP_MS)) / STEP_MS));
    }
    function over() {
      return claimed >= cells.length * FILL || pipes.every((p) => p.dead) ||
        BALL.count >= BALL.cap - 4 || ELBOW.count >= ELBOW.cap - 2;
    }

    // The grid follows the screen: cells scale with the SHORT side's pixels, the
    // long side follows the aspect, and depth matches the short side. A 390x844
    // phone gets 6x13x6, a 1440x900 laptop 11x18x11.
    function newRound() {
      var aspect = W / H, shortPx = Math.min(W, H) / dpr;
      var s = Math.max(6, Math.min(12, Math.round(shortPx / 85)));
      var l = Math.max(6, Math.min(24, Math.round(s * Math.max(aspect, 1 / aspect))));
      X = aspect >= 1 ? l : s; Y = aspect >= 1 ? s : l; Z = s;
      gridAspect = aspect;
      cells = new Uint8Array(X * Y * Z); claimed = 0;
      kinds.forEach((k) => {
        k.count = 0;
        k.cap = cells.length + 64;
        gl.bindBuffer(gl.ARRAY_BUFFER, k.ib);
        gl.bufferData(gl.ARRAY_BUFFER, k.cap * FLOATS * 4, gl.DYNAMIC_DRAW);
      });
      var n = Math.max(1, Math.min(3, Math.round(cells.length / 500)));
      pipes = [];
      for (var i = 0; i < n; i++) {
        var p = { t0: clock, dead: false };
        pipes.push(p); spawn(p);
      }
      wipeAt = -1;
    }

    function fit() {
      dpr = Math.min(devicePixelRatio || 1, 2);
      var w = Math.max(1, Math.round(host.clientWidth * dpr)), h = Math.max(1, Math.round(host.clientHeight * dpr));
      if (w === W && h === H) return false;
      W = canvas.width = w; H = canvas.height = h;
      return true;
    }

    function draw(wipeT) {
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      // Perspective fitted so the whole volume is visible (contain, never
      // cover): whichever of width or height is tighter decides the distance.
      var fov = 50 * Math.PI / 180, f = 1 / Math.tan(fov / 2), aspect = W / H;
      var dist = Z / 2 + Math.max((Y / 2 + 0.6) * f, (X / 2 + 0.6) * f / aspect);
      var near = 0.1, far = dist + Z;
      var vp = new Float32Array(16);
      vp[0] = f / aspect; vp[5] = f;
      vp[10] = (far + near) / (near - far); vp[11] = -1;
      var p14 = 2 * far * near / (near - far);
      vp[14] = -dist * vp[10] + p14; vp[15] = dist;
      gl.useProgram(prog);
      gl.uniformMatrix4fv(uViewProj, false, vp);
      gl.uniform3f(uEye, 0, 0, dist);
      kinds.forEach((k) => {
        if (!k.count) return;
        gl.bindVertexArray(k.vao);
        gl.drawElementsInstanced(gl.TRIANGLES, k.n, gl.UNSIGNED_SHORT, 0, k.count);
      });
      if (wipeT > 0) {
        gl.disable(gl.DEPTH_TEST);
        gl.useProgram(wipe);
        gl.uniform1f(uT, wipeT);
        gl.uniform1f(uTile, Math.round(Math.min(W, H) / 14));
        gl.bindVertexArray(wipeVao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.bindVertexArray(null);
    }

    function frame(now) {
      raf = requestAnimationFrame(frame);
      // The simulation clock only advances while frames arrive, and never by
      // more than 50 ms at once, so a backgrounded tab resumes mid-round rather
      // than fast-forwarding through everything it missed.
      clock += last ? Math.min(now - last, 50) : 16;
      last = now;
      var resized = fit();
      // A big aspect change (a rotated phone) ends the round early, so the
      // next grid is built for the new shape instead of letterboxed in it.
      if (resized && wipeAt < 0 && Math.abs(Math.log((W / H) / gridAspect)) > 0.35) wipeAt = clock;
      var t = 0;
      if (wipeAt >= 0) {
        t = (clock - wipeAt) / DISSOLVE_MS;
        if (t >= 1) { newRound(); t = 0; }
      } else {
        pipes.forEach(grow);
        if (over()) wipeAt = clock;
      }
      draw(t);
    }

    // Reduced motion: grow a whole round in one go, then show it and hold.
    function stillFrame() {
      fit(); newRound();
      for (var guard = 0; guard < 20000 && !over(); guard++) {
        pipes.forEach((p) => { if (!p.dead) finish(p); });
      }
      draw(0);
    }
    var ro = new ResizeObserver(() => { if (still && !done && fit()) draw(0); });

    return {
      start() {
        gl.enable(gl.DEPTH_TEST);
        ro.observe(host);
        if (still) { stillFrame(); return; }
        fit(); newRound();
        raf = requestAnimationFrame(frame);
      },
      dispose() {
        ro.disconnect();
        kinds.forEach((k) => { k.buffers.forEach((b) => gl.deleteBuffer(b)); gl.deleteVertexArray(k.vao); });
        // Hand the GPU memory back now rather than whenever the canvas is
        // collected; a screen saver is exactly the context nobody reuses.
        var lose = gl.getExtension("WEBGL_lose_context");
        if (lose) lose.loseContext();
      }
    };
  }
}
