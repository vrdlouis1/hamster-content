#!/usr/bin/env node
// Build the GRE vocabulary CLOZE pack from Wiktionary-cached example sentences.
//
// Inputs:
//   word-lists/gre-high-freq.json
//   sources/definitions/{word}.json
//
// Output:
//   packs/gre-vocab-cloze-v1.json
//
// Format:
//   Passage:    "The thieves ____ with our property."
//   Options:    abscond | burgeon | brook | efficacious
//   Correct:    abscond
//
// Only words whose GRE-appropriate Wiktionary sense ALSO has a usable example
// sentence produce a cloze question. Distractors are drawn from other words
// with the same POS so options are grammatically plausible.
//
// Build is deterministic. IDs are SHA-256-seeded from (pack, set, word) so
// regenerating with unchanged inputs yields byte-identical output and
// existing SM-2 state survives rebuilds.

import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const WORD_LIST = join(ROOT, 'word-lists', 'gre-high-freq.json');
const DEFS_DIR = join(ROOT, 'sources', 'definitions');
const OUT = join(ROOT, 'packs', 'gre-vocab-cloze-v1.json');

const PACK_ID = 'gre-vocab-cloze';
const PACK_VERSION = '1.0.0';
const SET_KEY = 'gre-vocab-cloze';
const LICENSE = 'CC-BY-SA-3.0';
const SOURCE = 'Wiktionary example sentences (via dictionaryapi.dev) — word selection from public GRE frequency lists';
const DISTRACTOR_COUNT = 3;
const MIN_EXAMPLE_LEN = 25;  // drop phrases like "arcane rituals" (too short to cloze)
const MAX_EXAMPLE_LEN = 250;

// Same tag-exclusion regex as the defmatch builder.
const EXCLUDE_TAGS = [
  'obsolete','archaic','rare','dated','historical','dialectal',
  'nautical','botany','zoology','anatomy','astrology','heraldry','sculpture'
];
const EXCLUDE_RE = new RegExp(`^\\(\\s*(${EXCLUDE_TAGS.join('|')})`, 'i');

function stableId(seed) {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

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

// Common inflection patterns. Replaces the first occurrence of the word (or
// a recognised inflection) with the cloze marker. Returns { sentence, form }
// where `form` is the inflected form we replaced — used for the correct
// option label so options match the sentence's grammar.
function applyCloze(sentence, word) {
  const forms = [
    word,
    word + 's',
    word + 'es',
    word + 'ed',
    word + 'd',            // "absconded" from "abscond" uses +ed, but "belied" uses +d
    word + 'ing',
    word + 'ly',
    word.endsWith('y') ? word.slice(0, -1) + 'ied' : null, // belie → belied
    word.endsWith('y') ? word.slice(0, -1) + 'ies' : null,
    word.endsWith('e') ? word.slice(0, -1) + 'ing' : null, // burgeon → burgeoning (OK above)
    word.endsWith('e') ? word.slice(0, -1) + 'ed' : null,  // burgeon → burgeoned
    word + 'ness',
  ].filter(Boolean);
  // Longest first so "abated" beats "abate" when both would match.
  forms.sort((a, b) => b.length - a.length);
  for (const f of forms) {
    const re = new RegExp(`\\b${f}\\b`, 'gi');
    const firstMatch = sentence.match(re);
    if (firstMatch) {
      return {
        sentence: sentence.replace(re, '____'),
        form: firstMatch[0]
      };
    }
  }
  return null;
}

function pickSenseWithExample(wiktResponse, posHint, senseHint) {
  if (!Array.isArray(wiktResponse)) return null;
  const candidates = [];
  for (const entry of wiktResponse) {
    const sourceUrls = entry.sourceUrls || [];
    const sourceUrl = sourceUrls[0] || '';
    for (const m of entry.meanings || []) {
      if (posHint && (m.partOfSpeech || '').toLowerCase() !== posHint.toLowerCase()) continue;
      for (const d of m.definitions || []) {
        const defn = (d.definition || '').trim();
        if (!defn) continue;
        if (EXCLUDE_RE.test(defn)) continue;
        const cleaned = defn.replace(/^\(\s*[^)]+\)\s*/, '').trim();
        if (senseHint && !cleaned.toLowerCase().includes(senseHint.toLowerCase())) continue;
        const ex = (d.example || '').trim();
        if (!ex) continue;
        if (ex.length < MIN_EXAMPLE_LEN || ex.length > MAX_EXAMPLE_LEN) continue;
        candidates.push({ definition: cleaned, example: ex, sourceUrl });
      }
    }
  }
  return candidates[0] || null;
}

