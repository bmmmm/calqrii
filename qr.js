// QR rendering on top of the vendored Nayuki encoder (globalThis.qrcodegen,
// loaded as a classic script before this module runs). Exposes the ECC
// policy, an exact SVG and the module matrix for PNG export.

export const QUIET_ZONE = 4;
export const SOFT_LIMIT_BYTES = 500;    // above: warn, the camera needs a steady hand
export const LOW_ECC_ABOVE_BYTES = 1200; // above: ECC L to keep the version down
export const HARD_LIMIT_BYTES = 2953;   // v40-L byte capacity

const encoder = new TextEncoder();
const ECC_LETTER = ['L', 'M', 'Q', 'H'];

export function utf8Length(text) {
  return encoder.encode(text).length;
}

/** 'MEDIUM' | 'LOW'; throws RangeError('too_big') above the hard limit. */
export function eccFor(bytes) {
  if (bytes > HARD_LIMIT_BYTES) throw new RangeError('too_big');
  return bytes > LOW_ECC_ABOVE_BYTES ? 'LOW' : 'MEDIUM';
}

function lib() {
  const q = globalThis.qrcodegen;
  if (!q || !q.QrCode) throw new Error('qrcodegen missing');
  return q;
}

export function encodeQr(text) {
  const bytes = utf8Length(text);
  const ecc = eccFor(bytes);
  const { QrCode } = lib();
  const qr = QrCode.encodeText(text, QrCode.Ecc[ecc]); // boostEcl stays on
  return {
    qr,
    bytes,
    version: qr.version,
    size: qr.size,
    ecc: ECC_LETTER[qr.errorCorrectionLevel.ordinal],
    large: bytes > SOFT_LIMIT_BYTES,
  };
}

/** Path data of maximal horizontal runs, offset by the quiet zone. */
export function svgPathData(qr, quiet = QUIET_ZONE) {
  const parts = [];
  for (let y = 0; y < qr.size; y++) {
    let x = 0;
    while (x < qr.size) {
      if (!qr.getModule(x, y)) { x++; continue; }
      const x0 = x;
      while (x < qr.size && qr.getModule(x, y)) x++;
      const len = x - x0;
      parts.push(`M${x0 + quiet},${y + quiet}h${len}v1h-${len}z`);
    }
  }
  return parts.join('');
}

/** Presentation attributes only: the page's CSP forbids style="". */
export function svgFromQr(qr) {
  const n = qr.size + 2 * QUIET_ZONE;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${8 * n}" height="${8 * n}" shape-rendering="crispEdges">`
    + `<rect width="${n}" height="${n}" fill="#fff"/><path fill="#000" d="${svgPathData(qr, QUIET_ZONE)}"/></svg>`;
}

export function qrSvg(text) {
  const r = encodeQr(text);
  return { svg: svgFromQr(r.qr), qr: r.qr, bytes: r.bytes, version: r.version, size: r.size, ecc: r.ecc, large: r.large };
}
