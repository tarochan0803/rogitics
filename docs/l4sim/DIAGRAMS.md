# L4SIM 技術ダイアグラム

## 1. 全体アーキテクチャ（データ→世界→自動運転→検証）

```mermaid
flowchart TB
  subgraph SRC["データソース（無料・合法）"]
    GSI_P["GSI 航空写真\n~0.5m/px"]
    GSI_D["GSI DEM5A/5B\n(Phase1 追加)"]
    FGD["基盤地図 道路縁\n(Phase2 追加)"]
    RDCL["GSI rdcl\n幅員ランク"]
    OSM["OSM 道路/建物"]
    PLA["PLATEAU LOD1/2"]
    REG["JARTIC/OSM 規制"]
  end

  subgraph WC["ワールドコンパイラ (Phase1)"]
    FUSE["融合・信頼度付与\nroadWidthModel / road_seg"]
    BAKE["焼き込み\nworld_&lt;hash&gt;.json"]
  end

  subgraph SIM["決定論シミュレーション (Phase0 ✅)"]
    RP["① Route Planner\ngraph.js"]
    BP["② Behavior Planner\nbehaviorPlanner.js"]
    MP["③ Motion Planner\ntrajectoryPlanner / kinematics"]
    CT["④ Controller\nautoFollowCore (固定dt)"]
    SM["⑤ Safety Monitor (Phase3 core)\n不変条件 + MRM"]
  end

  subgraph VER["検証 (Phase0✅/4)"]
    TR["trace.js\nrecord/replay"]
    REPRO["run_sim_repro\n100回一致"]
    GOLD["golden benchmark\n実績=正解・混同行列"]
  end

  SRC --> FUSE --> BAKE
  BAKE --> RP --> BP --> MP --> CT
  SM -.毎tick検査.-> CT
  CT --> TR --> REPRO
  BAKE --> GOLD
  CT --> GOLD
```

## 2. Phase 0 決定論ループ（実装済みの心臓部）

```
 requestAnimationFrame(可変 16.7ms±)          固定タイムステップ物理
┌─────────────────────────────┐   simAcc    ┌──────────────────────────────┐
│ フレーム到着: frameDt を計測 │──────────▶│ while (simAcc >= 0.05s):      │
│ （揺らぎ・PC性能に依存）     │  貯める     │   simTimeS += 0.05            │
└─────────────────────────────┘             │   0.35s毎: _detectOffRoad()   │
                                            │   v = allowedSpeed(sM)        │
        描画は状態を読むだけ                 │   sM += v * 0.05              │
┌─────────────────────────────┐             │   trace.push({tick,sM,v,...}) │
│ marker/HUD/trail 更新        │◀───────────│  （幾何は autoFollowCore 共有）│
└─────────────────────────────┘   state     └──────────────────────────────┘

検証済み: 揺らぎdtを注入しても trace ハッシュ f1d5add4 で不変（run_sim_repro [3]）
```

## 3. record/replay によるバグ再現フロー

```mermaid
sequenceDiagram
  participant Dev as 開発者
  participant Sim as simループ
  participant Tr as trace.jsonl
  Dev->>Sim: 走行（world hash + seed + dt 固定）
  Sim->>Tr: 毎tick {tick,sM,lat,lng,h,v}
  Note over Tr: バグ報告 = trace + 入力
  Dev->>Sim: 再実行 + createReplayChecker(trace)
  Sim-->>Dev: 最初に食い違った tick を特定
  Dev->>Dev: その tick 前後だけデバッグ（全区間を見ない）
```

## 4. 幅精度の多ソース融合（既存＋計画）

```
 手動上書き(1.00) ─┐                                    ┌→ 判定 buildRoadUnion
 FGD道路縁(0.88)★─┤                                    │
 OSM width(0.85) ──┼→ fuseWidthForFeature ─ confidence ─┼→ 自動走行 減速率
 航空写真AI(0.78)★┤   （低い値に保守化）      │        │
 SV/YOLO(0.75) ────┤                          ▼        └→ 2D/3D 表示幅
 GSI範囲(0.72) ────┤                    applyWidthRisk
 highway既定(0.60)─┘                   （不確実→幅を下振れ）
                        ★=Phase2で追加。相互矛盾は disagreement として確認待ちへ
```

## 5. シナリオ行列（Phase 4）

```
        車種:  2t / 3t / 4t / 10t
      × 幅帯:  <3.5 / 3.5-4.5 / 4.5-6 / 6m+
      × 形状:  直線 / 直角 / クランク / S字 / 切り返し
      × 勾配:  平坦 / 5% / 10%
      ─────────────────────────────────
      = 240セル を夜間ヘッドレス全走行
      各セル: PASS / MRM停止(理由コード) / Monitor違反(=バグ)
```

## 6. ファイル配置

```
src/sim/
  autoFollowCore.js   … 決定論コア（幾何+RNG+固定dtシム）✅
  trace.js            … record/replay ✅
  vehicleModel.js     … 車両正規化（既存）
  kinematics.js       … 曲率→速度プロファイル（既存）
  autonomy/behaviorPlanner.js … 挙動計画（既存）
src/batch/
  run_sim_repro.js    … 決定論検証ハーネス ✅
  run_golden_benchmark.js … ゴールデン回帰（既存・Phase2で拡張）
road_seg/             … 幅推定・教師データ・学習（既存一式）
docs/l4sim/           … 本ドキュメント群
```
