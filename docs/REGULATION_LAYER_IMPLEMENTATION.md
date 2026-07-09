# Regulation Layer Implementation Guide

## 目的

LOGISTICS_OS の搬入可否判定を、現在の「物理判定中心」から「物理判定 + 法規制判定」の2軸に拡張する。

最初の実装範囲は、外部データ連携を待たずに着手できる **共通規制スキーマ + OSM由来規制レイヤー** とする。JARTIC、xROAD、自治体道路台帳、商用DBは後続 adapter として同じスキーマに流し込めるようにする。

## 前提

- エントリポイントは `index3D_V2.0.html` -> `src/index3dMain.js`。
- `index8.2.html` / `index9.0.html` / `src/main.js` は legacy。触らない。
- 道路幅は既存の単一モデルを壊さない。
  - 融合: `src/core/roadWidthModel.js`
  - 実効幅: `src/core/feasibility.js` の `estimateEffectiveRoadWidth()`
  - リスク係数: `src/core/vehicleRiskModel.js`
- 車両寸法は `src/3d/clearanceSolids.js` の `getVehicleFootprintConfig()` / `getVehicleEnvelope()` を使う。独自寸法定義を増やさない。
- 規制判定は物理判定と混ぜない。最終判定では統合するが、根拠は分けて残す。
- 日本語文字列を編集した場合は UTF-8 表示を目視確認する。

## 現状の問題

現状、規制情報は主に `src/core/graph.js` の経路探索で使われている。

- `access=no/private`
- `truck=no`
- `motorcar=no`
- `hgv=no`
- `maxheight`
- `maxweight`
- `maxwidth`
- `oneway`

ただしこれは「ルート探索で避ける」だけに近く、搬入可否の最終結果である `deliveryAssessment` に規制違反として乗っていない。

そのため、幾何的に通れる場合は以下でも PASS になり得る。

- 一方通行の逆走
- 大型貨物通行止め
- 高さ制限超過
- 重量制限超過
- 幅制限超過
- 時間帯規制
- 私道・通行許可が必要な道路

## 目標アーキテクチャ

判定を3層に分ける。

1. Physical assessment
   - 幅員、旋回、掃引、建物接触、障害物、頭上クリアランス
2. Regulation assessment
   - 一方通行、車種規制、重量/高さ/幅制限、時間帯規制、右左折禁止など
3. Road authority / legal status assessment
   - 公道/私道、指定道路、道路台帳幅員、位置指定道路など

今回のMVPでは 2 の Regulation assessment を実装し、3 は同じスキーマの future source として口だけ残す。

## 新規モジュール

### `src/core/regulationModel.js`

規制スキーマ、車両適用判定、時間条件判定、ルート上の規制評価を担当する。

想定 export:

```js
export const REGULATION_TYPES = Object.freeze({
  ONEWAY: 'oneway',
  ACCESS: 'access',
  NO_TRUCK: 'no_truck',
  MAX_HEIGHT: 'max_height',
  MAX_WIDTH: 'max_width',
  MAX_WEIGHT: 'max_weight',
  TIME_RESTRICTION: 'time_restriction',
  TURN_RESTRICTION: 'turn_restriction',
  PRIVATE_ROAD: 'private_road',
  DESIGNATED_ROAD: 'designated_road',
  LEDGER_WIDTH: 'ledger_width'
});

export const REGULATION_SEVERITY = Object.freeze({
  BLOCK: 'block',
  PERMIT_REQUIRED: 'permit_required',
  WARNING: 'warning',
  INFO: 'info',
  UNKNOWN: 'unknown'
});

export function normalizeRegulation(input) {}
export function appliesToVehicle(regulation, vehicleConfig, context = {}) {}
export function evaluateRegulation(regulation, vehicleConfig, context = {}) {}
export function assessRegulationsForRoute({ routeLL, roadFeatures, regulations, vehicleConfig, options }) {}
export function deriveRegulationStatus(violations = []) {}
```

### `src/core/osmRegulationAdapter.js`

OSM feature/tags を共通規制スキーマに変換する。

想定 export:

