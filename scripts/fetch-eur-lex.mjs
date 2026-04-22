#!/usr/bin/env node
// Fetch recent EU acts from Cellar as XHTML, strip to plain text, chunk
// into passage-sized excerpts suitable for EPSO verbal reasoning items.
//
// Usage:  node scripts/fetch-eur-lex.mjs
// Output: sources/eur-lex/{CELEX}.txt          (cleaned plain text, full)
//         sources/eur-lex/{CELEX}.passages.json (array of {idx, text, wordCount})
//
// Licensing: EU legislation is public per Decision 2011/833/EU.
// Content negotiation via Accept header is documented by the Publications
// Office (Cellar) — no scraping workaround needed.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'sources', 'eur-lex');

// Seed set — recent, well-known, high-impact EU acts. Short + self-contained
// recitals and articles tend to make good verbal reasoning passages.
const CELEX_IDS = [
  { id: '32022R2065', shortName: 'Digital Services Act' },
  { id: '32022R1925', shortName: 'Digital Markets Act' },
  { id: '32022R0868', shortName: 'Data Governance Act' },
  { id: '32024R1689', shortName: 'AI Act' },
  { id: '32016R0679', shortName: 'GDPR' }
];

const MIN_WORDS = 180;
const MAX_WORDS = 380;

function stripHtml(html) {
  // Remove script/style/nav chrome, then tags, then collapse whitespace.
  return html
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Split on blank lines, then pack paragraphs into passages sized
// [MIN_WORDS, MAX_WORDS]. Skips tiny boilerplate chunks and headings.
function chunkIntoPassages(text) {
  const paras = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const passages = [];
  let buf = [];
  let wc = 0;

  const flush = () => {
    if (wc >= MIN_WORDS) {
      passages.push({ text: buf.join('\n\n'), wordCount: wc });
    }
    buf = []; wc = 0;
  };

  for (const p of paras) {
    const w = p.split(/\s+/).length;
    // Skip single-line headings + tiny boilerplate
    if (w < 20 && !/[.?!]$/.test(p)) continue;
    if (wc + w > MAX_WORDS && wc >= MIN_WORDS) flush();
    buf.push(p);
    wc += w;
    if (wc >= MAX_WORDS) flush();
  }
  flush();
  return passages.map((p, idx) => ({ idx, ...p }));
}

async function fetchCelex(celex) {
  const url = `https://publications.europa.eu/resource/celex/${celex}`;
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/xhtml+xml',
      'Accept-Language': 'eng',
      'User-Agent': 'hamster-content-pipeline/1.0 (+https://github.com/vrdlouis1/hamster-content)'
    }
  });
  if (!res.ok) throw new Error(`Cellar ${celex} HTTP ${res.status}`);
  return res.text();
}

async function main() {
  if (!existsSync(OUT_DIR)) await mkdir(OUT_DIR, { recursive: true });

  for (const { id, shortName } of CELEX_IDS) {
    const txtPath = join(OUT_DIR, `${id}.txt`);
    const passagesPath = join(OUT_DIR, `${id}.passages.json`);

    let text;
    if (existsSync(txtPath)) {
      text = await readFile(txtPath, 'utf8');
      console.log(`  cached: ${id} (${shortName})`);
    } else {
      console.log(`  fetch:  ${id} (${shortName})`);
      const html = await fetchCelex(id);
      text = stripHtml(html);
      await writeFile(txtPath, text, 'utf8');
    }

    const passages = chunkIntoPassages(text);
    await writeFile(passagesPath, JSON.stringify({
      celex: id,
      shortName,
      source: `EUR-Lex Cellar — CELEX:${id}`,
      sourceUrl: `https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:${id}`,
      license: 'CC-BY-4.0',
      licenseNote: 'EU legislation reusable under Decision 2011/833/EU',
      passageCount: passages.length,
      passages
    }, null, 2) + '\n', 'utf8');
    console.log(`          → ${passages.length} passages`);
  }
  console.log(`\nDone. Raw + chunked passages in: ${OUT_DIR}`);
}

main().catch(err => {
  console.error('fetch-eur-lex failed:', err);
  process.exit(1);
});