async function loadDefinitions() {
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(DEFS_DIR);
  const byWord = new Map();
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    byWord.set(f.replace(/\.json$/, ''), JSON.parse(await readFile(join(DEFS_DIR, f), 'utf8')));
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

async function main() {
  const list = JSON.parse(await readFile(WORD_LIST, 'utf8'));
  const defs = await loadDefinitions();

  // For each word, pick a sense whose GRE meaning has a usable example.
  const picked = [];
  const skipped = [];
  for (const entry of list.words) {
    const data = defs.get(entry.word);
    if (!data) { skipped.push({ word: entry.word, reason: 'not cached' }); continue; }
    const sense = pickSenseWithExample(data, entry.pos, entry.senseHint);
    if (!sense) { skipped.push({ word: entry.word, reason: 'no example for GRE sense' }); continue; }
    const cloze = applyCloze(sense.example, entry.word);
    if (!cloze) { skipped.push({ word: entry.word, reason: 'word not found in example (inflection miss)' }); continue; }
    picked.push({ entry, sense, cloze });
  }

  if (picked.length < 4) {
    throw new Error(`Too few cloze-eligible words (${picked.length}); need >=4 for MCQ.`);
  }

  // Build distractor pool PER POS — grammatically matching options.
  const byPos = {};
  for (const p of picked) {
    const pos = p.entry.pos;
    (byPos[pos] ||= []).push(p.entry.word);
  }

  const questions = [];
  for (const { entry, sense, cloze } of picked) {
    const rand = prng(`${PACK_ID}|${entry.word}`);
    const samePosPool = byPos[entry.pos] || [];
    // If we don't have enough same-POS distractors, fall back to any picked word.
    const fallbackPool = samePosPool.length < DISTRACTOR_COUNT + 1
      ? picked.map(p => p.entry.word)
      : samePosPool;
    const distractors = pickDistractors(fallbackPool, entry.word, rand, DISTRACTOR_COUNT);
    const rawOpts = [
      { label: entry.word, correct: true },
      ...distractors.map(d => ({ label: d }))
    ];
    const optIdx = rawOpts.map((_, i) => i);
    for (let i = optIdx.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [optIdx[i], optIdx[j]] = [optIdx[j], optIdx[i]];
    }
    const options = optIdx.map(i => rawOpts[i]);

    questions.push({
      id: stableId(`${PACK_ID}|${SET_KEY}|${entry.word}`),
      type: 'cloze',
      title: 'GRE Vocabulary (cloze)',
      description: `Which word, in the appropriate form, completes the sentence?\n\n"${cloze.sentence}"`,
      options,
      explanation: `${entry.word} (${entry.pos}): ${sense.definition}\n\nOriginal form in sentence: ${cloze.form}`,
      difficulty: entry.difficulty || 'medium',
      tags: ['gre', 'vocab', 'cloze', 'high-freq'],
      source: SOURCE,
      sourceUrl: sense.sourceUrl || `https://en.wiktionary.org/wiki/${encodeURIComponent(entry.word)}`,
      license: LICENSE
    });
  }

  // Dedupe
  const idSet = new Set();
  for (const q of questions) {
    if (idSet.has(q.id)) throw new Error(`Duplicate ID: ${q.id}`);
    idSet.add(q.id);
  }

  const pack = {
    packId: PACK_ID,
    version: PACK_VERSION,
    name: 'GRE High-Frequency Vocabulary — Cloze',
    description: `"Fill-in-the-blank" MCQs over ${questions.length} high-frequency GRE words. Sentences are authentic Wiktionary examples (CC BY-SA 3.0); distractors are other GRE words of the same part of speech.`,
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
  console.log(`Built ${questions.length} cloze questions → ${OUT}`);
  if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length}:`);
    for (const s of skipped.slice(0, 8)) console.log(`  - ${s.word}: ${s.reason}`);
    if (skipped.length > 8) console.log(`  ...and ${skipped.length - 8} more`);
  }
  console.log(`contentHash: ${pack.contentHash}`);
}

main().catch(err => {
  console.error('build-gre-cloze failed:', err);
  process.exit(1);
});
