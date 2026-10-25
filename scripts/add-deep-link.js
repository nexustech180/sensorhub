// Build step: lets goldvar:// links open the Android app (goldvar://open, goldvar://live, ...).
// Adds a VIEW intent filter for the "goldvar" scheme to MainActivity in the generated
// Capacitor project. Safe to run twice. Usage: node scripts/add-deep-link.js [manifest path]
const fs = require('fs');

const file = process.argv[2] || 'android/app/src/main/AndroidManifest.xml';
const SCHEME = 'goldvar';
const src = fs.readFileSync(file, 'utf8');
if (src.includes(`android:scheme="${SCHEME}"`)) {
  console.log(`${SCHEME}:// links already enabled in ${file}`);
  process.exit(0);
}
const start = src.search(/<activity\b[^>]*android:name="\.?MainActivity"/);
const end = start < 0 ? -1 : src.indexOf('</activity>', start);
if (end < 0) throw new Error(`MainActivity not found in ${file}`);
const filter = `
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="${SCHEME}" />
            </intent-filter>
        `;
fs.writeFileSync(file, src.slice(0, end) + filter.trimStart().replace(/^/, '    ') + '\n        ' + src.slice(end));
console.log(`${SCHEME}:// links enabled in ${file}`);
