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
  var c = document.getElementById('csCanvas'); if (!c) return;
  var ctx = c.getContext('2d');
  var sel = document.getElementById('csMode'), info = document.getElementById('csInfo');
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

// live byte sizes for the zoomed comparison grids
['demo-fmtgrid','demo-encgrid','demo-chromagrid'].forEach(function(id){initWhenNear(id,function(){var root=document.getElementById(id),ns=root?root.querySelectorAll('[data-zsize]'):[];for(var i=0;i<ns.length;i++){(function(n){void fetch(n.getAttribute('data-zsize')).then(function(r){return r.blob();}).then(function(b){n.textContent=(b.size/1024).toFixed(1)+' KB';}).catch(function(){n.textContent='';});})(ns[i]);}})});
