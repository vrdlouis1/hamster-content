#!/usr/bin/env node
// Fetch definitions for every word in a word list and cache them under
// sources/definitions/. Writes one JSON file per word, exactly as returned
// by dictionaryapi.dev (which in turn pulls from Wiktionary and preserves
// the CC BY-SA 3.0 license + sourceUrls in the payload).
//
// Commit the cache so builds are reproducible without network. Re-run this
// script to refresh the snapshot.
//
// Usage: node scripts/fetch-definitions.mjs [--force]
//   --force  re-fetch even if cached

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const WORD_LIST = join(ROOT, 'word-lists', 'gre-high-freq.json');
const CACHE_DIR = join(ROOT, 'sources', 'definitions');
const API = 'https://api.dictionaryapi.dev/api/v2/entries/en/';
const FORCE = process.argv.includes('--force');
const RATE_MS = 500; // 2 req/s — conservative under api rate limits
const MAX_RETRIES = 4;

async function fileExists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function fetchOne(word, attempt = 0) {
  const res = await fetch(API + encodeURIComponent(word));
  if (res.status === 404) return { notFound: true };
  if (res.status === 429 && attempt < MAX_RETRIES) {
    const backoff = Math.min(8000, 1000 * Math.pow(2, attempt));
    await new Promise(r => setTimeout(r, backoff));
    return fetchOne(word, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${word}`);
  return await res.json();
}

async function main() {
  await mkdir(CACHE_DIR, { recursive: true });
  const raw = await readFile(WORD_LIST, 'utf8');
  const list = JSON.parse(raw);
  const words = (list.words || []).map(w => w.word);

  let fetched = 0, cached = 0, missing = 0, errors = 0;
  for (const word of words) {
    const path = join(CACHE_DIR, `${word}.json`);
    if (!FORCE && await fileExists(path)) { cached++; continue; }
    try {
      const data = await fetchOne(word);
      if (data.notFound) {
        await writeFile(path, JSON.stringify({ word, notFound: true }, null, 2) + '\n');
        missing++;
        console.warn(`  [404] ${word}`);
      } else {
        await writeFile(path, JSON.stringify(data, null, 2) + '\n');
        fetched++;
      }
    } catch (err) {
      errors++;
      console.error(`  [err] ${word}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, RATE_MS));
  }
  console.log(`Done. fetched=${fetched} cached=${cached} missing=${missing} errors=${errors}`);
}

main().catch(err => { console.error(err); process.exit(1); });
