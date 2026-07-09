// runtime-config.sample.js — 配布用テンプレート（コミット対象）。
// 各端末では本ファイルを runtime-config.js にコピーして秘匿値を埋める運用。
// runtime-config.js 自体は .gitignore で Git 管理外（Sprint1 P0-3）。
//
// 運用ルール（社内専用デスクトップ配備）:
//   1. Google Maps API キーは Google Cloud Console で必ず HTTP リファラ制限
//      （http://localhost:8080/* や社内ドメイン）を設定する。
//      キー単体が漏れても他環境からは使えない状態を維持すること。
//   2. キーを Git やチャットに貼らない。配布は社内ファイルサーバ経由。
//   3. キーを更新した場合は本ファイル末尾の updatedAt と updatedBy を更新する。
//   4. YOLO サーバ URL を他PCに向ける場合、サーバ側で X-Api-Key 認証
//      （Sprint1 P0-4）が有効か確認すること。

window.LOGISTICS_RUNTIME_CONFIG = Object.assign(
  {
    googleMapsApiKey: '',     // 例: 'AIza...'
    yoloServerUrl: '',         // 例: 'http://127.0.0.1:8001'
    yoloApiKey: '',            // Sprint1 P0-4 で導入するサーバ認証キー
    remoteVoxelServerUrl: '',  // 任意
    defaultDriverSkill: 1.0,
    companyName: '',
    reporterName: '',
    zipsEnabled: false
  },
  window.LOGISTICS_RUNTIME_CONFIG || {}
);

// 更新履歴（運用ログ）
// updatedAt: ''
// updatedBy: ''