```js
export function regulationsFromOsmFeature(feature) {}
export function buildOsmRegulationLayer(roadFeatures = []) {}
```

`graph.js` に散っている規制パースは、可能ならこの adapter と共通関数化する。ただし初回実装では `graph.js` の既存挙動を壊さないことを優先し、後段判定用の抽出を追加するだけでもよい。

> NOTE (parser export 状況、実コード確認済み):
> - `parseMetersFromTag` / `parseTonsFromTag` は `graph.js` で **export 済み**。adapter から直接 import してよい。
> - `parseMaxWidthFromTags` / `isHgvForbidden` は `graph.js` の **内部関数（未export）**。共通化する場合はこの2つに `export` を足す（非破壊）か、adapter 側で再実装する。`graph.js` の既存呼び出しは変えない。
> - 点→最寄り道のスナップは `projectToNearestWay`（`graph.js` で export 済み）を流用できる。

## 共通規制スキーマ

```js
{
  id: 'osm-way-123:max_height',
  type: 'max_height',
  geometry: GeoJSONGeometry,
  appliesTo: {
    vehicle: true,
    motorVehicle: true,
    hgv: true,
    goods: false
  },
  value: {
    meters: 3.8,
    tons: null,
    raw: '3.8'
  },
  direction: 'forward' | 'reverse' | 'both' | null,
  schedule: null,
  severity: 'block' | 'permit_required' | 'warning' | 'info' | 'unknown',
  source: 'osm',
  sourceFeatureId: 'way/123',
  confidence: 0.55,
  authority: 'OSM',
  evidence: {
    tag: 'maxheight',
    rawValue: '3.8',
    url: null
  },
  updatedAt: null
}
```

### severity の基本方針

- `block`
  - 明確な法規制違反または車両諸元超過。
  - 例: `hgv=no`, `maxheight < vehicleHeight`, `maxwidth < vehicleWidth`, `maxweight < vehicleWeight`
- `permit_required`
  - 許可・関係者承諾・誘導・時間調整で可能性があるもの。
  - 例: `access=private`, `access=destination`, `hgv=destination`
- `warning`
  - 注意喚起。規制ではあるが即NGとは言い切らないもの。
  - 例: 条件付き規制をパースできない、データ信頼度が低い
- `info`
  - 表示用情報。
- `unknown`
  - 規制データ不足。PASS扱いにしない。必要なら `needs_confirmation` に寄与させる。

### 物理軸との二重計上を避ける

`max_height` / `max_width` / `max_weight` は「標識による法規制値（=規制軸）」として扱う。
これは物理軸が既に持つ実クリアランス判定とは **別エビデンス**であり、混ぜない。

- 規制軸: `maxheight=3.5` の標識タグ → 規制違反として `regulationAssessment` に出す。
- 物理軸: 橋・架線の実クリアランス（`vehicleRiskModel.heightClearance`）、道路幅員（`roadWidthModel` / `feasibility.estimateEffectiveRoadWidth`）→ 従来どおり physical 側で判定。

同一地点の同一原因（例: 高さ超過）を物理NGと規制NGの両方で重複表示しない。
理由表示では「規制: 高さ制限3.5m超過」「物理: 頭上クリアランス不足」のように、根拠の出所を分けて1件ずつ出す。

## OSMタグ対応 MVP

最初に対応するタグ。

### 通行可否

- `access=no`
- `access=private`
- `access=destination`
- `vehicle=no`
- `motor_vehicle=no`
- `motorcar=no`
- `truck=no`
- `hgv=no`
- `hgv=destination`
- `goods=no`

### 寸法/重量

- `maxheight`
- `maxheight:physical`
- `maxheight:legal`
- `maxheight:signed`
- `maxheight:conditional`
- `maxwidth`
- `maxwidth:physical`
- `maxwidth:legal`
- `maxwidth:signed`
- `maxwidth:conditional`
- `maxweight`
- `maxweight:conditional`

### 方向

- `oneway=yes`
- `oneway=1`
- `oneway=true`
- `oneway=-1`
- `oneway=reverse`
- `oneway:vehicle`
- `oneway:hgv`

### 条件付き規制

MVPでは完全な条件式パーサは作らない。

