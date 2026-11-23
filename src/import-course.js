// Load the Academy course from a local HTML file (made from the .docx by scripts/docx_to_html.py):
//   node src/import-course.js tech /path/course.html
// On the server: copy the HTML into the container and run the same command with docker exec.
import fs from 'node:fs';
import { importCourseHTML } from './education.js';
const [id, file] = process.argv.slice(2);
if (!id || !file) { console.error('Usage: node src/import-course.js <course id> <file.html>'); process.exit(1); }
console.log(importCourseHTML(id, fs.readFileSync(file, 'utf8')));
