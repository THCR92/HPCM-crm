// Delivery charge from the shop to the job (Tyler 2026-11-12): $50 within 8 miles of
// 805 E Fox Farm Rd; farther than that, $50 plus $0.55 a mile for the round trip
// (there and back). Miles are driving miles, one way, from free public map services:
// the US Census geocoder finds the address and OSRM finds the road distance. If either
// can't answer, the charge is left for the office to fill in.
const SHOP = { lon: -104.790844, lat: 41.116555 }; // 805 E Fox Farm Rd, Cheyenne (Census geocoder)
const BASE = 50;
const FREE_MILES = 8;
const PER_MILE = 0.55;

const chargeFor = (miles) => (miles <= FREE_MILES ? BASE : Math.round((BASE + PER_MILE * miles * 2) * 100) / 100);

// Kept for the day, so typing the same address twice doesn't ask again.
const cache = new Map();
const io = {
  async getJson(url) {
    const res = await fetch(url, { headers: { 'User-Agent': 'HPCM-CRM/1.0' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
};

async function geocode(address) {
  const census = await io.getJson(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${new URLSearchParams({
    address, benchmark: 'Public_AR_Current', format: 'json' })}`).catch(() => null);
  const m = census && census.result && census.result.addressMatches && census.result.addressMatches[0];
  if (m) return { lon: m.coordinates.x, lat: m.coordinates.y, matched: m.matchedAddress };
  // Not a street address the Census knows (new subdivisions, rural routes): try OpenStreetMap.
  const osm = await io.getJson(`https://nominatim.openstreetmap.org/search?${new URLSearchParams({
    q: address, format: 'json', limit: '1', countrycodes: 'us' })}`).catch(() => null);
  if (osm && osm[0]) return { lon: Number(osm[0].lon), lat: Number(osm[0].lat), matched: osm[0].display_name };
  return null;
}

// { miles, charge, matched } or { error } in plain words.
async function quote(address) {
  const key = String(address || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (key.length < 6) return { error: 'Enter the job address to figure delivery.' };
  const day = new Date().toDateString();
  const hit = cache.get(key);
  if (hit && hit.day === day) return hit.result;
  let result;
  try {
    const at = await geocode(address);
    if (!at) {
      result = { error: 'Couldn\'t find that address on the map. Check it, or the office will set the delivery charge.' };
    } else {
      const route = await io.getJson(`https://router.project-osrm.org/route/v1/driving/${SHOP.lon},${SHOP.lat};${at.lon},${at.lat}?overview=false`);
      if (!route || route.code !== 'Ok' || !route.routes || !route.routes[0]) throw new Error('no route');
      const miles = Math.round((route.routes[0].distance / 1609.344) * 10) / 10;
      result = { miles, charge: chargeFor(miles), matched: at.matched };
    }
  } catch (err) {
    return { error: 'The map service didn\'t answer, so the office will set the delivery charge.' };
  }
  cache.set(key, { day, result });
  return result;
}

const RULE = `$${BASE} within ${FREE_MILES} miles of our shop; farther, $${BASE} plus $${PER_MILE.toFixed(2)} a mile round trip`;

module.exports = { quote, chargeFor, io, RULE, BASE, FREE_MILES, PER_MILE };
