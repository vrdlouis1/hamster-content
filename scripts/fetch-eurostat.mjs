#!/usr/bin/env node
// Pull small Eurostat datasets via the JSON-Stat API, normalize them into
// simple {rows, columns, values, unit} tables suitable for EPSO numerical
// reasoning authoring.
//
// Usage:  node scripts/fetch-eurostat.mjs
// Output: sources/eurostat/{dataset}.table.json
//
// Licensing: Eurostat data is CC BY 4.0 (© European Union, 1995–present).
// API docs: https://wikis.ec.europa.eu/display/EUROSTATHELP/API+-+Data

import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'sources', 'eurostat');
const BASE = 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data';

// Each entry: a dataset code + query params narrow it to a small, readable
// table (a few rows × a few columns). Authoring numerical reasoning items
// on a 5×4 table is easier than on a sprawling one.
const DATASETS = [
  {
    code: 'tec00001',
    shortName: 'GDP at current market prices',
    params: { na_item: ['B1GQ'], unit: ['CP_MEUR'], time: ['2020','2021','2022','2023'], geo: ['EU27_2020','DE','FR','IT','ES','PL'] }
  },
  {
    code: 'une_rt_a',
    shortName: 'Unemployment rate — annual',
    params: { age: ['Y15-74'], sex: ['T'], unit: ['PC_ACT'], time: ['2020','2021','2022','2023'], geo: ['EU27_2020','DE','FR','IT','ES','PL'] }
  },
  {
    code: 'tps00001',
    shortName: 'Population on 1 January',
    params: { time: ['2020','2021','2022','2023','2024'], geo: ['EU27_2020','DE','FR','IT','ES','PL'] }
  },
  {
    code: 'sdg_07_10',
    shortName: 'Primary energy consumption',
    params: { unit: ['MTOE'], time: ['2019','2020','2021','2022','2023'], geo: ['EU27_2020','DE','FR','IT','ES','PL'] }
  }
];

function buildUrl(code, params) {
  const qs = new URLSearchParams({ format: 'JSON', lang: 'EN' });
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach(vv => qs.append(k, vv));
    else qs.append(k, v);
  }
  return `${BASE}/${code}?${qs}`;
}

// JSON-Stat 2.0 stores values in a sparse object keyed by flattened index.
// Pivot into a {geo × time} matrix — the shape most EPSO numerical items use.
function toTable(jsonStat) {
  const dims = jsonStat.id;
  const sizes = jsonStat.size;
  const values = jsonStat.value || {};
  const label = jsonStat.label;
  const unit = jsonStat.dimension?.unit?.category?.label
    ? Object.values(jsonStat.dimension.unit.category.label)[0]
    : (jsonStat.dimension?.unit ? 'see dataset' : '');

  // Pick geo × time as row × col axes if present; otherwise first two dims.
  const rowDim = dims.includes('geo') ? 'geo' : dims[0];
  const colDim = dims.includes('time') ? 'time' : (dims[1] || dims[0]);

  const rowCat = jsonStat.dimension[rowDim].category;
  const colCat = jsonStat.dimension[colDim].category;
  const rowKeys = Object.keys(rowCat.index).sort((a, b) => rowCat.index[a] - rowCat.index[b]);
  const colKeys = Object.keys(colCat.index).sort((a, b) => colCat.index[a] - colCat.index[b]);

  // Flat-index helper (JSON-Stat: last dim varies fastest)
  function flatIdx(dimIndices) {
    let idx = 0;
    for (let i = 0; i < dims.length; i++) {
      let stride = 1;
      for (let j = i + 1; j < dims.length; j++) stride *= sizes[j];
      idx += dimIndices[i] * stride;
    }
    return idx;
  }

  const rows = rowKeys.map(r => {
    const row = { [rowDim]: rowCat.label[r] || r, code: r, values: {} };
    for (const c of colKeys) {
      const dimIdx = dims.map(d => {
        if (d === rowDim) return rowCat.index[r];
        if (d === colDim) return colCat.index[c];
        // Other dims — pick index 0 (datasets are pre-filtered to 1 option)
        return 0;
      });
      const v = values[flatIdx(dimIdx)];
      row.values[colCat.label[c] || c] = v ?? null;
    }
    return row;
  });

  return {
    label,
    unit,
    rowDim,
    colDim,
    columns: colKeys.map(c => colCat.label[c] || c),
    rows
  };
}

async function main() {
  if (!existsSync(OUT_DIR)) await mkdir(OUT_DIR, { recursive: true });

  for (const ds of DATASETS) {
    const url = buildUrl(ds.code, ds.params);
    console.log(`  fetch: ${ds.code} (${ds.shortName})`);
    const res = await fetch(url, {
      headers: { 'User-Agent': 'hamster-content-pipeline/1.0' }
    });
    if (!res.ok) {
      console.warn(`    ! HTTP ${res.status} — skipping`);
      continue;
    }
    const json = await res.json();
    const table = toTable(json);
    const payload = {
      dataset: ds.code,
      shortName: ds.shortName,
      source: 'Eurostat — European Commission',
      sourceUrl: `https://ec.europa.eu/eurostat/databrowser/view/${ds.code}`,
      license: 'CC-BY-4.0',
      licenseNote: '© European Union, 1995–present. Reuse under CC BY 4.0.',
      queryUrl: url,
      ...table
    };
    await writeFile(join(OUT_DIR, `${ds.code}.table.json`), JSON.stringify(payload, null, 2) + '\n', 'utf8');
    console.log(`         → ${table.rows.length} rows × ${table.columns.length} cols`);
  }
  console.log(`\nDone. Tables in: ${OUT_DIR}`);
}

main().catch(err => {
  console.error('fetch-eurostat failed:', err);
  process.exit(1);
});
