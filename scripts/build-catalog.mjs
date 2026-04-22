#!/usr/bin/env node
// Build catalog.json from every pack in packs/. Run after pack rebuilds.
//
// Output:  catalog.json at repo root
// Format:  { schemaVersion, updatedAt, packs: [{ packId, version, name, ...}] }
//
// Consumed by the extension's client-side fetcher (Phase 4) at whatever URL
// this repo serves from (GitHub Pages or similar). Deterministic: rebuilding
// with unchanged pack set yields byte-identical output.

import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PACKS_DIR = join(ROOT, 'packs');
const OUT = join(ROOT, 'catalog.json');

const SCHEMA_VERSION = 1;

// Map packId → category shown in the Browse view + onboarding interest picker.
// Kept explicit rather than inferred so pack naming conventions can evolve
// without breaking users' interest selections.
const CATEGORY_BY_PACK = {
  'gre-vocab-defmatch':  'gre-vocab',
  'gre-vocab-cloze':     'gre-vocab',
  'epso-samples':        'exam-prep',
  'epso-verbal-v2':      'exam-prep',
  'epso-numerical-v2':   'exam-prep'
};

async function main() {
  const files = (await readdir(PACKS_DIR))
    .filter(f => f.endsWith('.json'))
    .sort();

  const entries = [];
  for (const f of files) {
    const path = join(PACKS_DIR, f);
    const pack = JSON.parse(await readFile(path, 'utf8'));
    const sizeBytes = (await stat(path)).size;
    entries.push({
      packId: pack.packId,
      version: pack.version,
      name: pack.name,
      description: pack.description,
      category: CATEGORY_BY_PACK[pack.packId] || 'general',
      license: pack.license,
      source: pack.source,
      url: `packs/${f}`,
      questionCount: pack.questionCount,
      sizeBytes,
      contentHash: pack.contentHash,
      tier: 'free',
      updatedAt: pack.updatedAt
    });
  }

  const catalog = {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: new Date().toISOString().slice(0, 10),
    packs: entries
  };

  await writeFile(OUT, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${entries.length} pack(s) to ${OUT}`);
}

main().catch(err => {
  console.error('build-catalog failed:', err);
  process.exit(1);
});
