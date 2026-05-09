const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const requiredFiles = [
  'package.json',
  'phantom-browser-ui.html',
  'src/main/index.js',
  'src/main/preload.js',
  'src/shared/link-sanitiser.js'
];

for (const relativePath of requiredFiles) {
  assert.equal(
    fs.existsSync(path.join(root, relativePath)),
    true,
    `Missing required file: ${relativePath}`
  );
}

console.log('Ram Browser project scaffold is present.');
