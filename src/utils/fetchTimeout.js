/**
 * AbortSignal.timeout() polyfill.
 * Chrome 103+ / Firefox 100+ / Safari 16+ はネイティブ対応済みだが、
 * 未対応環境（古い WebView 等）のフォールバックとして AbortController を使う。
 *
 * @param {string|URL} url
 * @param {RequestInit} opts
 * @param {number} ms  タイムアウト ms
 */
export function fetchWithTimeout(url, opts = {}, ms) {
  if (typeof AbortSignal.timeout === 'function') {
    return fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
  }
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(id));
}
