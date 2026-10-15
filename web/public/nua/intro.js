(function () {
  const P = ['#f2c14e', '#ef9a55', '#f26e52', '#ee8c8c', '#d8dc6a'];
  const INK = '#0d0d03', CREAM = '#ffe7ce';
  const L = 2600, O = 1000;
  const REVEAL_AT = { a: 2, b: 0.3, c: 0.55, d: 0.2, e: 0.5, f: 0.3, g: 0, h: 0.15, i: 0.5, j: 0.45, k: 0.55, l: 0.3, m: 0.75, n: 0.45, o: 0.15, p: 0.35, q: 0.35, r: 0.3, s: 0.45, t: 0.45, u: 2, v: 2, w: 2 };
  const HOLD = { a: 1, u: 1, v: 1, w: 1 };
  const h = (i, j) => { const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s); };
  const cl = (x) => Math.max(0, Math.min(1, x));
  const eio = (x) => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  const eo = (x) => 1 - Math.pow(1 - x, 3);
  const prog = (u) => cl(u + 0.06 * Math.sin(u * Math.PI * 3));
  const pad = (n) => String(n).padStart(3, '0');
  const lerp = (a, b, t) => a + (b - a) * t;
  const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  const mix = (x) => { x = cl(x) * (P.length - 1); const i = Math.min(P.length - 2, Math.floor(x)), f = x - i, a = hex(P[i]), b = hex(P[i + 1]); return `rgb(${a.map((v, k) => Math.round(lerp(v, b[k], f))).join(',')})`; };
  const MONO = "'IBM Plex Mono',monospace", SANS = "'Inter Tight',sans-serif", SERIF = "'Newsreader',serif";

  function counter(ctx, W, H, p, col) {
    ctx.font = `500 11px ${MONO}`; ctx.fillStyle = col; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(pad(Math.floor(p * 100)), W - 29, H - 22);
    ctx.textAlign = 'left'; ctx.fillText('nua.', 29, H - 22);
  }

  const V = {};
  // A — ASCII bloom
  V.a = (ctx, W, H, t, p, o) => {
    const CH = ' .·:-=+*#%@', cs = 9, cols = Math.ceil(W / cs), rows = Math.ceil(H / cs);
    const cx = W / 2, cy = H * .48, R = 220 * (1 + eio(o) * 5), grow = eo(p) * .9 + .1 * p, rot = t / 4000;
    ctx.fillStyle = INK; ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1 - eo(cl(o / .85));
    ctx.font = `500 10px ${MONO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const fr = Math.floor(t / 90);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const x = i * cs + cs / 2, y = j * cs + cs / 2, dx = x - cx, dy = y - cy;
      const r = Math.hypot(dx, dy) / R, th = Math.atan2(dy, dx);
      const pet = Math.abs(Math.cos(3 * (th + rot))), inner = .62 * Math.abs(Math.cos(3 * (th + rot + Math.PI / 6)));
      const shape = .22 + .78 * Math.max(Math.pow(pet, 1.6), inner);
      const rr = r / Math.max(grow, .001);
      let v = shape - rr + (h(i, j + fr) - .5) * .12;
      if (r < .09 * grow) v = .9;
      if (v <= 0) continue;
      const k = Math.min(CH.length - 1, 1 + Math.floor(v * (CH.length - 1) * 1.25));
      const petIdx = Math.floor(((th + rot + Math.PI) / (Math.PI * 2)) * 6 + .5) % 6;
      ctx.fillStyle = r < .12 * grow ? CREAM : P[petIdx % P.length];
      ctx.fillText(CH[k], x, y);
    }
    ctx.globalAlpha = 1 - cl(o * 3); counter(ctx, W, H, p, CREAM); ctx.globalAlpha = 1;
  };
  // B — Babel: one word through many languages, cream curtain lifts
  const WORDS = [['EN', 'meaning'], ['ES', 'significado'], ['HI', 'अर्थ'], ['FR', 'sens'], ['JA', '意味'], ['DE', 'Bedeutung'], ['KO', '의미'], ['IT', 'senso'], ['AR', 'معنى'], ['PT', 'sentido'], ['RU', 'смысл'], ['NL', 'betekenis']];
  V.b = (ctx, W, H, t, p, o) => {
    const off = -H * eio(o);
    ctx.fillStyle = CREAM; ctx.fillRect(0, off, W, H);
    const n = WORDS.length, fx = p * n * 1.4, idx = p >= .985 ? -1 : Math.floor(fx) % n, ph = fx - Math.floor(fx);
    const w = idx < 0 ? ['', 'nua.'] : WORDS[idx];
    const font = w[0] === 'HI' ? `40px 'Tiro Devanagari Hindi',serif` : idx < 0 ? `300 52px ${SERIF}` : `italic 400 44px ${SERIF}`;
    const ent = idx < 0 ? 1 : eo(cl(ph * 4));
    ctx.save(); ctx.globalAlpha = ent; ctx.font = font; ctx.fillStyle = INK; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(w[1], W / 2, H / 2 - 8 + off + (1 - ent) * 8); ctx.restore();
    ctx.font = `500 10px ${SANS}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = INK;
    const lab = idx < 0 ? 'MEANING' : w[0];
    const tw = ctx.measureText(lab).width;
    ctx.fillStyle = idx < 0 ? INK : P[idx % P.length]; ctx.fillRect(W / 2 - tw / 2 - 12, H / 2 + 34 + off, 6, 6);
    ctx.fillStyle = INK; ctx.fillText(lab, W / 2 + 2, H / 2 + 37 + off);
    ctx.fillStyle = INK; ctx.fillRect(0, H - 1 + off, W * p, 1);
    counter(ctx, W, H + off, p, INK);
  };
  // C — Signal: a waveform of pixels becomes the curtain
  const SEG = ['Transition', 'This part matters', 'Recap', 'Definition', 'Example'];
  V.c = (ctx, W, H, t, p, o) => {
    const s = 6, cols = Math.ceil(W / s), cy = H / 2;
    const o1 = eio(cl(o / .45)), o2 = cl((o - .45) / .55);
    if (o < .45) { ctx.fillStyle = INK; ctx.fillRect(0, 0, W, H); }
    for (let i = 0; i < cols; i++) {
      const u = i / cols; if (u > p) break;
      const seg = Math.min(4, Math.floor(u * 5));
      const env = .2 + .8 * Math.abs(Math.sin(i * .21) * Math.sin(i * .053 + 1.3)) * (.6 + .4 * h(i, 3));
      const live = Math.sin(t / 180 + i * .4) * .08 + 1;
      const a = Math.round(env * 70 * live / s) * s;
      const edge = p - u < .015 && p < 1;
      ctx.fillStyle = edge ? CREAM : P[seg];
      if (o2 <= 0) {
        const top = lerp(cy - a, 0, o1), bot = lerp(cy + a, H, o1);
        if (o1 > 0) ctx.fillRect(i * s, top, s + .5, bot - top);
        else for (let y = cy - a; y < cy + a; y += s) ctx.fillRect(i * s + .5, y + .5, s - 1, s - 1);
      } else {
        const k = eio(cl(o2 * 1.7 - u * .7));
        ctx.fillRect(i * s, 0, s + .5, H * (1 - k));
      }
    }
    if (o < .2) {
      ctx.globalAlpha = 1 - o * 5;
      ctx.font = `500 9.5px ${SANS}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      SEG.forEach((l, k) => { if (p > (k + 1) / 5 - .001) { ctx.fillStyle = P[k]; ctx.fillText(l.toUpperCase(), k * W / 5 + 6, cy + 104); } });
      ctx.font = `500 11px ${MONO}`; ctx.fillStyle = CREAM; ctx.fillText(pad(Math.floor(p * 100)), Math.min(W - 34, p * W + 8), cy - 82);
      ctx.fillText('nua.', 29, H - 22);
      ctx.globalAlpha = 1;
    }
  };
  // D — Glyph field: pixels lock into the wordmark, then dissolve top-down
  V.d = (ctx, W, H, t, p, o, st) => {
    const cs = 10, cols = Math.ceil(W / cs), rows = Math.ceil(H / cs);
    if (!st.mask) {
      const m = document.createElement('canvas'); m.width = cols; m.height = rows; const mc = m.getContext('2d');
      mc.fillStyle = '#fff'; mc.font = `400 ${rows * .62}px ${SERIF}`; mc.textAlign = 'center'; mc.textBaseline = 'middle';
      mc.fillText('nua.', cols / 2, rows * .47);
      st.mask = mc.getImageData(0, 0, cols, rows).data;
    }
    const GL = 'XS80#@+x:/<>', fr = Math.floor(t / 110);
    ctx.font = `500 9px ${MONO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const wave = Math.sin(i / cols * Math.PI * 3 + 1) * .06;
      const r2 = .55 * (j / rows + wave) + .45 * h(i + 9, j + 4);
      const dz = o * 1.2 - r2;
      if (dz > .1) continue;
      const x = i * cs, y = j * cs, inT = st.mask[(j * cols + i) * 4 + 3] > 120, r1 = h(i, j);
      ctx.fillStyle = INK; ctx.fillRect(x, y, cs, cs);
      if (dz > 0) { ctx.fillStyle = mix(i / cols); ctx.fillRect(x + 1, y + 1, cs - 2, cs - 2); continue; }
      if (inT && r1 < p * 1.05) { ctx.fillStyle = mix(i / cols); ctx.fillRect(x + .5, y + .5, cs - 1, cs - 1); }
      else {
        const g = GL[Math.floor(h(i, j + fr) * GL.length)];
        ctx.fillStyle = CREAM; ctx.globalAlpha = inT ? .55 : (h(j, i + fr) < .08 ? .4 : .1);
        ctx.fillText(g, x + cs / 2, y + cs / 2); ctx.globalAlpha = 1;
      }
    }
    if (o < .15) { ctx.globalAlpha = 1 - o / .15; counter(ctx, W, H, p, CREAM); ctx.globalAlpha = 1; }
  };
  // E — Lesson tracks fill, then become stripes that slide away
  V.e = (ctx, W, H, t, p, o) => {
    const o1 = eio(cl(o / .45)), o2 = cl((o - .45) / .55);
    const bw = 380, bx = (W - bw) / 2, gap = 26, y0 = H / 2 - gap * 2 + 22, tx = bx + 140, tw = bw - 140;
    if (o < .45) { ctx.fillStyle = INK; ctx.fillRect(0, 0, W, H); }
    if (o === 0) {
      ctx.font = `300 64px ${SERIF}`; ctx.fillStyle = CREAM; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(String(Math.floor(p * 100)), W / 2, y0 - 44);
    }
    SEG.forEach((l, k) => {
      const f = cl(p * 5 - k), y = y0 + k * gap;
      const sy = k * H / 5, sh = H / 5 + 1;
      if (o2 <= 0) {
        if (o1 === 0) { ctx.fillStyle = 'rgba(255,231,206,.12)'; ctx.fillRect(tx, y - 2, tw, 4); }
        const rx = lerp(tx, 0, o1), rw = lerp(tw * f, W, o1), ry = lerp(y - 2, sy, o1), rh = lerp(4, sh, o1);
        ctx.fillStyle = P[k]; ctx.fillRect(rx, ry, rw, rh);
        ctx.font = `500 10px ${SANS}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillStyle = o1 > .5 ? INK : `rgba(255,231,206,${.35 + .65 * f})`;
        ctx.fillText(l.toUpperCase(), lerp(bx, 29, o1), lerp(y, sy + sh / 2, o1));
      } else {
        const k2 = eio(cl(o2 * 1.5 - k * .1)), dir = k % 2 ? 1 : -1;
        ctx.save(); ctx.translate(dir * W * k2, 0);
        ctx.fillStyle = P[k]; ctx.fillRect(0, sy, W, sh);
        ctx.font = `500 10px ${SANS}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = INK; ctx.fillText(l.toUpperCase(), 29, sy + sh / 2);
        ctx.restore();
      }
    });
    if (o === 0) counter(ctx, W, H, p, CREAM);
  };

  // F — Transliteration: Hindi types out, English resolves from Devanagari glyphs
  const HI = 'जहाँ अर्थ को एक नई आवाज़ मिलती है।', EN = 'Where meaning finds a new voice.', DEV = 'अआइकखगघचजटडतदनपबमयरलवशसह';
  const seg = (s) => (window.Intl && Intl.Segmenter ? [...new Intl.Segmenter('hi', { granularity: 'grapheme' }).segment(s)].map((x) => x.segment) : Array.from(s));
  const HIG = seg(HI);
  V.f = (ctx, W, H, t, p, o) => {
    ctx.globalAlpha = 1 - eio(cl(o / .7)); ctx.fillStyle = INK; ctx.fillRect(0, 0, W, H);
    const a = 1 - cl(o * 2.2); ctx.globalAlpha = a;
    const pa = cl(p / .45), pb = cl((p - .4) / .55);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `30px 'Tiro Devanagari Hindi',serif`; ctx.fillStyle = `rgba(255,231,206,${lerp(1, .38, pb)})`;
    const n = Math.floor(pa * HIG.length), hs = HIG.slice(0, n).join('');
    ctx.fillText(hs, W / 2, H / 2 - 26 - o * 30);
    if (pa < 1 && Math.floor(t / 260) % 2) { const w = ctx.measureText(hs).width; ctx.fillStyle = P[2]; ctx.fillRect(W / 2 + w / 2 + 4, H / 2 - 42, 2, 30); }
    if (pb > 0) {
      ctx.font = `italic 400 32px ${SERIF}`; const fr = Math.floor(t / 70); let out = '';
      const ch = [...EN]; ch.forEach((c, i) => { const u = i / ch.length; out += u < pb - .08 ? c : u < pb ? (c === ' ' ? ' ' : DEV[Math.floor(h(i, fr) * DEV.length)]) : ' '; });
      ctx.fillStyle = CREAM; ctx.fillText(out, W / 2, H / 2 + 22 + o * 30);
    }
    ctx.font = `500 10px ${SANS}`; ctx.fillStyle = P[0]; ctx.fillText(pb > .5 ? 'HI → EN' : 'HI', W / 2, H / 2 + 76);
    counter(ctx, W, H, p, CREAM); ctx.globalAlpha = 1;
  };
  // G — Keyhole: a pixel aperture opens onto the live hero
  V.g = (ctx, W, H, t, p, o) => {
    const cs = 12, cx = W / 2, cy = H / 2, max = Math.hypot(W, H) / 2 + cs * 4;
    const rad = lerp(lerp(14, 70, eo(p)) + Math.sin(t / 240) * 3, max, eio(o));
    for (let y = 0; y < H; y += cs) for (let x = 0; x < W; x += cs) {
      const d = Math.hypot(x + cs / 2 - cx, y + cs / 2 - cy);
      if (d < rad) continue;
      if (d < rad + cs * 2) { const ang = (Math.atan2(y - cy, x - cx) / Math.PI + 1) / 2; ctx.fillStyle = mix((ang + t / 3000) % 1); ctx.fillRect(x, y, cs, cs); ctx.fillStyle = INK; ctx.fillRect(x + 1, y + 1, cs - 2, cs - 2); if (d < rad + cs) { ctx.fillStyle = mix((ang + t / 3000) % 1); ctx.fillRect(x + 2, y + 2, cs - 4, cs - 4); } continue; }
      ctx.fillStyle = INK; ctx.fillRect(x, y, cs, cs);
    }
    if (o < .25) { ctx.globalAlpha = 1 - o * 4; ctx.font = `500 11px ${MONO}`; ctx.fillStyle = CREAM; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(pad(Math.floor(p * 100)), cx + rad + cs * 3, cy); counter(ctx, W, H, p, CREAM); ctx.globalAlpha = 1; }
  };
  // H — Ripple: a voice sends out rings of the same word in many languages
  const RW = ['voice', 'voz', 'voix', 'Stimme', 'आवाज़', '声', 'voce', 'głos', '목소리', 'ses'];
  V.h = (ctx, W, H, t, p, o) => {
    const cx = W / 2, cy = H / 2, maxR = Math.hypot(W, H) / 2 + 20;
    ctx.fillStyle = INK; ctx.fillRect(0, 0, W, H);
    const per = 420, k0 = Math.floor(t / per);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let k = Math.max(0, k0 - 8); k <= k0; k++) {
      const age = (t - k * per) / 3200; if (age < 0 || age > 1) continue;
      const r = 20 + eo(age) * 300, w = RW[k % RW.length], col = P[k % P.length];
      ctx.globalAlpha = (1 - age) * (1 - cl(o * 3));
      ctx.font = w === 'आवाज़' ? `13px 'Tiro Devanagari Hindi',serif` : `500 11px ${SANS}`;
      const step = (ctx.measureText(w + '   ').width + 6) / r, cnt = Math.max(1, Math.floor(Math.PI * 2 / step));
      ctx.fillStyle = col;
      for (let q = 0; q < cnt; q++) { const a = q * Math.PI * 2 / cnt + k * .7; ctx.save(); ctx.translate(cx + Math.cos(a) * r, cy + Math.sin(a) * r); ctx.rotate(a + Math.PI / 2); ctx.fillText(w, 0, 0); ctx.restore(); }
    }
    ctx.globalAlpha = 1;
    const pr = 5 + Math.sin(t / 140) * 1.5 + p * 4; ctx.fillStyle = CREAM; ctx.beginPath(); ctx.arc(cx, cy, pr, 0, Math.PI * 2); ctx.fill();
    if (o > 0) {
      const R = eio(o) * maxR; ctx.save(); ctx.globalCompositeOperation = 'destination-out'; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      ctx.strokeStyle = P[2]; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    }
    if (o < .2) { ctx.globalAlpha = 1 - o * 5; counter(ctx, W, H, p, CREAM); ctx.globalAlpha = 1; }
  };
  // I — Tide: a halftone of the wave artwork rises, then dissolves cell by cell
  V.i = (ctx, W, H, t, p, o) => {
    const s = 14, o1 = eio(cl(o / .4)), o2 = cl((o - .35) / .65);
    for (let y = 0; y < H; y += s) for (let x = 0; x < W; x += s) {
      const k = cl(o2 * 1.6 - (y / H) * .6 - h(x, y) * .1); if (k >= 1) continue;
      const sz = s * (1 - k);
      ctx.fillStyle = INK; ctx.fillRect(x + (s - sz) / 2, y + (s - sz) / 2, sz, sz);
      const level = lerp(H * (1 - p * .78), -160, o1) + Math.sin(x / 90 + t / 700) * 22 + Math.sin(x / 37 - t / 1100) * 9;
      const v = cl((y - level) / 140); if (v <= .02) continue;
      ctx.fillStyle = mix(x / W); ctx.beginPath(); ctx.arc(x + s / 2, y + s / 2, v * s * .48 * (1 - k), 0, Math.PI * 2); ctx.fill();
    }
    if (o < .2) { ctx.globalAlpha = 1 - o * 5; counter(ctx, W, H, p, CREAM); ctx.globalAlpha = 1; }
  };
  // J — Departure board: split-flap tiles flip through languages to nua.
  const BOARD = ['ENGLISH', 'HINDI', 'ESPAÑOL', 'FRANÇAIS', 'DEUTSCH', '日本語', 'NUA.'];
  const AZ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  V.j = (ctx, W, H, t, p, o) => {
    const n = 9, tw = 58, th = 82, g = 6, bx = (W - (n * tw + (n - 1) * g)) / 2, by = H / 2 - th / 2;
    const o2 = eio(cl((o - .35) / .65));
    ctx.fillStyle = INK; ctx.fillRect(0, -H / 2 * o2, W, H / 2); ctx.fillRect(0, H / 2 + H / 2 * o2, W, H / 2);
    const fx = p >= .97 ? BOARD.length - 1 : Math.min(BOARD.length - 2, Math.floor(p / .97 * (BOARD.length - 1))), loc = p / .97 * (BOARD.length - 1) - fx;
    const word = [...BOARD[fx]], st = Math.floor((n - word.length) / 2), fr = Math.floor(t / 55);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `500 10px ${SANS}`; ctx.fillStyle = 'rgba(255,231,206,.6)'; ctx.textAlign = 'left';
    if (o < .3) { ctx.globalAlpha = 1 - o / .3; ctx.fillText('NOW SPEAKING', bx, by - 20); ctx.textAlign = 'right'; ctx.fillText(pad(Math.floor(p * 100)), bx + n * tw + (n - 1) * g, by - 20); ctx.globalAlpha = 1; }
    ctx.textAlign = 'center';
    for (let c = 0; c < n; c++) {
      const fl = cl(o * 2.6 - c * .1); if (fl >= 1) continue;
      const x = bx + c * (tw + g), ch = word[c - st] || ' ';
      const settled = fx === BOARD.length - 1 ? true : loc > .12 + c * .04;
      const disp = settled ? ch : AZ[Math.floor(h(c, fr) * AZ.length)];
      ctx.save(); ctx.translate(x + tw / 2, by + th / 2); ctx.scale(1, 1 - eio(fl)); 
      ctx.fillStyle = '#1d1c12'; ctx.fillRect(-tw / 2, -th / 2, tw, th);
      ctx.fillStyle = settled && ch !== ' ' ? P[fx % P.length] : 'rgba(255,231,206,.08)'; ctx.fillRect(-tw / 2, th / 2 - 3, tw, 3);
      ctx.font = ch.charCodeAt(0) > 0x3000 ? `500 36px sans-serif` : `500 40px ${MONO}`; ctx.fillStyle = CREAM; ctx.fillText(disp, 0, 2);
      ctx.fillStyle = INK; ctx.fillRect(-tw / 2, -1, tw, 2);
      ctx.restore();
    }
    if (o < .2) { ctx.globalAlpha = 1 - o * 5; ctx.font = `500 11px ${MONO}`; ctx.fillStyle = CREAM; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillText('nua.', 29, H - 22); ctx.globalAlpha = 1; }
  };

  // K — Assemble: a grid of pixels gathers into the wordmark, floods, lifts
  V.k = (ctx, W, H, t, p, o, st) => {
    const gc = 24, gr = 13, G = gc * gr, sp = W / gc;
    if (!st.tg) {
      const mc = document.createElement('canvas'), cw = 46, chh = 20; mc.width = cw; mc.height = chh; const m = mc.getContext('2d');
      m.fillStyle = '#fff'; m.font = `500 19px ${SANS}`; m.textAlign = 'center'; m.textBaseline = 'middle'; m.fillText('nua.', cw / 2, chh / 2 + 1);
      const d = m.getImageData(0, 0, cw, chh).data, tg = [], c = 12;
      for (let j = 0; j < chh; j++) for (let i = 0; i < cw; i++) if (d[(j * cw + i) * 4 + 3] > 110) tg.push([W / 2 + (i - cw / 2 + .5) * c, H / 2 + (j - chh / 2 + .5) * c]);
      st.tg = tg; st.c = c;
    }
    const tg = st.tg, c = st.c, off = -H * eio(cl((o - .45) / .55)), fl = eio(cl(o / .4));
    ctx.fillStyle = CREAM; ctx.fillRect(0, off, W, H);
    if (fl > 0) { ctx.fillStyle = P[2]; ctx.beginPath(); ctx.arc(W / 2, H / 2 + off, fl * Math.hypot(W, H) / 2, 0, Math.PI * 2); ctx.fill(); }
    const n = Math.max(G, tg.length);
    for (let k = 0; k < n; k++) {
      const gi = k % G, gx = (gi % gc + .5) * sp + Math.sin(t / 500 + gi) * 3, gy = (Math.floor(gi / gc) + .5) * (H / gr) + Math.cos(t / 600 + gi * .7) * 3;
      const hasT = k < tg.length, a = eio(cl((p - .28) / .5 - h(k, 2) * .35));
      const x = hasT ? lerp(gx, tg[k][0], a) : gx, y = (hasT ? lerp(gy, tg[k][1], a) : gy) + off;
      const sz = hasT ? lerp(10, c - 3, a) : 10 * (1 - a), circ = h(k, 7) < .3 && a > .5;
      if (sz < .5) continue;
      ctx.fillStyle = fl > .6 ? CREAM : mix(x / W);
      if (circ) { ctx.beginPath(); ctx.arc(x, y, sz / 2, 0, Math.PI * 2); ctx.fill(); } else ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
    }
    if (o < .3) { ctx.globalAlpha = 1 - o / .3; counter(ctx, W, H, p, INK); ctx.globalAlpha = 1; }
  };
  // L — Garden: ASCII stems grow from the floor and bloom on orange
  V.l = (ctx, W, H, t, p, o) => {
    const cs = 8, off = H * eio(o);
    ctx.fillStyle = P[1]; ctx.fillRect(0, off, W, H);
    ctx.font = `500 8px ${MONO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const CH = '%#@*o+', fr = Math.floor(t / 140);
    const S = [[.14, .62, 0], [.3, .82, .12], [.5, .55, .05], [.68, .9, .2], [.86, .7, .1]];
    S.forEach(([sx, sh, d], k) => {
      const g = cl((p - d) / .62), top = H - sh * H * eo(g), bx = sx * W;
      for (let y = H; y > top; y -= cs) {
        const sw = Math.sin((H - y) / 70 + k + t / 900) * 10 * ((H - y) / H);
        for (let q = -1; q <= 0; q++) { ctx.fillStyle = 'rgba(255,231,206,.85)'; ctx.fillText(CH[Math.floor(h(k * 50 + q, Math.floor(y) + fr) * 3)], bx + sw + q * cs, y + off); }
      }
      const b = eo(cl((g - .7) / .3)); if (b <= 0) return;
      const sw = Math.sin(sh * H / 70 + k + t / 900) * 10 * sh, R = (48 + k * 6) * b, cx = bx + sw, cy = top;
      for (let y = -R; y <= R; y += cs) for (let x = -R; x <= R; x += cs) {
        const r = Math.hypot(x, y) / R, th = Math.atan2(y, x), pet = .45 + .55 * Math.abs(Math.cos((k % 2 ? 2.5 : 3) * th + t / 2000 + k));
        if (r > pet) continue;
        const v = r < .22 ? 4 : r < .5 ? 2 : Math.floor(h(x + k, y + fr) * 3);
        ctx.fillStyle = r < .22 ? INK : 'rgba(255,231,206,.92)';
        ctx.fillText(CH[v], cx + x, cy + y + off);
      }
    });
    counter(ctx, W, H + off, p, INK);
  };
  // M — Tracking: the flower film full-frame under tracking boxes, then it docks into the hero
  const TAGS = [['ES', 'voz'], ['FR', 'voix'], ['HI', 'आवाज़'], ['JA', '声'], ['DE', 'Stimme'], ['TR', 'ses']];
  const VALS = ['0.1429', '0.2857', '0.5714', '0.7443', '0.8671', '1.0000'];
  V.m = (ctx, W, H, t, p, o, st, vid) => {
    const k = eio(cl(o / .8)), fade = cl((o - .8) / .2);
    const hx = W * .32, hy = 72, hw = W * .8, hh = hw / 1.7843;
    const cw = W * 1.15, ch = cw / 1.7843, cx0 = (W - cw) / 2, cy0 = (H - ch) / 2;
    const x = lerp(cx0, hx, k), y = lerp(cy0, hy, k), w = lerp(cw, hw, k), hgt = lerp(ch, hh, k);
    ctx.globalAlpha = 1 - fade; ctx.fillStyle = INK; ctx.fillRect(0, 0, W, H);
    if (vid && vid.readyState >= 2) {
      const seg = Math.floor(t / 420) % 4;
      ctx.filter = o > 0 ? `hue-rotate(${(1 - k) * [0, 22, -28, 40][seg]}deg) saturate(${1 + (1 - k) * .6})` : `hue-rotate(${[0, 22, -28, 40][seg]}deg) saturate(1.6) contrast(1.1)`;
      ctx.drawImage(vid, x, y, w, hgt); ctx.filter = 'none';
    }
    const oa = (1 - cl(o * 2.5)) * (1 - fade); if (oa <= 0) { ctx.globalAlpha = 1; return; }
    ctx.globalAlpha = oa; ctx.strokeStyle = CREAM; ctx.lineWidth = 1; ctx.font = `500 8px ${MONO}`; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    const fr = Math.floor(t / 380), pts = [];
    for (let b = 0; b < 4; b++) {
      const bx = 160 + h(b, fr) * (W - 360), by = 70 + h(b + 5, fr) * (H - 200), s = 28 + h(b + 9, fr) * 56;
      ctx.strokeRect(bx + .5, by + .5, s, s); pts.push([bx + s / 2, by + s / 2]);
      const tg = TAGS[(b + fr) % TAGS.length];
      ctx.fillStyle = CREAM; ctx.fillText(`${tg[0]} ${tg[1]}  ${VALS[(b * 3 + fr) % VALS.length]}`, bx, by - 3);
    }
    ctx.beginPath(); pts.forEach(([a, b], i) => (i ? ctx.lineTo(a, b) : ctx.moveTo(a, b))); ctx.strokeStyle = 'rgba(255,231,206,.55)'; ctx.stroke();
    counter(ctx, W, H, p, CREAM); ctx.globalAlpha = 1;
  };
  // N — Globe: a turning world of glyph cells, lands in the palette
  V.n = (ctx, W, H, t, p, o) => {
    const cs = 9, cx = W / 2, cy = H / 2 - 12, R = 170 * (1 + eio(o) * 4.5), rot = t / 1400;
    ctx.fillStyle = INK; ctx.globalAlpha = 1 - cl((o - .45) / .4); ctx.fillRect(0, 0, W, H);
    const ga = 1 - cl((o - .35) / .5);
    for (let y = Math.max(0, cy - R); y < Math.min(H, cy + R); y += cs) for (let x = Math.max(0, cx - R); x < Math.min(W, cx + R); x += cs) {
      const gx = Math.round((x - cx) / cs), gy = Math.round((y - cy) / cs);
      const nx = (gx * cs) / R, ny = (gy * cs) / R, d2 = nx * nx + ny * ny; if (d2 > 1) continue;
      if (h(gx + 40, gy + 40) > p * 1.35) continue;
      const nz = Math.sqrt(1 - d2), lon = Math.atan2(nx, nz) + rot, lat = Math.asin(ny);
      const f = Math.sin(3 * lon) * Math.cos(2 * lat) + .55 * Math.sin(5 * lon + 1) * Math.sin(3 * lat + .4) + .3 * Math.sin(7 * lon + lat * 4);
      const px = cx + gx * cs, py = cy + gy * cs; ctx.globalAlpha = ga * (.35 + .65 * nz);
      if (f > .6) { ctx.fillStyle = P[3]; ctx.beginPath(); ctx.arc(px, py, cs * .42, 0, Math.PI * 2); ctx.fill(); }
      else if (f > .25) { ctx.fillStyle = P[lat < -.5 ? 0 : 1]; ctx.fillRect(px - cs * .4, py - cs * .4, cs * .8, cs * .8); }
      else if (f > .08) { ctx.strokeStyle = CREAM; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(px, py, cs * .32, 0, Math.PI * 2); ctx.stroke(); }
      else { ctx.fillStyle = 'rgba(216,220,106,.5)'; ctx.fillRect(px - 2.5, py - .5, 5, 1); ctx.fillRect(px - .5, py - 2.5, 1, 5); }
    }
    ctx.globalAlpha = 1;
    if (o < .25) { ctx.globalAlpha = 1 - o * 4; ctx.font = `500 11px ${MONO}`; ctx.fillStyle = CREAM; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillText(pad(Math.floor(p * 100)), cx, cy + 170 + 30); ctx.textAlign = 'left'; ctx.fillText('nua.', 29, H - 22); ctx.globalAlpha = 1; }
  };
  // O — Mosaic: the flower film depixelates into place
  const STEPS = [48, 36, 24, 18, 12, 9, 6];
  V.o = (ctx, W, H, t, p, o, st, vid) => {
    const cs = o > 0 ? Math.max(3, Math.round(6 - o * 4)) : STEPS[Math.min(STEPS.length - 1, Math.floor(eo(p) * STEPS.length))];
    const cols = Math.ceil(W / cs), rows = Math.ceil(H / cs);
    if (!st.oc) { st.oc = document.createElement('canvas'); st.ox = st.oc.getContext('2d', { willReadFrequently: true }); }
    st.oc.width = cols; st.oc.height = rows; const ox = st.ox;
    ox.fillStyle = '#000'; ox.fillRect(0, 0, cols, rows);
    const hx = W * .32 / cs, hy = 72 / cs, hw = W * .8 / cs, hh = hw / 1.7843;
    if (vid && vid.readyState >= 2) ox.drawImage(vid, hx, hy, hw, hh);
    const d = ox.getImageData(0, 0, cols, rows).data;
    ctx.globalAlpha = 1 - eio(o); ctx.fillStyle = INK; ctx.fillRect(0, 0, W, H);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const q = (j * cols + i) * 4, r = d[q], g = d[q + 1], b = d[q + 2], L = (r * .3 + g * .59 + b * .11) / 255;
      if (L < .06) continue;
      const s = cs * Math.min(1, .25 + L * 1.1);
      ctx.fillStyle = `rgb(${r},${g},${b})`; ctx.fillRect(i * cs + (cs - s) / 2, j * cs + (cs - s) / 2, s, s);
    }
    if (o < .3) { ctx.globalAlpha = 1 - o / .3; counter(ctx, W, H, p, CREAM); ctx.fillText(cs + 'px', W - 70, H - 22); }
    ctx.globalAlpha = 1;
  };

  // shared ASCII bloom: density from a value fn, blooms past the edges on outro
  const BCH = ' .·:-=+*#%@';
  function bloom(ctx, W, H, t, o, val, col) {
    const cs = 9, cols = Math.ceil(W / cs), rows = Math.ceil(H / cs), Z = 1 + eio(o) * 5, fr = Math.floor(t / 90);
    ctx.globalAlpha = 1 - cl(o * 1.6); ctx.fillStyle = INK; ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1 - cl((o - .2) * 1.4);
    ctx.font = `500 10px ${MONO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const x = i * cs + cs / 2, y = j * cs + cs / 2, u = (x - W / 2) / Z + W / 2, w = (y - H * .48) / Z + H * .48;
      let v = val(u, w, i, j); if (v <= 0) continue;
      v += (h(i, j + fr) - .5) * .12; if (v <= 0) continue;
      ctx.fillStyle = col(u, w, v); ctx.fillText(BCH[Math.min(BCH.length - 1, 1 + Math.floor(v * (BCH.length - 1) * 1.25))], x, y);
    }
    ctx.globalAlpha = 1;
  }
  // P — ASCII voice: a radial spectrum of a voice grows and blooms
  V.p = (ctx, W, H, t, p, o) => {
    const cx = W / 2, cy = H * .48, R = 250, grow = eo(p) * .9 + .1 * p, bins = 56;
    bloom(ctx, W, H, t, o, (x, y) => {
      const dx = x - cx, dy = y - cy, r = Math.hypot(dx, dy) / R, th = Math.atan2(dy, dx), b = Math.floor((th + Math.PI) / (Math.PI * 2) * bins);
      const amp = .45 + .55 * Math.abs(Math.sin(b * .9 + t / 260) * Math.sin(b * .37 - t / 410)) * (.6 + .4 * Math.sin(t / 180 + b));
      const rr = r / Math.max(grow, .001), ring = .14;
      if (rr < ring) return 0;
      return (amp - rr) * 2 + (rr < ring + .06 ? .6 : 0);
    }, (x, y) => mix(((Math.atan2(y - cy, x - cx) + Math.PI) / (Math.PI * 2) + t / 6000) % 1));
    ctx.globalAlpha = 1 - cl(o * 3); counter(ctx, W, H, p, CREAM); ctx.globalAlpha = 1;
  };
  // Q — ASCII script: one letter shifting through writing systems, then blooming
  const GLY = [['A', SERIF, 0], ['अ', "'Tiro Devanagari Hindi',serif", 2], ['あ', 'sans-serif', 3], ['ع', 'serif', 1], ['Ж', SERIF, 4], ['n', SERIF, 2]];
  V.q = (ctx, W, H, t, p, o, st) => {
    const cs = 9, cols = Math.ceil(W / cs), rows = Math.ceil(H / cs);
    if (!st.gm) {
      st.gm = GLY.map(([g, f]) => { const c = document.createElement('canvas'); c.width = cols; c.height = rows; const x = c.getContext('2d');
        x.fillStyle = '#fff'; x.shadowColor = '#fff'; x.shadowBlur = 4; x.font = `${rows * .82}px ${f}`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(g, cols / 2, rows * .52);
        return x.getImageData(0, 0, cols, rows).data; });
    }
    const n = GLY.length, fx = Math.min(n - 1, p * (n - 1) * 1.02), a = Math.floor(fx), b = Math.min(n - 1, a + 1), f = eio(cl((fx - a - .55) / .45));
    const ca = hex(P[GLY[a][2]]), cb = hex(P[GLY[b][2]]), colr = `rgb(${ca.map((v, k) => Math.round(lerp(v, cb[k], f))).join(',')})`;
    bloom(ctx, W, H, t, o, (x, y) => {
      const i = Math.floor(x / cs), j = Math.floor(y / cs); if (i < 0 || j < 0 || i >= cols || j >= rows) return 0;
      const q = (j * cols + i) * 4 + 3, v = lerp(st.gm[a][q], st.gm[b][q], f) / 255;
      return v * cl(p * 4) * .95 - .05;
    }, () => colr);
    ctx.globalAlpha = 1 - cl(o * 3); counter(ctx, W, H, p, CREAM); ctx.globalAlpha = 1;
  };
  // R — Babel reel: languages roll past like a slot reel and land on nua.
  const REEL = WORDS.concat(WORDS.slice(0, 6)).concat([['', 'nua.']]);
  V.r = (ctx, W, H, t, p, o) => {
    const off = -H * eio(o), rh = 58, cy = H / 2 + off, N = REEL.length - 1, pos = eio(p) * N;
    ctx.fillStyle = CREAM; ctx.fillRect(0, off, W, H);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let k = Math.max(0, Math.floor(pos) - 5); k <= Math.min(N, Math.ceil(pos) + 5); k++) {
      const d = k - pos, y = cy + d * rh, a = 1 - Math.min(1, Math.abs(d) / 4.5); if (a <= 0) continue;
      const w = REEL[k], last = k === N;
      ctx.globalAlpha = Math.abs(d) < .5 ? 1 : a * .28;
      ctx.font = w[0] === 'HI' ? `40px 'Tiro Devanagari Hindi',serif` : last ? `300 52px ${SERIF}` : `italic 400 44px ${SERIF}`;
      ctx.fillStyle = INK; ctx.fillText(w[1], W / 2, y);
    }
    ctx.globalAlpha = 1;
    const cur = REEL[Math.round(pos)], ci = Math.round(pos);
    ctx.fillStyle = INK; ctx.fillRect(W / 2 - 230, cy - rh / 2, 1, rh); ctx.fillRect(W / 2 + 230, cy - rh / 2, 1, rh);
    ctx.font = `500 10px ${SANS}`; ctx.textAlign = 'left'; ctx.fillStyle = cur[0] ? P[ci % P.length] : INK; ctx.fillRect(W / 2 - 214, cy - 3, 6, 6);
    ctx.fillStyle = INK; ctx.fillText(cur[0] || 'MEANING', W / 2 - 202, cy + 1);
    const g = ctx.createLinearGradient(0, off, 0, off + H); g.addColorStop(0, 'rgba(255,231,206,1)'); g.addColorStop(.3, 'rgba(255,231,206,0)'); g.addColorStop(.7, 'rgba(255,231,206,0)'); g.addColorStop(1, 'rgba(255,231,206,1)');
    ctx.fillStyle = g; ctx.fillRect(0, off, W, H);
    ctx.fillStyle = INK; ctx.fillRect(0, H - 1 + off, W * p, 1);
    counter(ctx, W, H + off, p, INK);
  };
  // shared sphere: turning grid of cells, zooms past on outro
  function sphere(ctx, W, H, t, p, o, cell, R0) {
    const cs = 11, cx = W / 2, cy = H / 2 - 12, R = (R0 || 175) * (1 + eio(o) * 4.5), rot = t / 1600;
    ctx.fillStyle = INK; ctx.globalAlpha = 1 - cl((o - .45) / .4); ctx.fillRect(0, 0, W, H);
    const ga = 1 - cl((o - .35) / .5);
    for (let y = Math.max(0, cy - R); y < Math.min(H, cy + R); y += cs) for (let x = Math.max(0, cx - R); x < Math.min(W, cx + R); x += cs) {
      const gx = Math.round((x - cx) / cs), gy = Math.round((y - cy) / cs), nx = gx * cs / R, ny = gy * cs / R, d2 = nx * nx + ny * ny;
      if (d2 > 1 || h(gx + 40, gy + 40) > p * 1.35) continue;
      const nz = Math.sqrt(1 - d2), lon = Math.atan2(nx, nz) + rot, lat = Math.asin(ny);
      ctx.globalAlpha = ga * (.3 + .7 * nz);
      cell(cx + gx * cs, cy + gy * cs, cs, lon, lat, gx, gy);
    }
    ctx.globalAlpha = 1;
    return { cx, cy, rot };
  }
  // S — Script globe: every region of the sphere written in a different script
  const SCR = [['EN', 'Latin', 'aemnorstuvw'], ['HI', 'Devanagari', 'अकगजतदनमरवस'], ['JA', 'Kana', 'あかさたなのまやら'], ['KO', 'Hangul', '가나다라마바사아'], ['AR', 'Arabic', 'ابتجدرسعمن'], ['RU', 'Cyrillic', 'бгджзилпфя']];
  V.s = (ctx, W, H, t, p, o) => {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const fr = Math.floor(t / 160), TAU = Math.PI * 2;
    const s = sphere(ctx, W, H, t, p, o, (x, y, cs, lon, lat, gx, gy) => {
      const L = ((lon % TAU) + TAU) % TAU, si = Math.floor(L / TAU * SCR.length) % SCR.length, sc = SCR[si];
      const edge = Math.abs(Math.sin(L / TAU * SCR.length * Math.PI)) < .12;
      if (edge) { ctx.fillStyle = 'rgba(255,231,206,.25)'; ctx.fillRect(x - .5, y - .5, 1, 1); return; }
      const g = sc[2][Math.floor(h(gx, gy + (h(gx, gy) < .1 ? fr : 0)) * sc[2].length)];
      ctx.font = si === 1 ? `11px 'Tiro Devanagari Hindi',serif` : `500 10px ${si === 0 || si === 5 ? MONO : 'sans-serif'}`;
      ctx.fillStyle = h(gx + 3, gy) < .12 ? CREAM : P[si % P.length]; ctx.fillText(g, x, y);
    });
    if (o < .25) {
      const L = ((-s.rot % TAU) + TAU) % TAU, sc = SCR[Math.floor(L / TAU * SCR.length) % SCR.length];
      ctx.globalAlpha = 1 - o * 4; ctx.font = `500 10px ${SANS}`; ctx.fillStyle = CREAM; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(`${sc[0]} · ${sc[1].toUpperCase()}`, s.cx, s.cy + 205); ctx.font = `500 11px ${MONO}`; ctx.fillText(pad(Math.floor(p * 100)), s.cx, s.cy + 224);
      ctx.textAlign = 'left'; ctx.fillText('nua.', 29, H - 22); ctx.globalAlpha = 1;
    }
  };
  // T — Lesson orb: each latitude is a lecture timeline, coloured by lesson part
  V.t = (ctx, W, H, t, p, o) => {
    const TAU = Math.PI * 2;
    const s = sphere(ctx, W, H, t, p, o, (x, y, cs, lon, lat, gx, gy) => {
      const row = gy + 40, L = ((lon % TAU) + TAU) % TAU / TAU;
      let acc = 0, seg = -1;
      for (let k = 0; k < 9; k++) { const len = .06 + h(row, k) * .16; if (L < acc + len) { seg = (L > acc + len - .025) ? -1 : Math.floor(h(row, k + 20) * 5); break; } acc += len; }
      if (seg < 0) { ctx.fillStyle = 'rgba(255,231,206,.18)'; ctx.fillRect(x - 1.5, y - .5, 3, 1); return; }
      if (row % 2) { ctx.fillStyle = 'rgba(255,231,206,.08)'; ctx.fillRect(x - 1.5, y - .5, 3, 1); return; }
      ctx.fillStyle = cl(p * 5 - seg) > .5 ? P[seg] : 'rgba(255,231,206,.3)';
      ctx.fillRect(x - cs / 2, y - cs * .32, cs + .5, cs * .64);
    }, 170);
    if (o < .25) {
      ctx.globalAlpha = 1 - o * 4; ctx.font = `500 9.5px ${SANS}`; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
      let x = 0; const ws = SEG.map((l) => ctx.measureText(l.toUpperCase()).width + 30), tot = ws.reduce((a, b) => a + b, 0) - 18; x = s.cx - tot / 2;
      SEG.forEach((l, k) => { const on = cl(p * 5 - k) > .5; ctx.fillStyle = on ? P[k] : 'rgba(255,231,206,.25)'; ctx.fillRect(x, s.cy + 199, 6, 6); ctx.fillStyle = on ? CREAM : 'rgba(255,231,206,.35)'; ctx.fillText(l.toUpperCase(), x + 11, s.cy + 205); x += ws[k]; });
      ctx.font = `500 11px ${MONO}`; ctx.fillStyle = CREAM; ctx.textAlign = 'center'; ctx.fillText(pad(Math.floor(p * 100)), s.cx, s.cy + 226);
      ctx.textAlign = 'left'; ctx.fillText('nua.', 29, H - 22); ctx.globalAlpha = 1;
    }
  };

  const LIGHT = '#fff3e6', STY = ['Solid', 'ASCII', 'Halftone', 'Outline', 'Lesson', 'Script', 'Pixel'];
  const LECT = [[
    '......##........', '.....####.......', '.....####.......', '......##........', '.......#........', '....######...##.', '...########.##..', '...##.####.##...', '...##.######....', '...##.####......', '...##.####......', '....#.####......', '......####......', '......####......', '......#..#......', '......#..#......', '......#..#......', '......#..#......', '......#..#......', '......#..#......', '.....##..##.....'], [
    '......##........', '.....####.......', '.....####.......', '......##........', '.......#........', '....######......', '...########.....', '...##.####......', '...##.#####.....', '...##.####.##...', '...##.####...##.', '....#.####......', '......####......', '......####......', '......#..#......', '......#..#......', '.....#....#.....', '.....#....#.....', '....#......#....', '....#......#....', '...##......##...']];
  const FLA = ['....#...#....', '...###.###...', '...#######...', '....#####....', '..#########..', '...#######...', '....#####....', '.....###.....', '......#......', '......#......', '......#..##..', '......#.###..', '......##.....', '......#......', '..##..#......', '..###.#......', '....###......', '......#......', '......#......', '......#......', '......#......', '.....###.....'];
  const FLB = FLA.map((r, j) => (j < 9 ? '.' + r.slice(0, -1) : j < 11 ? r : r));
  const HEADA = ['....######.......', '...########......', '..##########.....', '..###########....', '..###########....', '..####.#######...', '..############...', '..###########....', '...##########....', '...#########.....', '...##########....', '....########.....', '.....######......', '.....#####.......', '.....####........', '....######.......', '..##########.....', '.############....'];
  const HEADB = HEADA.map((r, j) => j === 9 ? '...#######.......' : j === 10 ? '...#########..#..' : j === 8 ? '...##########.#..' : j === 7 ? '..###########..#.' : j === 11 ? '....########.#...' : r);
  const SGL = 'aअeकnあmनж';
  function bmp(ctx, rows, x0, y0, cs, sty, t) {
    const at = (j, i) => rows[j] && rows[j][i] === '#';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let j = 0; j < rows.length; j++) for (let i = 0; i < rows[j].length; i++) {
      if (!at(j, i)) continue;
      const x = x0 + i * cs, y = y0 + j * cs, cx = x + cs / 2, cy = y + cs / 2, edge = !(at(j - 1, i) && at(j + 1, i) && at(j, i - 1) && at(j, i + 1));
      if (sty === 0) { ctx.fillStyle = P[2]; ctx.fillRect(x, y, cs + .5, cs + .5); }
      else if (sty === 1) { ctx.fillStyle = INK; ctx.font = `500 ${cs + 1}px ${MONO}`; ctx.fillText('#%@*'[Math.floor(h(i, j + Math.floor(t / 120)) * 4)], cx, cy); }
      else if (sty === 2) { ctx.fillStyle = mix(j / rows.length); ctx.beginPath(); ctx.arc(cx, cy, cs * (.28 + .22 * h(i, j)), 0, Math.PI * 2); ctx.fill(); }
      else if (sty === 3) { if (edge) { ctx.strokeStyle = INK; ctx.lineWidth = 1; ctx.strokeRect(x + .5, y + .5, cs - 1, cs - 1); } }
      else if (sty === 4) { ctx.fillStyle = P[Math.floor(j / rows.length * 5)]; ctx.fillRect(x, y, cs + .5, cs * .7); }
      else if (sty === 5) { ctx.fillStyle = P[2]; ctx.font = `${cs + 2}px 'Tiro Devanagari Hindi',serif`; ctx.fillText(SGL[Math.floor(h(i, j) * SGL.length)], cx, cy); }
      else { ctx.fillStyle = mix(i / rows[j].length); ctx.fillRect(x + 1, y + 1, cs - 2, cs - 2); }
    }
  }
  function light(ctx, W, H, t, p, o, frames, cs, per) {
    ctx.fillStyle = LIGHT; ctx.fillRect(0, 0, W, H);
    const fa = 1 - cl(o / .25), rows = frames[Math.floor(t / per) % frames.length], bw = rows[0].length * cs, bh = rows.length * cs;
    const sty = Math.floor(t / 470) % STY.length, x0 = Math.round(W / 2 - bw / 2), y0 = Math.round(H / 2 - bh / 2 - 14);
    ctx.globalAlpha = fa; bmp(ctx, rows, x0, y0, cs, sty, t);
    ctx.font = `500 9px ${SANS}`; ctx.fillStyle = 'rgba(13,13,3,.55)'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(STY[sty].toUpperCase(), W / 2, y0 + bh + 22); ctx.globalAlpha = 1;
    const by = H - 28, top = lerp(by, 0, eio(cl((o - .2) / .6)));
    if (o > .2) { ctx.fillStyle = INK; ctx.fillRect(0, top, W, H - top); }
    const ba = 1 - cl((o - .5) / .3);
    ctx.globalAlpha = ba; ctx.fillStyle = o > .2 ? 'rgba(255,231,206,.25)' : 'rgba(13,13,3,.14)'; ctx.fillRect(29, top, W - 58, 1);
    ctx.fillStyle = o > .2 ? CREAM : INK; ctx.fillRect(29, top, (W - 58) * p, 1);
    ctx.font = `500 11px ${MONO}`; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'right'; ctx.fillText(pad(Math.floor(p * 100)), W - 29, top - 10);
    ctx.textAlign = 'left'; ctx.fillText('nua.', 29, top - 10); ctx.globalAlpha = 1;
  }
  V.u = (ctx, W, H, t, p, o) => light(ctx, W, H, t, p, o, LECT, 5, 520);
  V.v = (ctx, W, H, t, p, o) => light(ctx, W, H, t, p, o, [FLA, FLB], 5, 380);
  V.w = (ctx, W, H, t, p, o) => light(ctx, W, H, t, p, o, [HEADA, HEADB], 6, 200);

  const KF = {
    down: [{ opacity: 0, transform: 'translateY(-14px)' }, { opacity: 1, transform: 'none' }],
    rise: [{ opacity: 0, transform: 'translateY(16px)' }, { opacity: 1, transform: 'none' }],
    blur: [{ opacity: 0, transform: 'translateY(22px)', filter: 'blur(10px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }],
    scale: [{ opacity: 0, transform: 'scale(1.06)' }, { opacity: 1, transform: 'none' }],
    line: [{ transform: 'scaleY(0)' }, { transform: 'none' }],
  };
  function hide(root) { root.querySelectorAll('[data-r]').forEach((e) => { e.getAnimations().forEach((a) => a.cancel()); e.style.opacity = '0'; }); }
  function reveal(root, slow) {
    const m = slow ? 2.4 : 1, z = slow ? 1.35 : 1;
    root.querySelectorAll('[data-r]').forEach((e) => {
      const kind = e.dataset.r, d = +(e.dataset.d || 0) * m;
      e.style.opacity = '';
      if (kind === 'line') e.style.transformOrigin = 'top';
      e.animate(KF[kind] || KF.rise, { duration: (kind === 'scale' ? 1800 : kind === 'line' ? 1400 : 1000) * z, delay: d, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'backwards' });
    });
  }
  const fontsReady = () => Promise.all([`500 11px ${MONO}`, `500 10px ${SANS}`, `300 52px ${SERIF}`, `italic 400 44px ${SERIF}`, `40px 'Tiro Devanagari Hindi'`].map((f) => document.fonts.load(f).catch(() => {})));

  async function play(root, v) {
    const cv = root.querySelector('canvas[data-loader]'); if (!cv) return;
    const id = (root._nuaRun = (root._nuaRun || 0) + 1);
    hide(root); cv.style.display = 'block';
    await fontsReady(); if (root._nuaRun !== id) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1), W = root.clientWidth, H = root.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr; const ctx = cv.getContext('2d');
    const st = {}, t0 = performance.now(); let shown = false;
    const tick = (now) => {
      if (root._nuaRun !== id) return;
      const t = Math.max(0, now - t0), p = t < L ? prog(t / L) : 1, o = t < L ? 0 : cl((t - L) / O);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      V[v](ctx, W, H, t, p, o, st, root.querySelector('video'));
      if (!shown && o >= (REVEAL_AT[v] || .4)) { shown = true; reveal(root); }
      if (o >= 1) { ctx.clearRect(0, 0, W, H); cv.style.display = 'none'; if (HOLD[v]) setTimeout(() => { if (root._nuaRun === id) reveal(root, true); }, 280); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  function frame(root, v, t) {
    const cv = root.querySelector('canvas[data-loader]'), W = root.clientWidth, H = root.clientHeight;
    cv.style.display = 'block'; cv.width = W; cv.height = H; const ctx = cv.getContext('2d');
    const p = t < L ? prog(t / L) : 1, o = t < L ? 0 : cl((t - L) / O);
    V[v](ctx, W, H, t, p, o, {}, root.querySelector('video')); return [p, o];
  }
  function overlay(v, onDone) {
    const cv = document.createElement('canvas');
    cv.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483000;background:#0d0d03;display:block';
    document.body.appendChild(cv);
    const prevOv = document.documentElement.style.overflow; document.documentElement.style.overflow = 'hidden';
    const ctx = cv.getContext('2d'), st = {}; let W = 0, H = 0, dpr = 1;
    const size = () => { dpr = Math.min(2, window.devicePixelRatio || 1); W = innerWidth; H = innerHeight; cv.width = W * dpr; cv.height = H * dpr; };
    size(); addEventListener('resize', size);
    const total = L + O + (HOLD[v] ? 280 : 0);
    fontsReady().then(() => {
      const t0 = performance.now();
      if (onDone) onDone(total);
      const tick = (now) => {
        const t = Math.max(0, now - t0), p = t < L ? prog(t / L) : 1, o = t < L ? 0 : cl((t - L) / O);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
        V[v](ctx, W, H, t, p, o, st);
        if (t >= total) { removeEventListener('resize', size); cv.remove(); document.documentElement.style.overflow = prevOv; return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }
  window.NuaIntro = { play, reveal, hide, frame, overlay };
})();
