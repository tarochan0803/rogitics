/**
 * worldFile.js — バージョン付きワールドファイルの焼き込み/読み込み（Phase 1）
 *
 * 完了条件「同一AOI再コンパイルで world hash 一致」の実装。
 * - hash はコンテンツ（aoi+layers）の正準直列化に対する FNV-1a。
 *   compiledAt 等の揮発メタは hash 対象外（meta に置く）。
 * - 正準直列化: キーを再帰的にソート、-0→0 正規化。配列順は意味を持つため
 *   コンパイラ側が決定論的順序（feature id ソート等）で渡す責任を負う。
 */

import { fnv1a } from '../sim/trace.js';

export const WORLD_FORMAT = 'logistics-world';
export const WORLD_VERSION = 1;

export function canonicalStringify(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'null';
    if (Object.is(value, -0)) return '0';
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(value[k])).join(',') + '}';
  }
  return 'null'; // undefined/function は null に落とす
}

export function worldHash(aoi, layers) {
  return fnv1a(canonicalStringify({ aoi, layers }));
}

/**
 * bakeWorld({ aoi, layers, meta }) -> { world, hash }
 * layers 例: { roads: Feature[], buildings: Feature[], regulations: [], dem: {...} }
 */
export function bakeWorld({ aoi, layers = {}, meta = {} } = {}) {
  if (!aoi) throw new Error('bakeWorld: aoi required');
  const hash = worldHash(aoi, layers);
  const world = {
    format: WORLD_FORMAT,
    version: WORLD_VERSION,
    hash,
    aoi,
    layers,
    meta // compiledAt / ソースURL / 取得統計など揮発情報（hash対象外）
  };
  return { world, hash };
}

export function parseWorld(jsonOrObj) {
  const w = typeof jsonOrObj === 'string' ? JSON.parse(jsonOrObj) : jsonOrObj;
  if (!w || w.format !== WORLD_FORMAT) throw new Error('parseWorld: not a logistics-world file');
  if (w.version !== WORLD_VERSION) throw new Error(`parseWorld: unsupported version ${w.version}`);
  const expect = worldHash(w.aoi, w.layers);
  return { world: w, hashOk: expect === w.hash, expectedHash: expect };
}

// コンパイラが使う決定論的順序: id昇順（idなしは末尾・座標先頭で安定化）
export function sortFeaturesStable(features) {
  const keyOf = (f) => {
    const id = f?.id ?? f?.properties?.id;
    if (id != null) return `A:${String(id)}`;
    const c = f?.geometry?.coordinates;
    return `B:${JSON.stringify(c)?.slice(0, 64) || ''}`;
  };
  return [...(features || [])].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
}
