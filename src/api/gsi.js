export async function fetchGsiRoads(bounds) {
  const z = 16;
  const { north, south, west, east } = bounds;
  const minX = Math.floor((west + 180) / 360 * Math.pow(2, z));
  const maxX = Math.floor((east + 180) / 360 * Math.pow(2, z));
  const minY = Math.floor((1 - Math.log(Math.tan(north * Math.PI / 180) + 1 / Math.cos(north * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, z));
  const maxY = Math.floor((1 - Math.log(Math.tan(south * Math.PI / 180) + 1 / Math.cos(south * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, z));

  const features = [];
  const fetches = [];
  
  // GSIサーバーに過度な負荷をかけないよう、最大タイル数を制限する
  if ((maxX - minX + 1) * (maxY - minY + 1) > 400) {
      console.warn("[GSI] 取得範囲が広すぎます。");
      throw new Error("GSIベクトルタイルの取得範囲が広すぎます。もう少しズームインしてください。");
  }

  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      const url = `https://cyberjapandata.gsi.go.jp/xyz/experimental_rdcl/${z}/${x}/${y}.geojson`;
      fetches.push(
        fetch(url, { mode: 'cors' })
          .then(res => res.ok ? res.json() : null)
          .catch(() => null)
      );
    }
  }

  const results = await Promise.all(fetches);
  const dedupe = new Set();

  function widthRangeFromRank(rnkWidth) {
    const text = String(rnkWidth ?? '').trim();
    const rank = Number(rnkWidth);
    if (rank === 1) {
      return { min: 13.0, max: null, estimate: 13.0, confidence: 0.72, label: '13m+' };
    }
    if (rank === 2) {
      return { min: 5.5, max: 13.0, estimate: 5.5, confidence: 0.74, label: '5.5-13m' };
    }
    if (rank === 3) {
      return { min: 3.0, max: 5.5, estimate: 3.0, confidence: 0.74, label: '3-5.5m' };
    }
    if (rank === 4) {
      return { min: null, max: 3.0, estimate: 2.5, confidence: 0.62, label: '<3m' };
    }
    if (/19\.?5\s*m.*(以上|\+)/i.test(text)) {
      return { min: 19.5, max: null, estimate: 19.5, confidence: 0.72, label: '19.5m+' };
    }
    if (/13\s*m.*19\.?5/i.test(text)) {
      return { min: 13.0, max: 19.5, estimate: 13.0, confidence: 0.74, label: '13-19.5m' };
    }
    if (/13\s*m.*(以上|\+)/i.test(text)) {
      return { min: 13.0, max: null, estimate: 13.0, confidence: 0.72, label: '13m+' };
    }
    if (/5\.?5\s*m.*13\s*m/i.test(text)) {
      return { min: 5.5, max: 13.0, estimate: 5.5, confidence: 0.74, label: '5.5-13m' };
    }
    if (/3\s*m.*5\.?5\s*m/i.test(text)) {
      return { min: 3.0, max: 5.5, estimate: 3.0, confidence: 0.74, label: '3-5.5m' };
    }
    if (/3\s*m.*(未満|以下)|(-3m|<\s*3)/i.test(text)) {
      return { min: null, max: 3.0, estimate: 2.5, confidence: 0.62, label: '<3m' };
    }
    return { min: null, max: null, estimate: null, confidence: 0.25, label: 'unknown' };
  }

  for (const data of results) {
    if (data && data.features) {
      for (const f of data.features) {
        if (!f.geometry || (f.geometry.type !== 'LineString' && f.geometry.type !== 'MultiLineString')) continue;
        
        const rID = f.properties.rID || Math.random().toString(36).slice(2);
        if (dedupe.has(rID)) continue;
        dedupe.add(rID);

        // GSIの幅員ランクを単一値に潰さず、範囲 + 保守的推定値として保持する。
        // rnkWidth: 1(13m-), 2(5.5-13m), 3(3-5.5m), 4(-3m), 0(不明)
        const rnkWidth = f.properties.rnkWidth;
        const widthRange = widthRangeFromRank(rnkWidth);
        let highway = 'unclassified';
        if (widthRange.min >= 13) highway = 'primary';
        else if (widthRange.min >= 5.5) highway = 'secondary';
        else if (widthRange.min >= 3) highway = 'tertiary';
        else if (widthRange.max === 3) highway = 'residential';

        // GSIプロパティをOSMライクにラップ
        f.properties = {
          ...f.properties,
          id: `gsi-${rID}`,
          highway: highway,
          gsiRnkWidth: rnkWidth,
          gsiWidthMin: widthRange.min,
          gsiWidthMax: widthRange.max,
          gsiWidthEstimate: widthRange.estimate,
          gsiWidthConfidence: widthRange.confidence,
          gsiWidthLabel: widthRange.label,
          widthSource: 'gsi:rnkWidth',
          widthConfidence: widthRange.confidence,
          name: f.properties.name || '',
          source: 'GSI'
        };
        features.push(f);
      }
    }
  }
  return features;
}
