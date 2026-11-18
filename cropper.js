/* Bee Talk photo framing: the couple picks which part of their photo shows in the 4:3 window under their names.
   Drag to move, pinch / mouse wheel / slider to zoom. The window is always filled, so part of the photo stays out of view.
   Shared by index.html (the app) and admin.html (the couple panel). Uses the page's CSS tokens (--ink, --lav-d, --pink, --lav, --sans).

   openCropper(file, { aspect = 4 / 3, outW = 1200, labels }) -> Promise<Blob | null>   (null = cancelled)
   The result is a JPEG of outW x outW/aspect; re-encoding also drops EXIF data such as the GPS position. */
(function () {
  // ─── Constants ───
  const MAX_SRC = 2400, MAX_ZOOM = 4;
  const CSS = `
  .tt-crop{position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(30,24,40,.62);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
  .tt-crop-card{width:min(520px,100%);max-height:100%;overflow:auto;background:#fff;border-radius:26px;padding:18px 16px 16px;box-shadow:0 30px 70px -20px rgba(0,0,0,.5);font-family:var(--sans,system-ui,sans-serif);color:var(--ink,#3a3550)}
  .tt-crop-card h3{margin:0 0 4px;font:600 20px/1.2 var(--serif,Georgia,serif)}
  .tt-crop-card p{margin:0 0 12px;font-size:13px;line-height:1.45;color:#857f9c}
  .tt-crop-vp{position:relative;width:100%;aspect-ratio:var(--ar);border-radius:22px;overflow:hidden;background:#f1ecff;touch-action:none;cursor:grab;box-shadow:inset 0 0 0 4px #fff,0 6px 20px -10px rgba(109,88,201,.5)}
  .tt-crop-vp:active{cursor:grabbing}
  .tt-crop-vp canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
  .tt-crop-zoom{display:flex;align-items:center;gap:10px;margin:14px 2px 4px}
  .tt-crop-zoom span{font:800 18px/1 var(--sans,system-ui);width:22px;text-align:center;color:var(--lav-d,#6d58c9)}
  .tt-crop-zoom input{flex:1;accent-color:var(--lav-d,#6d58c9);min-height:32px}
  .tt-crop-btns{display:grid;grid-template-columns:1fr 1.4fr;gap:10px;margin-top:12px}
  .tt-crop-btns button{min-height:50px;border:0;border-radius:18px;font:800 15px var(--sans,system-ui);cursor:pointer;color:var(--ink,#3a3550)}
  .tt-crop-btns .no{background:#fff;box-shadow:inset 0 0 0 1.5px #efe7f3}
  .tt-crop-btns .ok{background:linear-gradient(135deg,var(--pink,#f7b9d0),var(--lav,#c9b8f5))}`;

  // ─── Helpers ───
  async function loadSource(file) {   // decoded, upright, at most MAX_SRC px on the long side
    let img;
    try { img = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (e) { img = await new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = no; im.src = URL.createObjectURL(file); }); }
    const w = img.width || img.naturalWidth, h = img.height || img.naturalHeight, k = Math.min(1, MAX_SRC / Math.max(w, h));
    const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ─── Component ───
  window.openCropper = async function (file, { aspect = 4 / 3, outW = 1200, labels = {} } = {}) {
    const L = { title: 'Ustaw zdjęcie', hint: 'Przesuń zdjęcie palcem. Rozsuń palce albo użyj suwaka, żeby powiększyć.', zoom: 'Powiększenie', cancel: 'Anuluj', save: 'Zapisz', ...labels };
    const src = await loadSource(file);
    if (!document.getElementById('tt-crop-css')) { const st = document.createElement('style'); st.id = 'tt-crop-css'; st.textContent = CSS; document.head.appendChild(st); }
    const root = document.createElement('div'); root.className = 'tt-crop'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', L.title);
    root.innerHTML = `<div class="tt-crop-card"><h3></h3><p></p><div class="tt-crop-vp" style="--ar:${aspect}"><canvas></canvas></div>
      <label class="tt-crop-zoom"><span aria-hidden="true">−</span><input type="range" min="1" max="${MAX_ZOOM}" step="0.01" value="1"><span aria-hidden="true">+</span></label>
      <div class="tt-crop-btns"><button type="button" class="no"></button><button type="button" class="ok"></button></div></div>`;
    root.querySelector('h3').textContent = L.title; root.querySelector('p').textContent = L.hint;
    root.querySelector('.no').textContent = L.cancel; root.querySelector('.ok').textContent = L.save;
    const range = root.querySelector('input'); range.setAttribute('aria-label', L.zoom);
    document.body.appendChild(root);
    const vp = root.querySelector('.tt-crop-vp'), cv = vp.querySelector('canvas'), ctx = cv.getContext('2d');

    // state: zoom z (1 = photo just covers the window) and the photo point shown in the middle of the window
    const st = { z: 1, cx: src.width / 2, cy: src.height / 2 };
    const view = () => { const r = vp.getBoundingClientRect(); return { w: r.width, h: r.height }; };
    const scale = (v = view()) => Math.max(v.w / src.width, v.h / src.height) * st.z;   // screen px per photo px
    function fit() {   // keep the window inside the photo
      const v = view(), s = scale(v), hw = v.w / s / 2, hh = v.h / s / 2;
      st.cx = clamp(st.cx, hw, src.width - hw); st.cy = clamp(st.cy, hh, src.height - hh);
    }
    function draw() {
      const v = view(), dpr = Math.min(2, window.devicePixelRatio || 1);
      if (cv.width !== Math.round(v.w * dpr)) { cv.width = Math.round(v.w * dpr); cv.height = Math.round(v.h * dpr); }
      fit(); const s = scale(v), sw = v.w / s, sh = v.h / s;
      ctx.drawImage(src, st.cx - sw / 2, st.cy - sh / 2, sw, sh, 0, 0, cv.width, cv.height);
      root.dataset.z = st.z.toFixed(2); root.dataset.cx = Math.round(st.cx); root.dataset.cy = Math.round(st.cy);   // state for tests
    }
    function zoomAt(z, px, py) {   // zoom keeping the photo point under (px, py) in place
      const v = view(), s0 = scale(v), ax = st.cx + (px - v.w / 2) / s0, ay = st.cy + (py - v.h / 2) / s0;
      st.z = clamp(z, 1, MAX_ZOOM); const s1 = scale(v);
      st.cx = ax - (px - v.w / 2) / s1; st.cy = ay - (py - v.h / 2) / s1;
      range.value = st.z; draw();
    }

    // ─── Listeners ───
    const pts = new Map(); let pinch = null;
    vp.addEventListener('pointerdown', e => { vp.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: st.z }; } });
    vp.addEventListener('pointermove', e => {
      const p = pts.get(e.pointerId); if (!p) return;
      const r = vp.getBoundingClientRect();
      if (pts.size === 1) { const s = scale(); st.cx -= (e.clientX - p.x) / s; st.cy -= (e.clientY - p.y) / s; pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); draw(); return; }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2 && pinch) { const [a, b] = [...pts.values()], d = Math.hypot(a.x - b.x, a.y - b.y); zoomAt(pinch.z * d / pinch.d, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top); }
    });
    const up = e => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; };
    vp.addEventListener('pointerup', up); vp.addEventListener('pointercancel', up);
    vp.addEventListener('wheel', e => { e.preventDefault(); const r = vp.getBoundingClientRect(); zoomAt(st.z * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
    range.addEventListener('input', () => { const v = view(); zoomAt(+range.value, v.w / 2, v.h / 2); });
    const onResize = () => draw(); addEventListener('resize', onResize);
    draw();

    return new Promise(resolve => {
      const done = blob => { removeEventListener('resize', onResize); removeEventListener('keydown', onKey); root.remove(); resolve(blob); };
      const onKey = e => { if (e.key === 'Escape') done(null); }; addEventListener('keydown', onKey);
      root.querySelector('.no').onclick = () => done(null);
      root.addEventListener('click', e => { if (e.target === root) done(null); });
      root.querySelector('.ok').onclick = () => {
        fit(); const v = view(), s = scale(v), sw = v.w / s, sh = v.h / s;
        const out = document.createElement('canvas'); out.width = outW; out.height = Math.round(outW / aspect);
        out.getContext('2d').drawImage(src, st.cx - sw / 2, st.cy - sh / 2, sw, sh, 0, 0, out.width, out.height);
        out.toBlob(b => done(b), 'image/jpeg', 0.86);
      };
      root.querySelector('.ok').focus();
    });
  };
})();
