#!/usr/bin/env node
/**
 * import_golden_results.js — Phase 4: 実搬入実績 → golden-routes.json 取り込み
 *
 * benchmarks/実績ルート入力.csv（id,名称,車種,出発緯度,出発経度,到着緯度,到着経度,実績,メモ）
 * を読み、benchmarks/golden-routes.json の cases へマージする。
 *   実績 OK   → expected: { overallStatusAnyOf: ["PASS","CONDITIONAL"], passable: true }
 *   実績 COND → expected: { overallStatusAnyOf: ["PASS","CONDITIONAL"], passable: true }（切り返し等で通れた）
 *   実績 NG   → expected: { overallStatusAnyOf: ["NG"], passable: false }
 * 同一idは上書き更新。#始まり行・記入例は無視。--dry-run で書き込まず確認。
 *
 * 使い方:
 *   node src/batch/import_golden_results.js [--csv benchmarks/実績ルート入力.csv] [--dry-run]
 *   node src/batch/import_golden_results.js --selfcheck
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_CSV = path.join(ROOT, 'benchmarks', '実績ルート入力.csv');
const GOLDEN = path.join(ROOT, 'benchmarks', 'golden-routes.json');
const KNOWN_PRESETS = ['2t_flat', '2t_unic', '3t_flat', '3t_unic', '4t_flat', '4t_unic', '10t_unic', 'trailer_15t'];

function parseCsv(text) {
  const rows = [];
  for (const rawLine of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    // 簡易CSV: ダブルクォート内カンマ対応
    const cols = [];
    let cur = '';
    let inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === ',' && !inQ) { cols.push(cur); cur = ''; }
      else cur += ch;
    }
    cols.push(cur);
    rows.push(cols.map((c) => c.trim()));
  }
  return rows;
}

function toCase(cols, lineNo) {
  const [id, name, preset, sLat, sLng, gLat, gLng, result, memo] = cols;
  const errors = [];
  if (!id) errors.push('idが空');
  if (!KNOWN_PRESETS.includes(preset)) errors.push(`車種 "${preset}" が不明（${KNOWN_PRESETS.join('/')}）`);
  const nums = [sLat, sLng, gLat, gLng].map(Number);
  if (nums.some((n) => !Number.isFinite(n))) errors.push('緯度経度が数値でない');
  const res = String(result || '').trim().toUpperCase();
  if (!['OK', 'NG', 'COND'].includes(res)) errors.push(`実績 "${result}" はOK/NG/CONDのいずれか`);
  if (errors.length) return { error: `${lineNo}行目: ${errors.join(' / ')}` };

  const passable = res !== 'NG';
  return {
    value: {
      id: String(id),
      name: String(name || id),
      vehiclePreset: preset,
      driverSkill: 1.0,
      endpoints: [
        { lat: nums[0], lng: nums[1], name: 'start' },
        { lat: nums[2], lng: nums[3], name: 'goal' }
      ],
      expected: {
        overallStatusAnyOf: passable ? ['PASS', 'CONDITIONAL'] : ['NG'],
        passable
      },
      notes: `実績取り込み(${res})${memo ? ': ' + memo : ''} [imported ${new Date().toISOString().slice(0, 10)}]`
    }
  };
}

function importCsv(csvText, golden) {
  const rows = parseCsv(csvText);
  if (rows.length && /緯度|^id$/i.test(rows[0][3] || rows[0][0])) rows.shift(); // ヘッダ行
  const errors = [];
  let added = 0;
  let updated = 0;
  const byId = new Map(golden.cases.map((c) => [c.id, c]));
  rows.forEach((cols, i) => {
    const r = toCase(cols, i + 1);
    if (r.error) { errors.push(r.error); return; }
    if (byId.has(r.value.id)) { updated++; } else { added++; }
    byId.set(r.value.id, r.value);
  });
  golden.cases = [...byId.values()];
  return { added, updated, errors, total: golden.cases.length };
}

function selfcheck() {
  let pass = true;
  const check = (n, c, d = '') => { console.log(`[${c ? 'PASS' : 'FAIL'}] ${n}  ${d}`); pass = pass && c; };
  const csv = [
    'id,名称,車種,出発緯度,出発経度,到着緯度,到着経度,実績,メモ',
    '# コメント行',
    'g-1,テスト現場A,4t_flat,35.68,139.76,35.69,139.77,OK,"狭いが, 通れた"',
    'g-2,テスト現場B,10t_unic,35.68,139.76,35.69,139.77,NG,電柱で不可',
    'g-3,テスト現場C,2t_flat,35.68,139.76,35.69,139.77,COND,切り返しあり',
    'g-bad,壊れ行,99t,x,139.76,35.69,139.77,MAYBE,'
  ].join('\n');
  const golden = { version: 1, cases: [{ id: 'g-1', name: 'old', vehiclePreset: '2t_flat', endpoints: [], expected: {} }] };
  const r = importCsv(csv, golden);
  check('valid rows imported (2 add + 1 update)', r.added === 2 && r.updated === 1, `added=${r.added} updated=${r.updated}`);
  check('bad row rejected with reason', r.errors.length === 1, r.errors[0] || '');
  const g1 = golden.cases.find((c) => c.id === 'g-1');
  const g2 = golden.cases.find((c) => c.id === 'g-2');
  const g3 = golden.cases.find((c) => c.id === 'g-3');
  check('OK -> passable=true + preset updated', g1.expected.passable === true && g1.vehiclePreset === '4t_flat');
  check('NG -> passable=false + NG expected', g2.expected.passable === false && g2.expected.overallStatusAnyOf[0] === 'NG');
  check('COND -> passable=true (条件付き)', g3.expected.passable === true);
  check('quoted comma in memo preserved', g1.notes.includes('狭いが, 通れた'));
  console.log(pass ? '\nselfcheck ALL PASS' : '\nselfcheck FAILED');
  return pass ? 0 : 1;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selfcheck')) return selfcheck();
  const csvIdx = argv.indexOf('--csv');
  const csvPath = csvIdx >= 0 ? path.resolve(argv[csvIdx + 1]) : DEFAULT_CSV;
  const dryRun = argv.includes('--dry-run');

  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  const before = golden.cases.length;
  const r = importCsv(fs.readFileSync(csvPath, 'utf8'), golden);
  for (const e of r.errors) console.warn('[skip]', e);
  console.log(`cases: ${before} -> ${r.total}（追加${r.added} / 更新${r.updated} / スキップ${r.errors.length}）`);
  if (r.added + r.updated === 0) {
    console.log('取り込む実績行がありません（CSVに実データを追記してください）。');
    return 0;
  }
  if (dryRun) {
    console.log('--dry-run のため書き込みなし。');
    return 0;
  }
  fs.writeFileSync(GOLDEN, JSON.stringify(golden, null, 2) + '\n', 'utf8');
  console.log(`saved: ${GOLDEN}`);
  console.log('次: node src/batch/run_golden_benchmark.js で混同行列を計測');
  return 0;
}

process.exit(main());
