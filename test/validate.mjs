import assert from 'node:assert/strict';
import fs from 'node:fs';
const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url)));
assert.equal(manifest.generate_interceptor, 'SD_ProcessTriggers');
for (const file of [manifest.js, manifest.css, 'settings.html', 'button.html', 'dropdown.html', 'README.md', 'LICENSE']) assert.ok(fs.existsSync(new URL(`../${file}`, import.meta.url)), file);
