#!/usr/bin/env node
// Build the GRE vocabulary definition-match pack from Wiktionary-backed
// cached data.
//
// Inputs:
//   word-lists/gre-high-freq.json           (curated word selection)
//   sources/definitions/{word}.json         (cached dictionaryapi.dev /
//                                            Wiktionary responses)
//
// Output:
//   packs/gre-vocab-defmatch-v1.json
//
// Generation is deterministic: rebuilding with unchanged inputs produces
// byte-identical output. IDs are seeded from word+type so SM-2 state
// survives rebuilds.

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const WORD_LIST = join(ROOT, 'word-lists', 'gre-high-freq.json');
const DEFS_DIR = join(ROOT, 'sources', 'definitions');
const OUT = join(ROOT, 'packs', 'gre-vocab-defmatch-v1.json');

const PACK_ID = 'gre-vocab-defmatch';
const PACK_VERSION = '1.0.0';
const SET_KEY = 'gre-vocab-defmatch';
const LICENSE = 'CC-BY-SA-3.0'; // Wiktionary's license propagates to derivatives
const SOURCE = 'Wiktionary (via dictionaryapi.dev) — word selection from public GRE frequency lists';
const DISTRACTOR_COUNT = 3;

// Senses with these leading parenthetical tags are ignored — they're
// archaic, hyper-specialized, or otherwise not the GRE-test sense.
const EXCLUDE_TAGS = [
  'obsolete', 'archaic', 'rare', 'dated', 'historical', 'dialectal',
  'nautical', 'botany', 'zoology', 'anatomy', 'astrology', 'heraldry',
  'sculpture', 'chemistry specific', 'medicine specific'
];
const EXCLUDE_RE = new RegExp(`^\\(\\s*(${EXCLUDE_TAGS.join('|')})[^)]*\\)`, 'i');

// Deterministic 32-char UUID from a seed string.
function stableId(seed) {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// Seeded mulberry32 PRNG — reproducible "random" selections.
function prng(seedStr) {
  let a = 0;
  for (let i = 0; i < seedStr.length; i++) a = (a * 31 + seedStr.charCodeAt(i)) | 0;
  return function() {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Pick the best GRE-test sense for a word from its Wiktionary entry.
// Heuristic (in order):
//   1. Match POS hint (verb / noun / adjective)
//   2. Exclude obsolete/archaic/specialized senses (EXCLUDE_RE)
//   3. If `senseHint` given: only keep senses whose definition contains it
//   4. Prefer earlier position in Wiktionary's ordering — canonical senses
//      list first. This beats "shortest" which tends to pick circular or
//      weirdly-specific definitions.
//   5. Tiebreak: shortest definition in the 20–150 char goldilocks band.
//
// Returns { definition, example, sourceUrl } or null if nothing usable.
function pickBestSense(wiktResponse, posHint, senseHint) {
  if (!Array.isArray(wiktResponse)) return null;
  const candidates = [];
  let position = 0;
  for (const entry of wiktResponse) {
    const sourceUrls = entry.sourceUrls || [];
    const sourceUrl = sourceUrls[0] || '';
    for (const m of entry.meanings || []) {
      const pos = (m.partOfSpeech || '').toLowerCase();
      if (posHint && pos !== posHint.toLowerCase()) continue;
      for (const d of m.definitions || []) {
        const defn = (d.definition || '').trim();
        if (!defn) continue;
        if (EXCLUDE_RE.test(defn)) continue;
        const cleaned = defn.replace(/^\(\s*[^)]+\)\s*/, '').trim();
        if (!cleaned) continue;
        if (senseHint && !cleaned.toLowerCase().includes(senseHint.toLowerCase())) continue;
        candidates.push({
          definition: cleaned,
          example: d.example || '',
          sourceUrl,
          position: position++,
          length: cleaned.length,
          hasExample: !!d.example
        });
      }
    }
  }
  if (candidates.length === 0) return null;
  // Primary sort: position ascending (canonical senses first).
  // Tiebreak: prefer with example, then goldilocks length, then shortest.
  candidates.sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    if (a.hasExample !== b.hasExample) return b.hasExample - a.hasExample;
    const aGood = a.length >= 20 && a.length <= 150 ? 1 : 0;
    const bGood = b.length >= 20 && b.length <= 150 ? 1 : 0;
    if (aGood !== bGood) return bGood - aGood;
    return a.length - b.length;
  });
  return candidates[0];
}

