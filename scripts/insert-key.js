// Build step: if the GEMINI_API_KEY environment variable (a GitHub repository secret) is set,
// it replaces the key hard-coded in the copied web files' js/ai-config.js.
// Usage: node scripts/insert-key.js <web folder>
const fs = require('fs');
const path = require('path');

const key = process.env.GEMINI_API_KEY || '';
const file = path.join(process.argv[2] || 'www', 'js', 'ai-config.js');
if (!key) {
  console.log('No GEMINI_API_KEY secret: keeping the key already in js/ai-config.js.');
  process.exit(0);
}
const src = fs.readFileSync(file, 'utf8');
// Accepts either quote style, with or without the trailing semicolon
const KEY_LINE = /const GEMINI_API_KEY\s*=\s*(['"])[^'"]*\1;?/;
if (!KEY_LINE.test(src)) throw new Error(`Key line not found in ${file}`);
const out = src.replace(KEY_LINE, `const GEMINI_API_KEY = ${JSON.stringify(key)};`);
fs.writeFileSync(file, out);
console.log(`AI helper key inserted into ${file}.`);
