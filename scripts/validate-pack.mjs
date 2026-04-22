#!/usr/bin/env node
// Validate a content pack against Hamster's v2 schema.
//
// Usage: node scripts/validate-pack.mjs packs/gre-vocab-defmatch-v1.json

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const QUESTION_TYPES = ['mcq', 'flashcard', 'cloze', 'reading'];
const DIFFICULTY_LEVELS = ['easy', 'medium', 'hard'];

function validateQuestion(q, where) {
  const errs = [];
  if (!q || typeof q !== 'object') { errs.push(`${where}: not an object`); return errs; }
  if (!q.id || typeof q.id !== 'string') errs.push(`${where}: id missing/invalid`);
  if (!q.type || !QUESTION_TYPES.includes(q.type)) errs.push(`${where}: type must be one of ${QUESTION_TYPES.join(', ')}`);
  if (!q.description || typeof q.description !== 'string') errs.push(`${where}: description missing`);
  if (!q.license || typeof q.license !== 'string') errs.push(`${where}: license missing`);
  const hasOpts = Array.isArray(q.options) && q.options.length >= 2;
  const hasAns = typeof q.answerText === 'string' && q.answerText.length > 0;
  if (!hasOpts && !hasAns) errs.push(`${where}: needs options (>=2) or answerText`);
  if (hasOpts) {
    const correctCount = q.options.filter(o => o && o.correct === true).length;
    if (correctCount !== 1) errs.push(`${where}: must have exactly 1 correct option (has ${correctCount})`);
  }
  if (q.difficulty && !DIFFICULTY_LEVELS.includes(q.difficulty)) {
    errs.push(`${where}: difficulty must be one of ${DIFFICULTY_LEVELS.join(', ')}`);
  }
  return errs;
}

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: validate-pack.mjs <path-to-pack.json>');
    process.exit(2);
  }
  const raw = await readFile(path, 'utf8');
  const pack = JSON.parse(raw);

  const errors = [];

  // Pack-level
  for (const f of ['packId', 'version', 'name', 'license', 'source', 'sets', 'contentHash']) {
    if (!pack[f]) errors.push(`pack.${f} missing`);
  }

  // Questions
  const ids = new Set();
  let totalQuestions = 0;
  for (const [setKey, questions] of Object.entries(pack.sets || {})) {
    if (!Array.isArray(questions)) { errors.push(`set ${setKey} not an array`); continue; }
    questions.forEach((q, idx) => {
      const where = `set ${setKey}[${idx}]`;
      errors.push(...validateQuestion(q, where));
      if (q && q.id) {
        if (ids.has(q.id)) errors.push(`${where}: duplicate id ${q.id}`);
        ids.add(q.id);
      }
      totalQuestions++;
    });
  }

  // Content hash
  if (pack.contentHash) {
    const { contentHash, ...rest } = pack;
    const expected = 'sha256-' + createHash('sha256').update(JSON.stringify(rest)).digest('hex');
    if (contentHash !== expected) {
      errors.push(`contentHash mismatch (expected ${expected})`);
    }
  }

  if (errors.length > 0) {
    console.error(`FAIL — ${errors.length} error(s):`);
    errors.forEach(e => console.error('  ' + e));
    process.exit(1);
  }
  console.log(`PASS — ${path}`);
  console.log(`  pack: ${pack.packId} v${pack.version}`);
  console.log(`  questions: ${totalQuestions} across ${Object.keys(pack.sets).length} set(s)`);
  console.log(`  license: ${pack.license}`);
  console.log(`  hash: ${pack.contentHash}`);
}

main().catch(err => {
  console.error('validate-pack failed:', err);
  process.exit(1);
});
