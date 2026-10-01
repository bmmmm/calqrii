// Page-side half of the browser gate (see run.mjs). Evaluated into the page
// over CDP (Runtime.evaluate bypasses the page CSP for the evaluation itself;
// the rasterized codes are data: URIs, which the page's img-src allows).
// Defines globalThis.__probe: probePanels (round trip of every rendered code,
// optional scale/blur sweep), eccAlternatives, qrWidth, selfTest.
(() => {
  const enc = new TextEncoder();
  const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join(' ');
  let detector = null;
  const det = () => (detector ||= new BarcodeDetector({ formats: ['qr_code'] }));

  function loadSvg(svgText) {
    return new Promise((ok, bad) => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = () => bad(new Error('svg image load failed'));
      const b = enc.encode(svgText);
      let bin = '';
      for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      img.src = 'data:image/svg+xml;base64,' + btoa(bin);
    });
  }

  function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

  /** Native raster: the SVG at its own width/height (8 px per module), white background. */
  async function nativeRaster(svgText) {
    const img = await loadSvg(svgText);
    const w = img.naturalWidth, h = img.naturalHeight;
    const c = canvas(w, h);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return { img, c, w };
  }

  /**
   * mode 'bitmap': the native raster downscaled with smoothing (non-integer module
   * pitch, grey edge pixels — what a camera sample of a screen looks like);
   * mode 'vector': the SVG image drawn straight at the target size (Chrome
   * re-rasterizes the vector, modules snap to pixels).
   */
  function scaled(src, width, blur, mode) {
    const c = canvas(width, width);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, width);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (blur) ctx.filter = `blur(${blur}px)`;
    ctx.drawImage(mode === 'vector' ? src.img : src.c, 0, 0, width, width);
    return c;
  }

  function compare(expected, raw) {
    const a = enc.encode(expected), b = enc.encode(raw);
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (i === a.length && i === b.length) return { ok: true, expectedBytes: a.length, decodedBytes: b.length };
    const lo = Math.max(0, i - 16);
    return {
      ok: false, expectedBytes: a.length, decodedBytes: b.length, firstDiff: i,
      expectedHex: hex(a.subarray(lo, i + 16)), decodedHex: hex(b.subarray(lo, i + 16)),
      expectedText: new TextDecoder().decode(a.subarray(lo, i + 16)),
      decodedText: new TextDecoder().decode(b.subarray(lo, i + 16)),
    };
  }

  async function detectText(c) {
    const r = await det().detect(c);
    return { n: r.length, raw: r.length ? r[0].rawValue : null };
  }

  const WIDTHS = [352, 300, 260, 220, 190, 160, 140, 120, 100, 90, 80];
  const BLURS = [0, 0.6, 1.2];

  async function sweep(svgText, expected, modes = ['bitmap', 'vector']) {
    const src = await nativeRaster(svgText);
    const out = {};
    for (const mode of modes) {
      out[mode] = {};
      for (const blur of BLURS) {
        const row = [];
        for (const w of WIDTHS) {
          const d = await detectText(scaled(src, w, blur, mode));
          row.push({ w, ok: d.raw !== null && d.raw === expected, found: d.n });
        }
        const okW = row.filter((r) => r.ok).map((r) => r.w);
        // contiguous: smallest width such that it and every larger width decoded
        let contiguous = null;
        for (const r of row) { if (r.ok) contiguous = r.w; else break; }
        out[mode]['blur' + blur] = { minWidth: okW.length ? Math.min(...okW) : null, contiguousMin: contiguous, row };
      }
    }
    return out;
  }

  /** Every visible rendered code in the editor (list + combined panel). */
  async function probePanels(opts = {}) {
    const res = [];
    const panels = [...document.querySelectorAll('[data-qr-panel]')].filter((p) => !p.closest('#view-section') && p.querySelector('.qr svg'));
    const qr = await import(new URL('./qr.js', location.href).href);
    for (const p of panels) {
      const svg = p.querySelector('.qr svg');
      const text = p.querySelector('pre.qr-text').textContent;
      const meta = p.querySelector('.qr-meta').textContent;
      const re = qr.encodeQr(text);
      const svgText = new XMLSerializer().serializeToString(svg);
      const src = await nativeRaster(svgText);
      const d = await detectText(src.c);
      const entry = {
        where: p.closest('#combined-panel') ? 'combined' : 'event',
        title: p.closest('li')?.querySelector('.ev-title')?.textContent ?? '(combined)',
        bytes: re.bytes, version: re.version, size: re.size, ecc: re.ecc, meta,
        nativeWidth: src.w, detections: d.n,
        roundTrip: d.raw === null ? { ok: false, error: 'no detection' } : compare(text, d.raw),
        text,
      };
      if (opts.sweep) entry.sweep = await sweep(svgText, text);
      res.push(entry);
    }
    return res;
  }

  /** The same text at every ECC level (boostEcl off, so the level is the asked one), same sweep. */
  async function eccAlternatives(text) {
    const q = globalThis.qrcodegen.QrCode;
    const { svgFromQr, encodeQr } = await import(new URL('./qr.js', location.href).href);
    const policy = encodeQr(text);
    const out = { bytes: policy.bytes, policy: { ecc: policy.ecc, version: policy.version }, levels: {} };
    for (const L of ['LOW', 'MEDIUM', 'QUARTILE', 'HIGH']) {
      let code;
      try {
        code = q.encodeSegments(globalThis.qrcodegen.QrSegment.makeSegments(text), q.Ecc[L], 1, 40, -1, false);
      } catch (e) { out.levels[L] = { fits: false, error: String(e.message || e) }; continue; }
      const svgText = svgFromQr(code);
      const src = await nativeRaster(svgText);
      const d = await detectText(src.c);
      out.levels[L] = {
        fits: true, version: code.version, size: code.size,
        modulePxAt352: +(352 / (code.size + 8)).toFixed(2),
        native: d.raw === null ? { ok: false, error: 'no detection' } : compare(text, d.raw),
        sweep: await sweep(svgText, text),
      };
    }
    return out;
  }

  function qrWidth() {
    const svgs = [...document.querySelectorAll('.qr svg')].filter((s) => !s.closest('#view-section'));
    return {
      dpr: devicePixelRatio, innerWidth,
      codes: svgs.map((svg) => {
        const r = svg.getBoundingClientRect();
        const n = +svg.getAttribute('viewBox').split(' ')[2];
        return { cssWidth: +r.width.toFixed(2), modules: n, cssPxPerModule: +(r.width / n).toFixed(3), devicePxPerModule: +(r.width * devicePixelRatio / n).toFixed(3) };
      }),
    };
  }

  /** Mutation checks of the probe itself: a wrong expected text must read as mismatch, a blank canvas as no detection. */
  async function selfTest() {
    const p = [...document.querySelectorAll('[data-qr-panel]')].find((x) => !x.closest('#view-section') && x.querySelector('.qr svg'));
    const text = p.querySelector('pre.qr-text').textContent;
    const src = await nativeRaster(new XMLSerializer().serializeToString(p.querySelector('.qr svg')));
    const d = await detectText(src.c);
    const mutated = text.slice(0, 40) + (text[40] === 'X' ? 'Y' : 'X') + text.slice(41);
    const blank = canvas(400, 400); const bctx = blank.getContext('2d'); bctx.fillStyle = '#fff'; bctx.fillRect(0, 0, 400, 400);
    const b = await detectText(blank);
    const sw = await sweep(new XMLSerializer().serializeToString(p.querySelector('.qr svg')), mutated, ['bitmap']);
    return {
      genuine: compare(text, d.raw).ok,
      mutatedTextFlagged: !compare(mutated, d.raw).ok,
      mutatedFirstDiff: compare(mutated, d.raw).firstDiff,
      blankNoDetection: b.n === 0,
      sweepAgainstMutatedAllFail: Object.values(sw.bitmap).every((x) => x.minWidth === null),
    };
  }

  globalThis.__probe = { probePanels, eccAlternatives, qrWidth, selfTest, WIDTHS, BLURS };
  return 'probe ready';
})();
