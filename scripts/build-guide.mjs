// Bundles dm-guide.md into the Edge Function (which can't read repo files at runtime).
// Run after editing dm-guide.md:  npm run build:guide
import fs from 'node:fs';

const md = fs.readFileSync(new URL('../dm-guide.md', import.meta.url), 'utf8');
const out = `// GENERATED from dm-guide.md by scripts/build-guide.mjs. Edit dm-guide.md, then run: npm run build:guide\nexport const DM_GUIDE = ${JSON.stringify(md)};\n`;
fs.writeFileSync(new URL('../supabase/functions/solo-dnd/core/guide.js', import.meta.url), out);
console.log(`guide.js written (${md.length} chars)`);
