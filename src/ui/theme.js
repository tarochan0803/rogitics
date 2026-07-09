const STORAGE_KEY = 'truck_ui_theme_v1';
export const THEME_CHANGE_EVENT = 'truck-theme-change';

function safeLocalStorageGet(key) {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

function safeLocalStorageSet(key, value) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, value);
  } catch (e) {}
}

function normalizeTheme(value) {
  const v = String(value || '').toLowerCase();
  if (v === 'dark') return 'dark';
  if (v === 'light') return 'light';
  return null;
}

export function getCurrentTheme() {
  const v = normalizeTheme(document.documentElement?.dataset?.theme);
  return v || 'light';
}

export function getPreferredTheme() {
  const stored = normalizeTheme(safeLocalStorageGet(STORAGE_KEY));
  if (stored) return stored;
  // Default to dark to match "Logistics OS" visual style; user can toggle and it persists.
  return 'dark';
}

export function applyTheme(theme, { persist = true, emit = true } = {}) {
  const t = normalizeTheme(theme) || 'light';
  const prev = getCurrentTheme();
  document.documentElement.dataset.theme = t;
  document.body?.classList.toggle('theme-dark', t === 'dark');
  if (persist) safeLocalStorageSet(STORAGE_KEY, t);
  if (emit && prev !== t) {
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: { theme: t } }));
  }
  return t;
}

export function initTheme() {
  return applyTheme(getPreferredTheme(), { persist: true, emit: false });
}

export function toggleTheme() {
  const next = getCurrentTheme() === 'dark' ? 'light' : 'dark';
  return applyTheme(next, { persist: true, emit: true });
}
