// Rich clipboard: on macOS, puts HTML and plain text on the clipboard together,
// so Teams / Outlook / Google Chat paste real formatting and plain-text apps
// still get clean text. Elsewhere, plain text only.
const { execFile } = require('child_process');

const hex = (s) => Buffer.from(s, 'utf8').toString('hex');

function writeRich(html, plain) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'darwin') return reject(new Error('rich copy is macOS-only'));
    const doc = `<meta charset="utf-8">${html}`;
    const script = `set the clipboard to {«class HTML»:«data HTML${hex(doc)}», «class utf8»:«data utf8${hex(plain)}»}`;
    execFile('osascript', ['-e', script], { timeout: 5000 }, (err) => (err ? reject(err) : resolve()));
  });
}

module.exports = { writeRich };