async function loadDefinitions(wordList) {
  const files = await readdir(DEFS_DIR);
  const byWord = new Map();
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const word = f.replace(/\.json$/, '');
    const raw = await readFile(join(DEFS_DIR, f), 'utf8');
    byWord.set(word, JSON.parse(raw));
  }
  return byWord;
}

function pickDistractors(pool, excludeWord, rand, n) {
  const out = [];
  const seen = new Set([excludeWord]);
  const idx = pool.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  for (const i of idx) {
    if (out.length >= n) break;
    const w = pool[i];
    if (!seen.has(w)) { out.push(w); seen.add(w); }
  }
  return out;
}

function buildQuestion(entry, validWords, sense, rand) {
  const distractors = pickDistractors(validWords.filter(w => w !== entry.word), entry.word, rand, DISTRACTOR_COUNT);
  const optionsRaw = [
    { label: entry.word, correct: true },
    ...distractors.map(d => ({ label: d }))
  ];
  const optIdx = optionsRaw.map((_, i) => i);
  for (let i = optIdx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [optIdx[i], optIdx[j]] = [optIdx[j], optIdx[i]];
  }
  const options = optIdx.map(i => optionsRaw[i]);

  const explanationParts = [`${entry.word} (${entry.pos}): ${sense.definition}`];
  if (sense.example) explanationParts.push(`Example: ${sense.example}`);
  const explanation = explanationParts.join('\n\n');

  return {
    id: stableId(`${PACK_ID}|${SET_KEY}|${entry.word}`),
    type: 'mcq',
    title: 'GRE Vocabulary',
    description: `Which word means: "${sense.definition}"?`,
    options,
    explanation,
    difficulty: entry.difficulty || 'medium',
    tags: ['gre', 'vocab', 'defmatch', 'high-freq'],
    source: SOURCE,
    sourceUrl: sense.sourceUrl || `https://en.wiktionary.org/wiki/${encodeURIComponent(entry.word)}`,
    license: LICENSE
  };
}

async function main() {
  const raw = await readFile(WORD_LIST, 'utf8');
  const list = JSON.parse(raw);
  const defs = await loadDefinitions(list.words);

  // First pass: pick sense for each word. Drop any word where no usable
  // sense exists (too noisy to include).
  const picked = [];
  const skipped = [];
  for (const entry of list.words) {
    const data = defs.get(entry.word);
    if (!data || data.notFound) {
      skipped.push({ word: entry.word, reason: 'not in Wiktionary' });
      continue;
    }
    const sense = pickBestSense(data, entry.pos, entry.senseHint);
    if (!sense) {
      skipped.push({ word: entry.word, reason: `no non-excluded ${entry.pos} sense` });
      continue;
    }
    picked.push({ entry, sense });
  }

  if (picked.length < 4) {
    throw new Error(`Too few usable words (${picked.length}); need >=4 for MCQ distractors.`);
  }

  const validWordSet = picked.map(p => p.entry.word);

  const questions = [];
  for (const { entry, sense } of picked) {
    const rand = prng(`${PACK_ID}|${entry.word}`);
    questions.push(buildQuestion(entry, validWordSet, sense, rand));
  }

  // ID uniqueness
  const idSet = new Set();
  for (const q of questions) {
    if (idSet.has(q.id)) throw new Error(`Duplicate ID: ${q.id}`);
    idSet.add(q.id);
  }

  const pack = {
    packId: PACK_ID,
    version: PACK_VERSION,
    name: 'GRE High-Frequency Vocabulary — Definition Match',
    description: `"Which word means X?" MCQs over ${questions.length} high-frequency GRE words. Definitions from Wiktionary (CC BY-SA 3.0), word selection compiled from public GRE frequency lists.`,
    contributor: 'Hamster team',
    source: SOURCE,
    license: LICENSE,
    updatedAt: new Date().toISOString().slice(0, 10),
    questionCount: questions.length,
    sets: { [SET_KEY]: questions },
    contentHash: ''
  };

  const { contentHash, ...rest } = pack;
  pack.contentHash = 'sha256-' + createHash('sha256').update(JSON.stringify(rest)).digest('hex');

  await writeFile(OUT, JSON.stringify(pack, null, 2) + '\n', 'utf8');
  console.log(`Built ${questions.length} questions → ${OUT}`);
  if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length}:`);
    for (const s of skipped) console.log(`  - ${s.word}: ${s.reason}`);
  }
  console.log(`contentHash: ${pack.contentHash}`);
}

main().catch(err => {
  console.error('build-gre-vocab failed:', err);
  process.exit(1);
});
