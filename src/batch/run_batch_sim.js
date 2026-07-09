const fs = require('fs');
const path = require('path');
const https = require('https');
const puppeteer = require('puppeteer');
const csv = require('csv-parser');

// ----------------------------------------------------
// 設定項目
// ----------------------------------------------------
const CONFIG = {
  // ブラウザで開くURL（起動.batで確認できるサーバーアドレスに合わせる）
  targetUrl: 'http://192.168.2.116:8080/index8.2.html',
  // 入力CSVファイル
  inputFile: path.join(__dirname, 'input.csv'),
  // 出力ディレクトリ
  outputDirBase: path.join(__dirname, 'output'),
  // 処理ごとの待機時間(ms)
  delayBetweenTasks: 2000,
  // APIタイムアウト等
  navigationTimeout: 90000,
  // 画面サイズ（Leaflet地図描画領域）
  viewport: { width: 1400, height: 1000 },
  // ジオコーディング設定
  geocodeOrder: ['gsi', 'nominatim'], // 'google' を使う場合は末尾に追加
  nominatimEmail: '', // 空でOK。必要なら設定。
  nominatimUserAgent: 'LogisticsOS-BatchSim/1.0',
  googleApiKey: '', // 使う場合のみ設定
  geocodeCooldownMs: 1200
};

// ----------------------------------------------------
// メイン処理
// ----------------------------------------------------
async function main() {
  console.log(`[Batch] 処理開始...`);

  // 出力ディレクトリの作成 (YYYYMMDD_HHMMSS)
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const outputDir = path.join(CONFIG.outputDirBase, ts);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const resultJsonlPath = path.join(outputDir, 'result.jsonl');
  console.log(`[Batch] 出力ディレクトリ: ${outputDir}`);

  // CSVの読み込み
  const tasks = await loadCsv(CONFIG.inputFile);
  console.log(`[Batch] 読み込み件数: ${tasks.length}件\n`);
  if (tasks.length === 0) {
    console.log('[Batch] タスクがありません。終了します。');
    return;
  }

  // アノテーションツールをコピー
  const toolSrc = path.join(__dirname, 'annotation_tool.html');
  const toolDest = path.join(outputDir, 'annotation_tool.html');
  if (fs.existsSync(toolSrc)) {
      fs.copyFileSync(toolSrc, toolDest);
      console.log(`[Batch] アノテーションツールをコピーしました: ${toolDest}`);
  }

  // Puppeteer起動
  // バンドルChrome (node_modules内) は Windows セキュリティにブロックされるため
  // システムインストール済みの Chrome を使用する
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    defaultViewport: CONFIG.viewport,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    // JSエラーをコンソールに出力
    page.on('console', msg => {
      const text = msg.text();
      // 余計なログはフィルタしてもOK
      if (text.includes('Failed to load resource')) return;
      // console.log(`[Browser]: ${text}`);
    });

    console.log(`[Batch] ${CONFIG.targetUrl} を開きます...`);
    await page.goto(CONFIG.targetUrl, { waitUntil: 'networkidle2', timeout: CONFIG.navigationTimeout });

    // アプリ初期化待ち
    console.log(`[Batch] 地図ロード待機 (約3秒)...`);
    await new Promise(r => setTimeout(r, 3000));

    // 各タスクを順次実行
    const geocodeCache = new Map();
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      console.log(`\n--- [Task ${i + 1}/${tasks.length}] ---`);
      console.log(`目的地: ${task.address} / 車両: ${task.vehicle || '4t'}`);

      try {
        const goalLoc = await geocodeAddress(task.address, geocodeCache);
        if (!goalLoc) {
          throw new Error('Geocoding failed for: ' + task.address);
        }
        if (CONFIG.geocodeCooldownMs > 0) {
          await new Promise(r => setTimeout(r, CONFIG.geocodeCooldownMs));
        }

        const result = await runAssessmentTask(page, task, outputDir, i, goalLoc);
        // 結果をCSV/JSONLに追記
        const outData = {
          task_id: i + 1,
          input: task,
          timestamp: new Date().toISOString(),
          results: result.results || {},
          imageFile: result.imageFile,
          errorMessage: result.error || null,
          route: result.route || null,
          startLoc: result.startLoc || null,
          goalLoc: result.goalLoc || null,
          roadSegments: result.roadSegments || null
        };
        fs.appendFileSync(resultJsonlPath, JSON.stringify(outData) + '\n', 'utf8');

        if (result.success) {
          const resSummary = Object.entries(result.results || {}).map(([k, v]) => `${k}:${v.status}`).join(', ');
          console.log(` -> 判定完了: ${resSummary}`);
        } else {
          console.error(` -> 判定エラー: ${result.error}`);
          // 住所が見つからない場合は続行しても無意味なので中断
          if (result.error && result.error.includes('Geocoding failed')) {
            console.error('[Batch] 住所が見つかりませんでした。バッチを中断します。input.csv を確認してください。');
            break;
          }
        }

      } catch (err) {
        console.error(` -> 予期せぬエラー: ${err.message}`);
        fs.appendFileSync(resultJsonlPath, JSON.stringify({ task_id: i + 1, input: task, status: 'ERROR', error: err.message }) + '\n', 'utf8');
        // ジオコーディング失敗は即中断
        if (err.message && err.message.includes('Geocoding failed')) {
          console.error('[Batch] 住所が見つかりませんでした。バッチを中断します。input.csv を確認してください。');
          break;
        }
      }

      // 次のタスクまで待機
      if (i < tasks.length - 1) {
        console.log(` -> クールダウン ${CONFIG.delayBetweenTasks / 1000}秒...`);
        await new Promise(r => setTimeout(r, CONFIG.delayBetweenTasks));
      }
    }

  } finally {
    console.log('\n[Batch] ブラウザを終了します...');
    await browser.close();
    console.log(`[Batch] 処理が完了しました。出力は ${outputDir} を確認してください。`);
  }
}

