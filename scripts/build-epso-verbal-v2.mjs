#!/usr/bin/env node
// Build epso-verbal-v2-v1.json from authored questions + EUR-Lex passages.
//
// Input:   authored/epso-verbal-v2.json    (hand-written MCQ stems + answers)
//          sources/eur-lex/{CELEX}.passages.json  (extracted passages)
// Output:  packs/epso-verbal-v2-v1.json
//
// The authored file references passages by {celex, passageIdx}; this builder
// resolves them, emits the schema-v2 question shape (readingPassage, options,
// explanation, source, sourceUrl, license), computes stable IDs + contentHash.

import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const AUTHORED = join(ROOT, 'authored', 'epso-verbal-v2.json');
const LEX_DIR = join(ROOT, 'sources', 'eur-lex');
const OUT = join(ROOT, 'packs', 'epso-verbal-v2-v1.json');

const PACK_ID = 'epso-verbal-v2';
const VERSION = '1.0.0';

function stableId(seed) {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

async function loadPassages(celex) {
  const path = join(LEX_DIR, `${celex}.passages.json`);
  return JSON.parse(await readFile(path, 'utf8'));
}

async function main() {
  const authored = JSON.parse(await readFile(AUTHORED, 'utf8'));
  const items = authored.items || [];
  if (items.length === 0) {
    console.log('No authored items yet — pack will be empty.');
  }

  // Cache per-CELEX passages so we don't reload for every item
  const lexCache = new Map();
  const questions = [];
  const skipped = [];

  for (const item of items) {
    if (!item.celex || item.passageIdx == null) {
      skipped.push({ item, reason: 'missing celex or passageIdx' });
      continue;
    }
    if (!lexCache.has(item.celex)) lexCache.set(item.celex, await loadPassages(item.celex));
    const lex = lexCache.get(item.celex);
    const passage = lex.passages[item.passageIdx];
    if (!passage) {
      skipped.push({ item, reason: `passage ${item.celex}#${item.passageIdx} not found` });
      continue;
    }
    if (typeof item.correctIdx !== 'number' || !Array.isArray(item.options)) {
      skipped.push({ item, reason: 'missing options or correctIdx' });
      continue;
    }

    const options = item.options.map((label, i) => ({
      label,
      ...(i === item.correctIdx ? { correct: true } : {})
    }));

    questions.push({
      id: stableId(`${PACK_ID}|${item.celex}|${item.passageIdx}|${item.stem}`),
      type: 'reading',
      title: item.title || `EPSO Verbal — ${lex.shortName}`,
      description: item.stem,
      readingPassage: passage.text,
      options,
      explanation: item.explanation || '',
      difficulty: item.difficulty || 'medium',
      tags: item.tags || ['epso', 'verbal', 'eu-law'],
      source: `${lex.source}${item.aiAssisted ? ' · AI-assisted distractors' : ''}`,
      sourceUrl: lex.sourceUrl,
      license: lex.license
    });
  }

  const pack = {
    packId: PACK_ID,
    version: VERSION,
    name: authored.packMeta?.name || 'EPSO Verbal Reasoning — EU Acts',
    description: authored.packMeta?.description || '',
    license: authored.packMeta?.license || 'CC-BY-4.0',
    source: authored.packMeta?.source || 'EUR-Lex passages + hand-authored MCQs',
    updatedAt: new Date().toISOString().slice(0, 10),
    questionCount: questions.length,
    sets: { [PACK_ID]: questions },
    contentHash: ''
  };
  const { contentHash, ...rest } = pack;
  pack.contentHash = 'sha256-' + createHash('sha256').update(JSON.stringify(rest)).digest('hex');

  await writeFile(OUT, JSON.stringify(pack, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${questions.length} questions → ${OUT}`);
  if (skipped.length) {
    console.log(`Skipped ${skipped.length}:`);
    for (const s of skipped) console.log(`  - ${s.reason}`);
  }
  console.log(`contentHash: ${pack.contentHash}`);
}

main().catch(err => {
  console.error('build-epso-verbal-v2 failed:', err);
  process.exit(1);
});
