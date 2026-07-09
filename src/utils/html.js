// XSS 対策ユーティリティ。
// OSM タグ・PLATEAU データセット名・検索入力・APIレスポンスなどの「外部由来文字列」を
// innerHTML に補間する箇所は、必ず escapeHtml() か html`` タグ付きテンプレートを通すこと。
// 詳細は docs/SUMMARY_INDEX3D_2026-05-27.md および Sprint 1 P0-1 計画書を参照。

const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

/**
 * HTML 文字列に補間する値をエスケープする。
 * 与えられた値が null/undefined のときは空文字。
 * オブジェクト/配列は String() を介して文字列化されてからエスケープされる
 * （誤って [object Object] が混入したとき XSS にならないようにする）。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  if (value == null) return '';
  return String(value).replace(/[&<>"'`]/g, (ch) => ESCAPE_MAP[ch] || ch);
}

const SAFE_HTML = Symbol('safeHtml');

/**
 * 既に検査済みの安全な HTML 断片であることを宣言するマーカー。
 * html`` タグ付きテンプレート内で `${unsafeHtml(precomputed)}` のように使うと、
 * その値はエスケープされずに挿入される。
 *
 * 例:
 *   const rows = items.map((it) => html`<li>${it.name}</li>`).join('');
 *   container.innerHTML = html`<ul>${unsafeHtml(rows)}</ul>`;
 *
 * @param {string} htmlString
 * @returns {{[SAFE_HTML]: true, value: string}}
 */
export function unsafeHtml(htmlString) {
  return { [SAFE_HTML]: true, value: String(htmlString ?? '') };
}

/**
 * タグ付きテンプレート: 補間値を自動でエスケープして HTML 文字列を組み立てる。
 * すでに信頼できる HTML 断片を埋め込みたい場合は unsafeHtml() でラップする。
 *
 * 使い方:
 *   summaryEl.innerHTML = html`<span class="${cls}">${userName}</span>`;
 *
 * @param {TemplateStringsArray} strings
 * @param {...unknown} values
 * @returns {string}
 */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (v && typeof v === 'object' && v[SAFE_HTML]) {
      out += v.value;
    } else {
      out += escapeHtml(v);
    }
    out += strings[i + 1];
  }
  return out;
}