// ----------------------------------------------------
// 単一タスクの実行フロー
// ----------------------------------------------------
async function runAssessmentTask(page, task, outputDir, index, goalLoc) {
  // 1. 自動実行の仕組みをページ内コンテキストで行う
  // 住所 -> API叩いてジオコーディング -> 200mスタート計算 -> ルーティング -> 判定
  const payload = {
    address: task.address,
    vehiclePreset: task.vehicle || '4t', // デフォルト4t
    goalLoc
  };

  const evalResult = await page.evaluate(async (params) => {
    // ---- [ブラウザ内コンテキスト] ----
    // fetch APIなどを利用してジオコーディングからOSRMまでを完結させるラッパー関数を定義

    /**
     * ゴールから100m離れた点を計算
     */
    function calculateStartPoint(goal) {
       // turf.destination が利用できれば使う
       if (typeof window.turf !== 'undefined') {
          const pt = window.turf.point([goal.lng, goal.lat]);
          // 方位はランダム、距離は0.1km(100m)
          const angle = Math.random() * 360 - 180;
          const dest = window.turf.destination(pt, 0.1, angle, { units: 'kilometers' });
          return { lat: dest.geometry.coordinates[1], lng: dest.geometry.coordinates[0] };
       }
       // 簡易計算 (1度≒111km -> 100m≒0.0009度)
       return { lat: goal.lat + 0.0009, lng: goal.lng - 0.0009 };
    }

    // --- メイン処理 ---
    try {
      // 0. 前のタスクのリセット
      if (typeof window.fullReset === 'function') {
          window.fullReset();
          await new Promise(r => setTimeout(r, 500));
      }

      // 1. ゴール座標（Node側でジオコーディング済み）
      const geoLoc = params.goalLoc;
      if (!geoLoc || !isFinite(geoLoc.lat) || !isFinite(geoLoc.lng)) {
        throw new Error('Geocoding failed for: ' + params.address);
      }
      
      // ゴール地点を最寄りの道にスナップ
      let goalLoc = geoLoc;
      if (typeof window.findNearestRoad === 'function') {
          const snapped = await window.findNearestRoad(geoLoc.lat, geoLoc.lng);
          if (snapped) goalLoc = snapped;
      }

      // 2. スタート座標 (約100m離れた「道の上」を探す)
      let startLoc = {
          lat: goalLoc.lat + 0.0009, // 北に約100m
          lng: goalLoc.lng
      };
      if (typeof window.findNearestRoad === 'function') {
          const snappedStart = await window.findNearestRoad(startLoc.lat, startLoc.lng);
          if (snappedStart) startLoc = snappedStart;
      }

      // 3. ルート検索
      if (typeof window.store === 'undefined') {
         throw new Error('Store is not accessible');
      }
      
      const endpoints = [
        { lat: startLoc.lat, lng: startLoc.lng, name: 'Start(Auto)' },
        { lat: goalLoc.lat, lng: goalLoc.lng, name: 'Goal(' + params.address + ')' }
      ];
      window.store.setState({ selectedEndpoints: endpoints });
      
      // OSRMルート取得
      if (typeof window.onOsrmRoute === 'function') {
          await window.onOsrmRoute();
      } else {
          const btn = document.getElementById('osrm-route');
          if (btn) btn.click();
      }
      
      // 経路が確定するまで待つ (直線にならないように length > 2 を確認)
      let state;
      for (let j = 0; j < 30; j++) {
          await new Promise(r => setTimeout(r, 300));
          state = window.store.getState();
          if (state.simRoute && state.simRoute.length > 2) {
              break;
          }
      }
      if (!state.simRoute || state.simRoute.length <= 2) {
          throw new Error('OSRMルートの生成に失敗しました（直線のみ）。道が繋がっていません。');
      }

      // 4. 道路データを取得（これがないと衝突判定が全て無意味になる）
      if (typeof window.loadRoadsWideArea === 'function') {
          console.log('[Batch] 道路データ取得中...');
          try {
              await window.loadRoadsWideArea(state.simRoute);
          } catch (e) {
              console.warn('[Batch] 道路データ取得失敗:', e.message);
          }
          // 道路データがstateに反映されるまで少し待つ
          await new Promise(r => setTimeout(r, 1000));
          state = window.store.getState();
          const roadCount = state.geoJsonDataSets?.length || 0;
          console.log(`[Batch] 道路データ: ${roadCount} 件`);
          if (roadCount === 0) {
              throw new Error('道路データが取得できませんでした。OSRMサーバーまたはOverpassサーバーを確認してください。');
          }
      } else {
          throw new Error('window.loadRoadsWideArea が未公開です。controls.js を確認してください。');
      }

      // --- 全車種（2t, 3t, 4t, 10t）で判定を実行 ---
      const vehiclePresets = ['2t_flat', '3t_flat', '4t_flat', '10t_unic'];
      const resultsPerVehicle = {};

      for (const vp of vehiclePresets) {
          console.log(`[Batch] 判定中: ${vp}`);
          // 車両プリセットをUIにも反映
          const sel = document.getElementById('vehiclePreset');
          if (sel) {
              sel.value = vp;
              sel.dispatchEvent(new Event('change', { bubbles: true }));
          }
          await new Promise(r => setTimeout(r, 200)); // UI反映待ち

          // 搬入判定
          const res = await window.runSingleVehicleAssessment(vp);
          if (res) {
              resultsPerVehicle[vp] = {
                  status: res.overallStatus,
                  score: res.score,
                  distance: res.distanceMeters,
                  hits: res.collisionReport?.totalHits || 0
              };
              console.log(`[Batch]   ${vp} -> ${res.overallStatus} (score:${res.score})`);
          } else {
              resultsPerVehicle[vp] = { status: 'ERROR', score: null, distance: null, hits: null };
              console.warn(`[Batch]   ${vp} -> アセスメント失敗`);
          }
      }

      // 道路データを抽出（Canvasでの道路幅可視化用）
      const roadSegments = [];
      for (const f of (state.geoJsonDataSets || []).slice(0, 400)) {
          const props = f.properties || {};
          const tags = (props.tags && typeof props.tags === 'object') ? props.tags : props;
          let width = null;
          const aiW = parseFloat(tags.width_ai);
          if (Number.isFinite(aiW) && aiW > 0) {
              width = aiW;
          } else {
              for (const k of ['width', 'width:carriageway', 'ROADWIDTH', 'roadwidth']) {
                  const v = parseFloat(tags[k]);
                  if (Number.isFinite(v) && v > 0) { width = v; break; }
              }
              if (width == null) {
                  const lanes = parseInt(tags.lanes, 10);
                  if (!isNaN(lanes) && lanes > 0) width = lanes * 3.0;
              }
          }
          const geom = f.geometry;
          if (!geom) continue;
          const allLines = geom.type === 'LineString' ? [geom.coordinates]
              : geom.type === 'MultiLineString' ? geom.coordinates : [];
          for (const coords of allLines) {
              if (coords && coords.length >= 2) {
                  roadSegments.push({ width, coords: coords.map(([lng, lat]) => ({ lat, lng })) });
              }
          }
      }

      // スクショ用：ゴールエリアにズームイン（近づいて撮影）
      if (typeof window.focusToGoalArea === 'function') {
          window.focusToGoalArea(state.simRoute, 18);
      } else if (typeof window.focusToRoute === 'function') {
          window.focusToRoute(state.simRoute);
      }
      await new Promise(r => setTimeout(r, 800));

      // 結果をバッチ側へ返す
      return {
          success: true,
          results: resultsPerVehicle,
          address: params.address,
          route: state.simRoute,
          startLoc: startLoc,
          goalLoc: goalLoc,
          roadSegments: roadSegments
      };

    } catch (e) {
      return { success: false, error: e.toString() };
    }
    // ---- [ブラウザ内コンテキスト 終了] ----
  }, payload);

  if (!evalResult.success) {
    return evalResult;
  }

  // スクリーンショット保存
  // 描画が完了するまで待つ
  await new Promise(r => setTimeout(r, 1500));
  const fileName = `task_${String(index+1).padStart(3, '0')}_${Date.now()}.jpg`;
  const filePath = path.join(outputDir, fileName);
  await page.screenshot({ path: filePath, type: 'jpeg', quality: 90 });

  evalResult.imageFile = fileName;
  return evalResult;
}

