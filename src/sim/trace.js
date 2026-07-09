/**
 * trace.js — シミュレーション走行記録（record/replay）Phase 0
 *
 * 毎tickの状態を記録し、(1) 走行全体のハッシュで決定論を検証、
 * (2) JSONL に書き出して後から完全リプレイ照合、を可能にする。
 * 依存ゼロ（Node/ブラウザ両用）。
 *
 * バグ報告の最小形式 = { worldHash, seed, dtS, tick } + trace.jsonl。
 */

// FNV-1a 32bit。速く・依存なしで trace 同一性を判定する用途（暗号用途ではない）。
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// 決定論比較用に数値を固定表記へ（-0 と 0 の差など表記揺れだけ潰す。丸めはしない）
function stableValue(v) {
  if (typeof v === 'number') {
    if (Object.is(v, -0)) return '0';
    return String(v);
  }
  return JSON.stringify(v);
}

export function recordToLine(rec) {
  const keys = Object.keys(rec).sort();
  return '{' + keys.map((k) => `"${k}":${stableValue(rec[k])}`).join(',') + '}';
}

export function createTrace(meta = {}) {
  const lines = [];
  return {
    meta,
    push(rec) {
      lines.push(recordToLine(rec));
    },
    get length() {
      return lines.length;
    },
    hash() {
      return fnv1a(lines.join('\n'));
    },
    toJSONL() {
      const head = recordToLine({ _meta: 1, ...meta, records: lines.length });
      return [head, ...lines].join('\n') + '\n';
    },
    lines() {
      return lines.slice();
    }
  };
}

/**
 * リプレイ照合: 記録済み trace と、再実行中に push される record を1件ずつ突き合わせる。
 * 1件でも不一致なら { ok:false, tick, expected, actual } を返して停止できる。
 */
export function createReplayChecker(recordedLines) {
  let i = 0;
  let firstMismatch = null;
  return {
    check(rec) {
      const line = recordToLine(rec);
      const expected = recordedLines[i];
      if (firstMismatch === null && line !== expected) {
        firstMismatch = { tick: i, expected, actual: line };
      }
      i += 1;
      return firstMismatch === null;
    },
    result() {
      if (firstMismatch) return { ok: false, ...firstMismatch };
      if (i !== recordedLines.length) {
        return { ok: false, tick: i, expected: `length ${recordedLines.length}`, actual: `length ${i}` };
      }
      return { ok: true, records: i };
    }
  };
}
