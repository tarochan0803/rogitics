// P1-5: エラーメッセージ集約モジュール
// 原因 × 対処 を構造化して toast 文言を一元化する。
// 各ビルダーは { severity, text, suggestion, combined } を返す。
// 既存の toast(...) 呼び出しは MSG.X(...).combined をそのまま渡せば置換できる。

function join(parts, sep = ' / ') {
  return parts.filter((p) => p != null && p !== '').join(sep);
}

function shortError(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  return err.message || String(err);
}

export const MSG = {
  roadFetchFail({ region, status, error } = {}) {
    const e = shortError(error || status);
    const cause = e ? `道路データ取得失敗（${e}）` : '道路データ取得失敗';
    const ctx = region ? `領域: ${region}` : '';
    const suggestion = '表示範囲を狭めるか、時間をおいて再試行してください';
    return {
      severity: 'warn',
      text: `⚠ ${join([cause, ctx])}`,
      suggestion,
      combined: `⚠ ${join([cause, ctx])} — ${suggestion}`
    };
  },

  roadDataMissing() {
    const suggestion = '上部の「道路取得」ボタンを押してから再実行してください';
    return {
      severity: 'error',
      text: '⚠ 道路データが読み込まれていません',
      suggestion,
      combined: `⚠ 道路データが読み込まれていません — ${suggestion}`
    };
  },

  routeMissing() {
    const suggestion = '地図上で出発点と目的地をクリックして経路を作成してください';
    return {
      severity: 'warn',
      text: '⚠ 経路が未設定です',
      suggestion,
      combined: `⚠ 経路が未設定です — ${suggestion}`
    };
  },

  yoloOffline({ port = 8001 } = {}) {
    const suggestion = `起動_ローカル.bat または python server/app.py で起動してください (port ${port})`;
    return {
      severity: 'info',
      text: `YOLOサーバー未起動 (port ${port})`,
      suggestion,
      combined: `YOLOサーバー未起動 — ${suggestion}`
    };
  },

  yoloStartFailed({ error, httpStatus } = {}) {
    const detail = httpStatus ? `HTTP ${httpStatus}` : shortError(error);
    const suggestion = 'ローカル環境とポート8001の使用状況を確認してください';
    return {
      severity: 'error',
      text: `YOLO起動失敗${detail ? `: ${detail}` : ''}`,
      suggestion,
      combined: `YOLO起動失敗${detail ? `: ${detail}` : ''} — ${suggestion}`
    };
  },

  yoloUnsupportedEnv() {
    const suggestion = '起動_ローカル.bat または python server/app.py で起動してください';
    return {
      severity: 'info',
      text: 'この環境ではYOLO自動起動に未対応です',
      suggestion,
      combined: `この環境ではYOLO自動起動に未対応です — ${suggestion}`
    };
  },

  assessmentFailed({ error } = {}) {
    const e = shortError(error);
    const suggestion = '車両設定と経路を確認し、必要なら道路データを再取得してください';
    return {
      severity: 'error',
      text: `搬入判定でエラー${e ? `: ${e}` : ''}`,
      suggestion,
      combined: `搬入判定でエラー${e ? `: ${e}` : ''} — ${suggestion}`
    };
  },

  assessmentResult({ status, violationsCount = 0 } = {}) {
    if (status === 'PASS') {
      return {
        severity: 'success',
        text: '搬入判定: PASS（通行可）',
        combined: '搬入判定: PASS（通行可）'
      };
    }
    if (status === 'CONDITIONAL') {
      const tail = violationsCount ? ` / 要確認 ${violationsCount} 件` : '';
      return {
        severity: 'warn',
        text: `搬入判定: 要確認${tail}`,
        combined: `搬入判定: 要確認${tail}（条件付き）`
      };
    }
    const tail = violationsCount ? ` / 違反 ${violationsCount} 件` : '';
    return {
      severity: 'error',
      text: `搬入判定: NG${tail}`,
      combined: `搬入判定: NG${tail}（通行不可）`
    };
  }
};
