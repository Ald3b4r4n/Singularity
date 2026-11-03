const fs = require('fs');
const path = require('path');
const { icon } = require('./icon-gen.js');
const out = path.join(__dirname, 'svg');
fs.mkdirSync(out, { recursive: true });
const files = {
  'event-minimal-tile-dark-256.svg': { size: 256, kind: 'tile', mode: 'dark' },
  'event-minimal-tile-light-256.svg': { size: 256, kind: 'tile', mode: 'light' },
  'event-minimal-mark-dark-256.svg': { size: 256, kind: 'mark', mode: 'dark' },
  'event-minimal-mark-light-256.svg': { size: 256, kind: 'mark', mode: 'light' },
  'event-minimal-mono-white-256.svg': { size: 256, kind: 'mono', mode: 'dark', color: '#FFFFFF' },
  'event-minimal-mono-black-256.svg': { size: 256, kind: 'mono', mode: 'light', color: '#000000' },
  'event-minimal-tile-dark-48.svg': { size: 48, kind: 'tile', mode: 'dark' },
  'event-minimal-tile-dark-32.svg': { size: 32, kind: 'tile', mode: 'dark' },
  'event-minimal-tile-dark-24.svg': { size: 24, kind: 'tile', mode: 'dark' },
  'event-minimal-tile-dark-16.svg': { size: 16, kind: 'tile', mode: 'dark' }
};
for (const [name, o] of Object.entries(files)) {
  fs.writeFileSync(path.join(out, name), icon(o).replace('role="img" aria-label="Singularity IDE">', 'role="img" aria-label="Singularity IDE"><title>Singularity IDE - Event Minimal</title>') + '\n');
}
console.log(Object.keys(files).length + ' arquivos SVG gerados em ' + out);
