#!/usr/bin/env node
// Build epso-numerical-v2-v1.json from authored items + Eurostat tables.
// For each item, loads the referenced table, renders it as a fixed-width
// ASCII table, and embeds it in readingPassage so the extension shows it
// above the stem without any schema changes.

import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const AUTHORED = join(ROOT, 'authored', 'epso-numerical-v2.json');
const ESTAT_DIR = join(ROOT, 'sources', 'eurostat');
const OUT = join(ROOT, 'packs', 'epso-numerical-v2-v1.json');

const PACK_ID = 'epso-numerical-v2';
const VERSION = '1.0.0';

function stableId(seed) {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function renderTable(table) {
  const header = [table.rowDim === 'geo' ? 'Country' : table.rowDim, ...table.columns];
  const body = table.rows.map(r => [
    r[table.rowDim] || r.code,
    ...table.columns.map(c => {
      const v = r.values[c];
      return v == null ? '—' : String(v);
    })
  ]);
  const widths = header.map((_, i) =>
    Math.max(header[i].length, ...body.map(row => row[i].length))
  );
  const fmt = row => row.map((cell, i) => cell.padEnd(widths[i])).join('  ');
  const sep = widths.map(w => '─'.repeat(w)).join('  ');
  return [
    `${table.label}${table.unit ? ` (${table.unit})` : ''}`,
    '',
    fmt(header),
    sep,
    ...body.map(fmt)
  ].join('\n');
}

async function loadTable(dataset) {
  const path = join(ESTAT_DIR, `${dataset}.table.json`);
  return JSON.parse(await readFile(path, 'utf8'));
}

async function main() {
  const authored = JSON.parse(await readFile(AUTHORED, 'utf8'));
  const items = authored.items || [];

  const tableCache = new Map();
  const questions = [];
  const skipped = [];

  for (const item of items) {
    if (!item.dataset) { skipped.push({ item, reason: 'missing dataset' }); continue; }
    if (!tableCache.has(item.dataset)) tableCache.set(item.dataset, await loadTable(item.dataset));
    const table = tableCache.get(item.dataset);

    if (typeof item.correctIdx !== 'number' || !Array.isArray(item.options)) {
      skipped.push({ item, reason: 'missing options or correctIdx' });
      continue;
    }

    const options = item.options.map((label, i) => ({
      label,
      ...(i === item.correctIdx ? { correct: true } : {})
    }));

    questions.push({
      id: stableId(`${PACK_ID}|${item.dataset}|${item.stem}`),
      type: 'reading',
      title: item.title || `EPSO Numerical — ${table.shortName}`,
      description: item.stem,
      readingPassage: renderTable(table),
      options,
      explanation: item.explanation || '',
      difficulty: item.difficulty || 'medium',
      tags: item.tags || ['epso', 'numerical', 'eurostat'],
      source: `${table.source} (${table.dataset})${item.aiAssisted ? ' · AI-assisted distractors' : ''}`,
      sourceUrl: table.sourceUrl,
      license: table.license
    });
  }

  const pack = {
    packId: PACK_ID,
    version: VERSION,
    name: authored.packMeta?.name || 'EPSO Numerical Reasoning — Eurostat Tables',
    description: authored.packMeta?.description || '',
    license: authored.packMeta?.license || 'CC-BY-4.0',
    source: authored.packMeta?.source || 'Eurostat tables + hand-authored MCQs',
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
  console.error('build-epso-numerical-v2 failed:', err);
  process.exit(1);
});