// ----------------------------------------------------
// 汎用関数
// ----------------------------------------------------
function loadCsv(csvPath) {
  return new Promise((resolve, reject) => {
    const results = [];
    if (!fs.existsSync(csvPath)) {
       resolve([]);
       return;
    }
    fs.createReadStream(csvPath)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => resolve(results))
      .on('error', (err) => reject(err));
  });
}

// ----------------------------------------------------
// ジオコーディング (Node側)
// ----------------------------------------------------
function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function geocodeGsi(address) {
  const url = `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(address)}`;
  const data = await fetchJson(url, { 'User-Agent': CONFIG.nominatimUserAgent });
  if (Array.isArray(data) && data.length > 0) {
    const coords = data[0]?.geometry?.coordinates;
    if (Array.isArray(coords) && coords.length >= 2) {
      return { lat: parseFloat(coords[1]), lng: parseFloat(coords[0]), source: 'gsi' };
    }
  }
  return null;
}

async function geocodeNominatim(address) {
  let url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1&accept-language=ja`;
  if (CONFIG.nominatimEmail) {
    url += `&email=${encodeURIComponent(CONFIG.nominatimEmail)}`;
  }
  const data = await fetchJson(url, { 'User-Agent': CONFIG.nominatimUserAgent });
  if (Array.isArray(data) && data.length > 0) {
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), source: 'nominatim' };
  }
  return null;
}

async function geocodeGoogle(address) {
  if (!CONFIG.googleApiKey) return null;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${encodeURIComponent(CONFIG.googleApiKey)}&language=ja`;
  const data = await fetchJson(url, { 'User-Agent': CONFIG.nominatimUserAgent });
  if (data && data.status === 'OK' && data.results && data.results.length > 0) {
    const loc = data.results[0].geometry.location;
    return { lat: loc.lat, lng: loc.lng, source: 'google' };
  }
  return null;
}

async function geocodeAddress(address, cache) {
  const key = String(address || '').trim();
  if (!key) return null;
  if (cache.has(key)) return cache.get(key);

  const order = Array.isArray(CONFIG.geocodeOrder) ? CONFIG.geocodeOrder : ['gsi', 'nominatim'];
  for (const p of order) {
    let res = null;
    try {
      if (p === 'gsi') res = await geocodeGsi(key);
      else if (p === 'nominatim') res = await geocodeNominatim(key);
      else if (p === 'google') res = await geocodeGoogle(key);
    } catch (e) {
      res = null;
    }
    if (res) {
      cache.set(key, res);
      console.log(`[Batch] Geocode(${res.source}): ${key} -> ${res.lat}, ${res.lng}`);
      return res;
    }
  }
  return null;
}

// 起動
main();
