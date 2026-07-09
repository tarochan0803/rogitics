/**
 * worldLoader.js — コンパイル済みワールド(world_<hash>.json)をアプリへ読み込む（Phase 1）
 *
 * localWorldBuilder（オンライン取得）の二重化。ネット切断でも hash 検証済みの
 * 焼き込みデータで経路確定→自動走行→判定を回せるようにする入口。
 */

import { parseWorld } from './worldFile.js';
import { buildOsmRegulationLayer } from '../core/osmRegulationAdapter.js';
import { setActiveExternalRegulations } from '../core/jarticRegulationAdapter.js';

/**
 * applyWorldToStore(jsonOrObj, store) -> { hash, hashOk, roads, buildings, regulations }
 * hash不一致（改変/破損）は例外。store は state.js の store。
 * 規制: 焼き込み済みOSM way(生タグ)を正規化し、外部規制キャッシュ
 * (getActiveExternalRegulations) に載せる → 既存の搬入判定がそのまま読む。
 */
export function applyWorldToStore(jsonOrObj, store) {
  const { world, hashOk, expectedHash } = parseWorld(jsonOrObj);
  if (!hashOk) {
    throw new Error(`world hash mismatch: file=${world.hash} computed=${expectedHash}（改変または破損）`);
  }
  const roads = world.layers?.roads || [];
  const buildings = world.layers?.buildings || [];
  store.setGeoJsonDataSets(roads);
  store.setBuildingsGeoJSON(buildings);
  // ワールド差し替え時は前回のオンライン読込レイヤも必ず更新/クリアする
  //（残すと前AOIの歩道・PLATEAUタイルが混在表示される）。
  if (typeof store.setSidewalkGeoJSON === 'function') {
    store.setSidewalkGeoJSON(world.layers?.sidewalks || []);
  }
  if (typeof store.setState === 'function') {
    store.setState({
      plateauTileset: world.layers?.plateauTileset || null,
      compiledWorldHash: world.hash
    });
  }
  if (typeof window !== 'undefined') {
    window.PLATEAU_AUTO_TILESET = world.layers?.plateauTileset || null;
  }

  // 規制0件のワールドでも必ず setActiveExternalRegulations を通す。
  // 通さないと前回ワールドの外部規制が残留し、別AOIの判定に混入する。
  const regFeatures = world.layers?.regulations || [];
  const layer = regFeatures.length ? buildOsmRegulationLayer(regFeatures) : [];
  const regulations = setActiveExternalRegulations(layer);
  return {
    hash: world.hash, hashOk,
    roads: roads.length, buildings: buildings.length, regulations,
    demSamples: (world.layers?.demProfile || []).length
  };
}
