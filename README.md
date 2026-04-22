# hamster-content

Content pipeline + generated packs for Hamster. Open-access sources only.

## Layout

```
hamster-content/
├── word-lists/            curated GRE word selection (words + POS hint + optional senseHint)
├── sources/
│   ├── definitions/       cached dictionaryapi.dev / Wiktionary responses (committed)
│   └── epso/              snapshotted EPSO official sample tests (H5P pages + PDFs, committed)
├── scripts/               fetch + build + validate (node, ESM)
├── packs/                 generated output (committed, SHA-256-sealed)
└── catalog.json           top-level listing consumed by the extension (planned)
```

## Build the GRE vocab pack

```sh
cd hamster-content
node scripts/fetch-definitions.mjs            # pulls definitions into sources/
node scripts/build-gre-vocab.mjs              # produces packs/gre-vocab-defmatch-v1.json
node scripts/validate-pack.mjs packs/gre-vocab-defmatch-v1.json
```

## Build the EPSO samples pack

```sh
cd hamster-content
node scripts/build-epso-samples.mjs           # reads sources/epso/*.html + .json
node scripts/validate-pack.mjs packs/epso-samples-v1.json
```

v1 ships **22 authentic English EPSO sample questions** — 10 verbal reasoning MCQs (extracted from H5P on eu-careers.europa.eu) + 12 language comprehension MCQs (extracted from the EU official sample PDF). CC BY 4.0 end-to-end via EU Reuse Decision 2011/833/EU.

**Skipped in v1**: 10 abstract reasoning + 5 numerical reasoning sample questions. They exist in `sources/epso/abstract-ast-en.html` and `numerical-ast-en.html` but reference diagrams/tables (`images/file-*.jpg` in the H5P payload) that Hamster's text-based overlay doesn't render today. Re-enable them when image-capable interventions land.

## Refresh the EPSO snapshot

Re-fetching the raw sources is a one-liner — run when EPSO updates their sample tests:

```sh
curl -sSL -o sources/epso/verbal-ast-en.html    https://eu-careers.europa.eu/en/verbal-testsAST
curl -sSL -o sources/epso/numerical-ast-en.html https://eu-careers.europa.eu/en/numerical-testsasten
curl -sSL -o sources/epso/abstract-ast-en.html  https://eu-careers.europa.eu/en/abstract-testsasten
curl -sSL -o sources/epso/language-comprehension-en.pdf \
  'https://eu-careers.europa.eu/sites/default/files/documents//general/sample_tests/language_comprehension_test/en.pdf'
# Then re-extract the PDF into JSON using pypdf (see scripts/extract-epso-lang-comp.py)
node scripts/build-epso-samples.mjs
```

Re-running with unchanged inputs produces byte-identical output. IDs are SHA-256-seeded from (pack_id, set_key, content_id), so content updates only change IDs for questions whose H5P cid changed — existing user SM-2 state on unchanged questions survives.

## Sources + licensing (honest)

### What we use

| Source | License | Used for |
|---|---|---|
| Wiktionary via [dictionaryapi.dev](https://dictionaryapi.dev) | CC BY-SA 3.0 (per-word `sourceUrls` + `license` in each cached response) | Definitions, POS, examples |
| Curated word selection | Editorial (see below) | Which words enter the pack |

Definitions from Wiktionary inherit CC BY-SA 3.0. Each generated question's `sourceUrl` links to the exact Wiktionary page so attribution is preserved.

### Word-selection provenance

The words themselves come from publicly-discussed GRE frequency lists (Barron's 333, Magoose 1000, Manhattan 500). A *list of words* is factual, not a creative compilation — courts in the US and EU treat word frequency and inclusion as non-copyrightable data. The editorial choices (which words to include, POS disambiguation hints, difficulty calls, optional `senseHint` for words where Wiktionary's first sense isn't the GRE-test sense) are ours, licensed CC BY-SA 4.0 via the pack's downstream license.

### What we *don't* use

- **Barron's/Magoose/Manhattan books** (text or definitions) — copyrighted
- **ETS official questions** — copyrighted, strictly enforced
- **MIT-claimed GitHub GRE repos** — most repackage Barron's / GregMat content; the MIT file at repo root can't re-license upstream-copyrighted material

### Anki import (user-brought, not bundled)

Hamster already supports Anki import via the dashboard (`parseAnkiExport`) and AnkiConnect. Users can import GregMat / Magoose / Manhattan / any other Anki deck into their own extension storage. This content stays local, never ships in our open pack — so we keep clean licensing for the default distribution while letting power users bring any deck they want.

## Sense selection

Wiktionary often lists 10+ senses per word (obsolete, dialectal, legal, specialized, etc.). The builder picks the GRE-appropriate one via:

1. Filter by POS hint (verb/noun/adjective from word list)
2. Drop senses with leading tags like `(obsolete)`, `(archaic)`, `(rare)`, `(law)`, `(botany)`, etc.
3. If `senseHint` is set in the word list, require the definition to contain it as a substring (case-insensitive). Used for stubborn words like `abate` (hint: `intensity`) or `ascetic` (hint: `self-denial`) where the first non-excluded sense still isn't the GRE meaning.
4. Prefer the earliest remaining sense in Wiktionary's ordering (canonical senses come first)
5. Tiebreak: prefer with example sentence, then 20–150 char length, then shortest

## Adding a word

1. Append to `word-lists/gre-high-freq.json`:
   ```json
   { "word": "laconic", "pos": "adjective", "difficulty": "medium" }
   ```
2. `node scripts/fetch-definitions.mjs` (pulls just the new word)
3. `node scripts/build-gre-vocab.mjs` (regenerates pack; existing IDs stable)
4. Eyeball the new entry in the output. If the picked sense is wrong, add `"senseHint": "<keyword>"` and re-run.

## Pack schema

Each question in a pack conforms to the v2 schema in `extension/lib/shared.js`:

```js
{ id, type, title, description, options: [{label, correct}], explanation, difficulty, tags, source, sourceUrl, license }
```

Pack envelope:

```js
{ packId, version, name, description, contributor, source, license, updatedAt, questionCount, sets: {...}, contentHash }
```