- `*:conditional` が存在する場合は規制候補として抽出する。
- 時刻条件を安全に解釈できない場合は `warning` または `permit_required` として出す。
- 後続で `opening_hours` 互換パーサを導入する。

### 後回し

- `turn:lanes`
- `restriction` relation
- スクールゾーン
- 速度規制
- 駐停車規制

## ルート判定への統合

### `src/core/deliveryAssessment.js`

`evaluateRoute()` の中で physical decision を作った後、regulation assessment を追加する。

想定結果:

```js
{
  physicalStatus: 'pass' | 'caution' | 'blocked',
  regulationStatus: 'pass' | 'warning' | 'permit_required' | 'blocked' | 'unknown',
  finalStatus: 'pass' | 'caution' | 'permit_required' | 'blocked' | 'needs_confirmation',
  regulationAssessment: {
    status: 'blocked',
    violations: [],
    warnings: [],
    unknowns: [],
    summary: {
      blockCount: 1,
      permitRequiredCount: 0,
      warningCount: 2,
      unknownCount: 0
    }
  }
}
```

既存の `overallStatus` はすぐ消さない。互換のため残し、内部で新しい `finalStatus` から導出する。

### finalStatus の決定ルール

1. physical が `blocked` なら `blocked`
2. regulation が `blocked` なら `blocked`
3. regulation が `permit_required` なら `permit_required`
4. physical が `caution` または regulation が `warning` なら `caution`
5. regulation が `unknown` なら `needs_confirmation`
6. それ以外は `pass`

### 既存 `overallStatus`（大文字）との互換マッピング（必須）

実コードの `computeOverallStatus()` は **大文字 `PASS` / `CONDITIONAL` / `NG`** を返す。
`overallStatus==='NG'` 等で分岐している既存コードを壊さないため、`finalStatus`（小文字）から
**必ず以下の対応で `overallStatus` を導出**して返し続ける。

| finalStatus | overallStatus（互換維持） |
|---|---|
| `pass` | `PASS` |
| `caution` | `CONDITIONAL` |
| `permit_required` | `CONDITIONAL` |
| `needs_confirmation` | `CONDITIONAL` |
| `blocked` | `NG` |

`overallStatus` は新ロジックでは内部導出値とし、外向きには当面そのまま温存する。

### 「許可あり」モード

既存の一方通行許可/最短ルート許可の思想と合わせる。

オプション例:

```js
{
  permitMode: false,
  ignoreOnewayWithPermit: false,
  allowPrivateWithPermit: false,
  allowHgvDestinationWithPermit: true
}
```

`permitMode=true` でも物理NGは通さない。変わるのは規制の severity だけ。

## ルートコリドー照合

MVPでは厳密な map matching を作り込まない。**距離判定は自前で書かず、既存関数を流用する。**

- 点→最寄り道のスナップ: `graph.js` の `projectToNearestWay`（export 済み）。
- 線分単位の方位＋距離マッチ: `api/overpass.js` の `bestHybridMatch`（GSI↔OSM 照合で実績、方位差28°・距離9m閾値）。規制点用に閾値だけ再調整する。

1. `routeLL` の各点または線分を使う。
2. 道路 feature の LineString と距離判定する（上記関数を利用）。
3. 閾値は 8m から開始し、設定化する。
4. 該当 feature 由来の regulation を候補にする。
5. 方向規制は、route segment の向きと feature の向きを比較する。

注意:

- `llToXZ` 系の表示座標ではなく、GeoJSON/turf の緯度経度で判定する。
- OSM道路と衛星画像のズレ問題を規制照合に持ち込まない。

## UI統合

最初は詳細UIを増やしすぎない。

### 最小表示

候補ルートカードまたは判定サマリに以下を出す。

- 物理: OK / 注意 / 不可
- 規制: OK / 注意 / 要許可 / 不可 / 要確認
- 主な理由 1-3件

例:

```text
物理: OK
規制: 要許可
理由: access=private の道路を含む / 一方通行逆向き 12m
```

### 詳細表示

Advanced / Diagnostics 側に出す。

