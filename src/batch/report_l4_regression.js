#!/usr/bin/env node
/**
 * report_l4_regression.js — Phase 4: 回帰結果の前回比レポート（悪化を赤字表示）
 *
 * runtime/l4_regression/ の regression_*.json / matrix_*.json を比較し、
 * ルート（またはセル×車種）単位で verdict の変化を検出する。
 *   悪化: PASS→MRM_OK / PASS→FAIL / MRM_OK→FAIL  → 赤字 + exit 1
 *   改善: 逆方向 → 緑字
 *
 * 使い方:
 *   node src/batch/report_l4_regression.js                  # 同種の最新2件を自動比較
 *   node src/batch/report_l4_regression.js --a <file> --b <file>
 * 出力: コンソール + runtime/l4_regression/report_latest.md
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DIR = path.join(ROOT, 'runtime', 'l4_regression');
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';

const RANK = { PASS: 2, MRM_OK: 1, FAIL_MONITOR: 0, FAIL_INCOMPLETE: 0, FAIL_UNKNOWN: 0 };

function parseArgs(argv) {
  const o = { a: null, b: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--a') o.a = path.resolve(argv[++i]);
    else if (argv[i] === '--b') o.b = path.resolve(argv[++i]);
  }
  return o;
}

function latestPair() {
  if (!fs.existsSync(DIR)) return null;
  const files = fs.readdirSync(DIR).filter((f) => /^(regression|matrix)_\d+\.json$/.test(f));
  const byKind = {};
  for (const f of files) {
    const kind = f.startsWith('matrix') ? 'matrix' : 'regression';
    (byKind[kind] = byKind[kind] || []).push(f);
  }
  // 新しい実行が2件以上ある種類を優先（matrix優先）
  for (const kind of ['matrix', 'regression']) {
    const arr = (byKind[kind] || []).sort();
    if (arr.length >= 2) {
      return { a: path.join(DIR, arr[arr.length - 2]), b: path.join(DIR, arr[arr.length - 1]) };
    }
  }
  return null;
}

function keyOf(r) {
  return [r.world, r.id, r.vehicle || '', r.cell || ''].join('|');
}

function load(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const map = new Map();
  for (const r of data.results || []) map.set(keyOf(r), r);
  return { file, summary: data.summary || {}, map };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  let a = opts.a;
  let b = opts.b;
  if (!a || !b) {
    const pair = latestPair();
    if (!pair) {
      console.error('比較できる結果が2件未満です（runtime/l4_regression/ に regression_*/matrix_* が必要）');
      return 2;
    }
    a = pair.a;
    b = pair.b;
  }
  const prev = load(a);
  const cur = load(b);

  const lines = [];
  const md = [];
  md.push(`# L4回帰 前回比レポート`);
  md.push(`- 前回: \`${path.basename(prev.file)}\` (${JSON.stringify(prev.summary)})`);
  md.push(`- 今回: \`${path.basename(cur.file)}\` (${JSON.stringify(cur.summary)})`, '');

  let worse = 0;
  let better = 0;
  let added = 0;
  let removed = 0;
  for (const [key, c] of cur.map) {
    const p = prev.map.get(key);
    if (!p) { added++; continue; }
    const dp = RANK[p.verdict] ?? 0;
    const dc = RANK[c.verdict] ?? 0;
    if (dc < dp) {
      worse++;
      const msg = `悪化: ${key}  ${p.verdict} → ${c.verdict}${c.firstViolation ? ' (' + c.firstViolation + ')' : ''}`;
      lines.push(RED + msg + RESET);
      md.push(`- **:red_circle: ${msg}**`);
    } else if (dc > dp) {
      better++;
      const msg = `改善: ${key}  ${p.verdict} → ${c.verdict}`;
      lines.push(GREEN + msg + RESET);
      md.push(`- :green_circle: ${msg}`);
    }
  }
  for (const key of prev.map.keys()) if (!cur.map.has(key)) removed++;

  const head = `前回比: 悪化=${worse} 改善=${better} 追加=${added} 削除=${removed}  ` +
    `(今回 PASS=${cur.summary.pass ?? '?'} MRM_OK=${cur.summary.mrmOk ?? '?'} FAIL=${cur.summary.fail ?? '?'})`;
  console.log(head);
  for (const l of lines) console.log('  ' + l);
  if (!lines.length) console.log('  変化なし（全ルート同一判定）');
  md.splice(3, 0, `**${head}**`, '');
  if (!lines.length) md.push('- 変化なし（全ルート同一判定）');

  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, 'report_latest.md'), md.join('\n') + '\n', 'utf8');
  console.log(`saved: ${path.join(DIR, 'report_latest.md')}`);
  return worse === 0 ? 0 : 1;
}

process.exit(main());
