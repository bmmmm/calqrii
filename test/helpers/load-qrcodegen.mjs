// Evaluates the vendored classic script the way a <script> tag would, so
// `var qrcodegen` lands on globalThis for qr.js to find.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

vm.runInThisContext(readFileSync(new URL('../../qrcodegen.js', import.meta.url), 'utf8'), { filename: 'qrcodegen.js' });
if (!globalThis.qrcodegen) throw new Error('qrcodegen.js did not define globalThis.qrcodegen');