- 規制種別
- source
- raw tag
- confidence
- 該当区間
- evidence URL

## 2D/3Dレイヤー

MVPでは2D優先。

- `blocked`: 赤
- `permit_required`: 橙
- `warning`: 黄
- `unknown`: 灰
- `info`: 青

3D表示は後続でよい。まず判定結果に出すことを優先する。

## 外部データ adapter 予定

### JARTIC traffic regulation adapter

JARTIC交通規制オープンデータを共通スキーマへ変換する。

- source: `jartic`
- authority: `JARTIC / 都道府県警察DB由来`
- confidence: OSMより高いが、公式注意書きに従い 1.0 にはしない。
- 実標識と完全一致しない場合があるため、最終運転判断では標識優先。

参考:

- https://www.jartic.or.jp/service/opendata/

### xROAD adapter

xROAD/道路データプラットフォーム由来の道路構造物・道路管理情報を共通スキーマへ変換する。

- source: `xroad`
- 橋梁、トンネル、横断歩道橋、門型標識などの構造物情報を頭上/重量/構造リスクへ接続する。

参考:

- https://www.xroad.mlit.go.jp/

### Municipal road ledger adapter

自治体の道路台帳、指定道路図、建築基準法道路種別を共通スキーマへ変換する。

- source: `municipal_ledger`
- `ledger_width`
- `designated_road`
- `private_road`
- `article42_road_type`

自治体ごとに形式が違うため、adapter 分離が必須。

## 実装ステップ

### Step 1: Core schema

- `src/core/regulationModel.js` を追加。
- enum、normalize、vehicle適用判定、status集約を実装。
- 単体の node 実行で基本ケースを確認。

### Step 2: OSM adapter

- `src/core/osmRegulationAdapter.js` を追加。
- OSM tags から規制配列を生成。
- `graph.js` の既存パース関数と重複する処理は、壊さない範囲で共通化。

### Step 3: Route assessment

- `deliveryAssessment.js` に `regulationAssessment` を追加。
- `geoJsonDataSets` から道路 feature を受け取り、ルート上の規制を評価。
- `overallStatus` 互換を維持しつつ、新しい `physicalStatus` / `regulationStatus` / `finalStatus` を返す。

### Step 4: Candidate route scoring

- `controls.js` または V2 の候補生成側で、規制違反をスコアへ反映。
- `blocked` は大幅減点または候補除外。
- `permit_required` は許可モードOFFなら減点、ONなら警告扱い。

### Step 5: UI summary

- index3D V2 のルート候補/判定結果に「物理」「規制」を分けて表示。
- 詳細は Advanced に隠す。

## 受入基準

- OSMタグから以下が規制として抽出される。
  - `hgv=no`
  - `access=private`
  - `maxheight=3.5`
  - `maxwidth=2.0`
  - `maxweight=4t`
  - `oneway=yes`
- 物理的に通れるルートでも、規制違反がある場合は `regulationStatus` が `blocked` または `permit_required` になる。
- `permitMode=false` と `permitMode=true` で一方通行/私道系の severity が変わる。
- 既存の物理判定、道路幅モデル、3D表示、車両寸法モデルが壊れない。
- `node --check` が通る。
- index3D V2 で既存ルート作成、3D worldロード、判定が実行できる。
- 日本語UIを触った場合、mojibake がない。

## 非目標

初回実装では以下をやらない。

- JARTIC/xROAD/自治体台帳の実取得
- 完全な時間帯条件パーサ
- restriction relation の完全対応
- 全国の規制データ網羅
- 法的な最終保証

本システムの出力は「搬入可否判断の支援」であり、実運転では現地標識、道路管理者、警察、許可条件を優先する。

## 実装時の注意

- 規制データが無いことを `PASS` と同一視しない。
- OSM由来の confidence は低めに扱う。
- 物理NGと規制NGを混ぜない。理由表示では必ず分ける。
- `graph.js` の経路探索ロジックを急に変更しない。まず後段判定として実装する。
- 既存の `deliveryAssessment` の戻り値を破壊しない。新フィールド追加から始める。
- 規制スキーマは source 非依存にする。OSM前提の名前を core に入れない。
