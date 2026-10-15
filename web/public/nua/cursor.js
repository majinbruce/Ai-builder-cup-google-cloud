(function () {
  const P = ['#f2c14e', '#ef9a55', '#f26e52', '#ee8c8c', '#d8dc6a'];
  const CREAM = '#ffe7ce', INK = '#0d0d03', MONO = "'IBM Plex Mono',monospace", SANS = "'Inter Tight',sans-serif";
  const LANGS = [['HI', 'आवाज़'], ['ES', 'voz'], ['FR', 'voix'], ['JA', '声'], ['DE', 'Stimme'], ['KO', '목소리']];
  const GL = 'XS80#@+x:/<>%';
  const lerp = (a, b, t) => a + (b - a) * t, cl = (x) => Math.max(0, Math.min(1, x));
  const h = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };

  const bgCache = new WeakMap();
  function bgLight(el, stop) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor, m = c && c.match(/[\d.]+/g);
      if (m && (m.length < 4 || +m[3] > .5)) { const L = (+m[0] * .299 + +m[1] * .587 + +m[2] * .114) / 255; return L > .6 ? 1 : 0; }
      if (n === stop && stop !== document.body) break;
    }
    return 0;
  }
  const PD = ['#b8740f', '#c25a1c', '#b8432f', '#b04f5c', '#6f7a12'];
  function attach(stage, kind) {
    const G = stage === document.body;
    if (G && matchMedia('(pointer: coarse)').matches) return () => {};
    const cv = document.createElement('canvas');
    cv.style.cssText = G ? 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483600' : 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:50';
    let css = null; if (G) { css = document.createElement('style'); css.textContent = '*,*::before,*::after{cursor:none!important}'; document.head.appendChild(css); }
    if (kind === 'blend') cv.style.mixBlendMode = 'difference';
    stage.appendChild(cv);
    if (!G) { stage.style.cursor = 'none'; stage.querySelectorAll('*').forEach((e) => (e.style.cursor = 'none')); }
    const ctx = cv.getContext('2d');
    const S = { x: -99, y: -99, sx: -99, sy: -99, rx: -99, ry: -99, vx: 0, vy: 0, in: false, hov: 0, hovT: 0, hr: null, light: 0, down: 0, rip: [], trail: [], lang: 0, rot: 0, last: 0, wave: new Array(9).fill(0) };
    let W = 0, H = 0, dpr = 1, raf;
    const size = () => { dpr = Math.min(2, devicePixelRatio || 1); W = G ? innerWidth : stage.clientWidth; H = G ? innerHeight : stage.clientHeight; cv.width = W * dpr; cv.height = H * dpr; };
    size(); const ro = new ResizeObserver(size); ro.observe(stage); if (G) addEventListener('resize', size);
    const move = (e) => {
      const r = G ? { left: 0, top: 0 } : stage.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      if (!S.in) { S.sx = S.rx = x; S.sy = S.ry = y; }
      S.vx = x - S.x; S.vy = y - S.y; S.x = x; S.y = y; S.in = true;
      const t = e.target.closest && e.target.closest('button,a,[data-hover],[role=button],input,select,textarea,label,summary,[onclick]');
      S.hov = t && stage.contains(t) ? 1 : 0; S.hr = S.hov ? t.getBoundingClientRect() : null; if (S.hr) S.hr = { x: S.hr.left - r.left, y: S.hr.top - r.top, w: S.hr.width, hh: S.hr.height };
      const lt = e.target.closest && e.target.closest('[data-light]'); S.light = lt ? 1 : bgLight(e.target, stage);
      S.yield = false; for (let n = e.target; n && n !== stage && n.style; n = n.parentElement) if (n.style.cursor === 'none' || n.hasAttribute('data-own-cursor')) { S.yield = G; break; }
      if (kind === 'ascii') { const sp = Math.hypot(S.vx, S.vy); for (let k = 0; k < Math.min(3, sp / 6); k++) S.trail.push({ x: x - S.vx * k / 3, y: y - S.vy * k / 3, t: performance.now(), g: GL[(Math.random() * GL.length) | 0], c: P[(Math.random() * 5) | 0] }); }
    };
    const leave = () => { S.in = false; };
    const down = (e) => { S.down = 1; S.rip.push({ x: S.x, y: S.y, t: performance.now() }); if (kind === 'tag') S.lang = (S.lang + 1) % LANGS.length; };
    const up = () => { S.down = 0; };
    stage.addEventListener('pointermove', move); (G ? document.documentElement : stage).addEventListener('pointerleave', leave); stage.addEventListener('pointerdown', down); addEventListener('pointerup', up);

    const tick = (now) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(50, now - (S.last || now)); S.last = now;
      S.sx = lerp(S.sx, S.x, .35); S.sy = lerp(S.sy, S.y, .35); S.rx = lerp(S.rx, S.x, .14); S.ry = lerp(S.ry, S.y, .14);
      S.hovT = lerp(S.hovT, S.hov, .18); S.lightT = lerp(S.lightT || 0, S.light, .2);
      const sp = Math.hypot(S.x - S.rx, S.y - S.ry);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      const fg = S.light ? INK : CREAM;
      S.rip = S.rip.filter((r) => now - r.t < 700);
      S.rip.forEach((r) => { const a = (now - r.t) / 700; ctx.globalAlpha = 1 - a; ctx.strokeStyle = kind === 'blend' ? '#fff' : kind === 'petal' && S.light ? PD[2] : (kind === 'petal' || kind === 'wave' || kind === 'ascii' ? P[2] : fg); ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(r.x, r.y, 6 + a * 34, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1; });
      if ((!S.in || S.yield) && kind !== 'ascii') return;
      const D = DRAW[kind]; D && D(ctx, S, now, dt, fg, sp);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); cv.remove(); css && css.remove(); removeEventListener('pointerup', up); stage.removeEventListener('pointermove', move); stage.removeEventListener('pointerleave', leave); stage.removeEventListener('pointerdown', down); stage.style.cursor = ''; };
  }

  const DRAW = {};
  // creative — translation tag
  DRAW.tag = (ctx, S, now, dt, fg) => {
    const x = S.sx, y = S.sy, s = lerp(18, 26, S.hovT) * (S.down ? .85 : 1);
    ctx.strokeStyle = fg; ctx.lineWidth = 1; ctx.strokeRect(Math.round(x - s / 2) + .5, Math.round(y - s / 2) + .5, s, s);
    ctx.fillStyle = fg; ctx.fillRect(Math.round(x) - 1, Math.round(y) - 1, 2, 2);
    const L = LANGS[S.lang], age = now % 2400, word = age < 500 ? L[1].split('').map((c, i) => age / 500 > (i + 1) / (L[1].length + 1) ? c : GL[(h(i, Math.floor(now / 55)) * GL.length) | 0]).join('') : L[1];
    if (age > 2380) S.lang = (S.lang + 1) % LANGS.length;
    ctx.font = `500 9px ${MONO}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const tx = Math.round(x + s / 2 + 6), ty = Math.round(y - s / 2 + 4), lab = `EN→${L[0]}`;
    ctx.fillText(lab, tx, ty);
    ctx.font = L[0] === 'HI' ? `11px 'Tiro Devanagari Hindi',serif` : `italic 500 11px 'Newsreader',serif`; ctx.fillText(word, tx, ty + 12);
  };
  // creative — ascii trail
  DRAW.ascii = (ctx, S, now, dt, fg) => {
    S.trail = S.trail.filter((p) => now - p.t < 700);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    S.trail.forEach((p) => { const a = (now - p.t) / 700; ctx.globalAlpha = 1 - a; ctx.font = `500 ${11 - a * 4}px ${MONO}`; ctx.fillStyle = p.c; ctx.fillText(a > .4 ? '·' : p.g, p.x, p.y + a * 10); });
    ctx.globalAlpha = 1;
    if (!S.in) return;
    ctx.font = `500 ${lerp(14, 22, S.hovT)}px ${MONO}`; ctx.fillStyle = fg;
    ctx.fillText(S.hov ? '@' : S.down ? '*' : '+', S.sx, S.sy);
  };
  // creative — petal
  DRAW.petal = (ctx, S, now, dt, fg, sp) => {
    S.rot += (0.0006 + Math.min(.012, sp * .0009)) * dt;
    const R = lerp(9, 16, S.hovT) * (S.down ? .7 : 1), x = S.sx, y = S.sy;
    for (let k = 0; k < 6; k++) {
      const a = S.rot + k * Math.PI / 3, open = lerp(.55, 1, S.hovT);
      ctx.save(); ctx.translate(x, y); ctx.rotate(a);
      const lk = S.lightT || 0;
      ctx.fillStyle = lk > .5 ? INK : P[k % 5]; ctx.globalAlpha = .95;
      ctx.beginPath(); ctx.ellipse(R * .55 * open, 0, R * .55, R * .26, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1; ctx.fillStyle = (S.lightT || 0) > .5 ? INK : CREAM; ctx.beginPath(); ctx.arc(x, y, (S.lightT || 0) > .5 ? R * .42 : 2.4, 0, Math.PI * 2); ctx.fill();
  };
  // creative — live waveform
  DRAW.wave = (ctx, S, now, dt, fg, sp) => {
    const n = S.wave.length, bw = 2, g = 2, amp = cl(sp / 40) + S.hovT * .6;
    for (let k = 0; k < n; k++) { const tgt = .15 + amp * (.4 + .6 * Math.abs(Math.sin(now / 110 + k * 1.3) * Math.sin(now / 230 - k * .7))); S.wave[k] = lerp(S.wave[k], tgt, .3); }
    const tot = n * bw + (n - 1) * g, x0 = Math.round(S.sx - tot / 2);
    for (let k = 0; k < n; k++) { const hh = Math.max(2, S.wave[k] * 26); ctx.fillStyle = S.hovT > .5 ? P[Math.floor(k / n * 5)] : fg; ctx.fillRect(x0 + k * (bw + g), Math.round(S.sy - hh / 2), bw, hh); }
  };
  // simple — dot and lagging ring
  DRAW.ring = (ctx, S, now, dt, fg) => {
    ctx.fillStyle = fg; ctx.beginPath(); ctx.arc(S.x, S.y, S.down ? 2 : 2.6, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = fg; ctx.lineWidth = 1; ctx.globalAlpha = lerp(.55, 1, S.hovT);
    ctx.beginPath(); ctx.arc(S.rx, S.ry, lerp(16, 30, S.hovT), 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
  };
  // simple — corner square that frames buttons
  DRAW.square = (ctx, S, now, dt, fg) => {
    const k = S.hovT, r = S.hr;
    if (r && k > .02) {
      const pad = 5, x0 = lerp(S.sx - 3.5, r.x - pad, k), y0 = lerp(S.sy - 3.5, r.y - pad, k), x1 = lerp(S.sx + 3.5, r.x + r.w + pad, k), y1 = lerp(S.sy + 3.5, r.y + r.hh + pad, k);
      ctx.fillStyle = fg; [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].forEach(([a, b]) => ctx.fillRect(Math.round(a) - 3, Math.round(b) - 3, 7, 7));
    } else { ctx.fillStyle = fg; ctx.fillRect(Math.round(S.sx) - 3.5, Math.round(S.sy) - 3.5, 7, 7); }
  };
  // simple — fine crosshair
  DRAW.cross = (ctx, S, now, dt, fg) => {
    const x = Math.round(S.sx) + .5, y = Math.round(S.sy) + .5, L = lerp(9, 6, S.hovT), gap = lerp(3, 7, S.hovT);
    ctx.strokeStyle = fg; ctx.lineWidth = 1; ctx.beginPath();
    ctx.moveTo(x - gap - L, y); ctx.lineTo(x - gap, y); ctx.moveTo(x + gap, y); ctx.lineTo(x + gap + L, y);
    ctx.moveTo(x, y - gap - L); ctx.lineTo(x, y - gap); ctx.moveTo(x, y + gap); ctx.lineTo(x, y + gap + L); ctx.stroke();
    if (S.hovT > .3) { ctx.globalAlpha = S.hovT; ctx.strokeRect(x - gap, y - gap, gap * 2, gap * 2); ctx.globalAlpha = 1; }
  };
  // simple — inverting disc
  DRAW.blend = (ctx, S) => {
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(S.sx, S.sy, lerp(9, 34, S.hovT) * (S.down ? .8 : 1), 0, Math.PI * 2); ctx.fill();
  };

  window.NuaCursor = { attach, site(kind) { if (window.__nuaCursorOn) return; window.__nuaCursorOn = true; const go = () => document.body ? attach(document.body, kind || 'petal') : setTimeout(go, 30); go(); } };
})();
