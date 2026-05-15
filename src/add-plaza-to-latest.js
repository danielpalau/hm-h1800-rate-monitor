import fs from 'node:fs/promises';

const ROOM_MAP_PATH = 'data/room-map.json';
const RATES_PATH = 'data/rates.latest.json';

function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function moneyRound(n) {
  const value = Number(n);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function isBadPricePath(path) {
  return /tax|impuesto|iva|fee|discount|coupon|child|children|adult|max|pax|id|order|image|photo|latitude|longitude|available|availability|inventory|rooms_available|night_count/i.test(path);
}

function looksLikePricePath(path) {
  return /price|rate|amount|total|subtotal|base|tarifa|cost|mxn|payment/i.test(path);
}

function collectPriceCandidates(obj, path = '') {
  const out = [];

  if (obj == null) return out;

  if (typeof obj === 'number') {
    if (!isBadPricePath(path) && looksLikePricePath(path) && obj >= 1000 && obj <= 30000) {
      out.push({ path, value: obj });
    }
    return out;
  }

  if (typeof obj === 'string') {
    const s = obj.replace(/,/g, '');
    const m = s.match(/(?:\$|MXN|mxn)?\s*([0-9]{1,6}(?:\.[0-9]{2})?)\s*(?:MXN|mxn)?/);
    if (m && !isBadPricePath(path) && (looksLikePricePath(path) || /[$]|MXN/i.test(obj))) {
      const v = Number(m[1]);
      if (v >= 1000 && v <= 30000) out.push({ path, value: v });
    }
    return out;
  }

  if (Array.isArray(obj)) {
    obj.forEach((v, i) => out.push(...collectPriceCandidates(v, `${path}[${i}]`)));
    return out;
  }

  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      out.push(...collectPriceCandidates(v, path ? `${path}.${k}` : k));
    }
  }

  return out;
}

function extractRoomPrice(room) {
  const candidates = collectPriceCandidates(room)
    .filter(c => c.value >= 1000 && c.value <= 30000);

  if (!candidates.length) return null;

  // Preferir campos que suenan a precio final/tarifa, pero evitar impuestos.
  const preferred = candidates.filter(c =>
    /price|rate|amount|total|tarifa|subtotal|base/i.test(c.path) &&
    !/tax|impuesto|iva/i.test(c.path)
  );

  const chosen = preferred.length ? preferred : candidates;

  // Usamos el menor precio válido porque suele ser tarifa web antes de impuestos.
  return moneyRound(Math.min(...chosen.map(c => c.value)));
}

async function fetchPlazaRates(checkIn, checkOut) {
  const url = `https://booking.zaviaerp.com/api/room-types?hotel_id=4cienegas&lang=es&arrival=${checkIn}&departure=${checkOut}&adults=2&children=0&infants=0&promotion_slug=&slug=&coupon=&currency=MXN&google=0&adType=0&mobile=false`;

  const res = await fetch(url, {
    headers: {
      'accept': 'application/json,text/plain,*/*',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/147 Safari/537.36'
    }
  });

  if (!res.ok) {
    throw new Error(`Zavia API ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  const rooms = json.rooms || [];

  const byName = {};
  for (const room of rooms) {
    const name = String(room.name || '').trim();
    const price = extractRoomPrice(room);
    byName[name] = {
      name,
      price,
      rawKeys: Object.keys(room)
    };
  }

  return { url, rooms, byName };
}

function findPlazaPrice(plazaData, aliases = []) {
  const normalizedAliases = aliases.map(normalize).filter(Boolean);

  for (const room of plazaData.rooms || []) {
    const nName = normalize(room.name);
    const match = normalizedAliases.some(alias => nName.includes(alias) || alias.includes(nName));
    if (!match) continue;

    return extractRoomPrice(room);
  }

  return null;
}

function statusFromPct(pct) {
  if (pct == null || !Number.isFinite(pct)) return 'missing_data';
  return Math.abs(pct) >= 0.10 ? 'high_discrepancy' : 'ok';
}

const roomMap = JSON.parse(await fs.readFile(ROOM_MAP_PATH, 'utf8'));
const rates = JSON.parse(await fs.readFile(RATES_PATH, 'utf8'));

rates.sources = {
  ...(rates.sources || {}),
  hm: 'Cloudbeds',
  h1800: 'Omnibees',
  plaza: 'ZaviaERP'
};

rates.urls = {
  ...(rates.urls || {}),
  plazaBase: 'https://rbe.zaviaerp.com/hotel/4cienegas?lang=es&currency=MXN'
};

rates.plazaAddedAt = new Date().toISOString();

for (const day of rates.days || []) {
  const checkIn = day.date;
  const checkOut = day.checkOut;

  console.log(`Adding Plaza ${checkIn}...`);

  let plazaData;
  try {
    plazaData = await fetchPlazaRates(checkIn, checkOut);
  } catch (err) {
    day.plazaError = err.message;
    continue;
  }

  day.urls = {
    ...(day.urls || {}),
    plaza: plazaData.url
  };

  day.extraction = {
    ...(day.extraction || {}),
    plazaCandidates: plazaData.rooms.length
  };

  for (const row of day.rows || []) {
    const mapRow = roomMap.find(r => r.hm === row.hm) || {};
    const plazaName = mapRow.plaza || null;
    const plazaAliases = mapRow.plaza_aliases || (plazaName ? [plazaName] : []);

    const plazaDirect = findPlazaPrice(plazaData, plazaAliases);

    row.plaza = plazaName;
    row.plazaDirect = plazaDirect;

    if (row.hmDirect != null && plazaDirect != null) {
      row.diffPlaza = row.hmDirect - plazaDirect;
      row.pctPlaza = row.diffPlaza / plazaDirect;
      row.statusPlaza = statusFromPct(row.pctPlaza);
    } else {
      row.diffPlaza = null;
      row.pctPlaza = null;
      row.statusPlaza = 'missing_data';
    }
  }
}

await fs.writeFile(RATES_PATH, JSON.stringify(rates, null, 2));

console.log(`Done. Updated ${RATES_PATH} with Plaza.`);
