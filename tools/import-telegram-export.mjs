// One-time (or occasional) import of a Telegram Desktop export of the channel into Channel Insights.
// Usage: node tools/import-telegram-export.mjs "/path/to/ChatExport_The IVth Legion/messages.html"
// Safe to re-run: posts are keyed by their Telegram message id.
import fs from 'node:fs';
import { importExport } from '../src/insights.js';

const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error('Usage: node tools/import-telegram-export.mjs <messages.html>'); process.exit(1); }
const n = importExport(fs.readFileSync(file, 'utf8'));
console.log(`Imported ${n} messages from ${file}`);
