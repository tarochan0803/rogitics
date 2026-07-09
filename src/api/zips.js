async function postJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  let json = null;
  try {
    json = await res.json();
  } catch (e) {}

  if (!res.ok) {
    throw new Error(json?.error || `ZIPS proxy error: ${res.status}`);
  }
  return json;
}

export async function addressToBluemap(address) {
  const query = String(address || '').trim();
  if (!query) throw new Error('address is empty');
  return postJson('/api/zips/address-to-bluemap', { address: query });
}

export async function bluemapToAddress(bluemap) {
  const query = String(bluemap || '').trim();
  if (!query) throw new Error('bluemap is empty');
  return postJson('/api/zips/bluemap-to-address', { bluemap: query });
}
