// Build step: puts the Gemini key from the GEMINI_API_KEY environment variable
// (a GitHub repository secret) into the copied web files, so the key is never in the code.
// Usage: node scripts/insert-key.js <web folder>
const fs = require('fs');
const path = require('path');

const key = process.env.GEMINI_API_KEY || '';
const file = path.join(process.argv[2] || 'www', 'js', 'ai-config.js');
if (!key) {
  console.log('No GEMINI_API_KEY secret: building without the AI helper.');
  process.exit(0);
}
const src = fs.readFileSync(file, 'utf8');
const out = src.replace(/const GEMINI_API_KEY = '[^']*';/, `const GEMINI_API_KEY = ${JSON.stringify(key)};`);
if (out === src) throw new Error(`Key line not found in ${file}`);
fs.writeFileSync(file, out);
console.log(`AI helper key inserted into ${file}.`);
