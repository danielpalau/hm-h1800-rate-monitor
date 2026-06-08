import fs from 'node:fs/promises';

const API_KEY = process.env.CLOUDBEDS_API_KEY;
const PROPERTY_ID = process.env.CLOUDBEDS_PROPERTY_ID || "161682624172278";
const RATES_PATH = "data/rates.latest.json";

if (!API_KEY) {
  console.warn("Missing CLOUDBEDS_API_KEY. Skipping Cloudbeds monthly rate details.");
  process.exit(0);
}

const headers = {
  "accept": "application/json",
  "Authorization": `Bearer ${API_KEY}`
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function mexicoTodayParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const obj = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return {
    year: Number(obj.year),
    month: Number(obj.month)
  };
}

function lastDayOfMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function monthLabel(monthKey) {
  const d = new Date(monthKey + "-01T12:00:00");
  return new Intl.DateTimeFormat("es-MX", { month: "long", year: "numeric" }).format(d);
}

function monthKey(dateStr) {
  return dateStr.slice(0, 7);
}

async function cloudbedsGet(url, options = {}) {
  const retries = options.retries ?? 4;
  const timeoutMs = options.timeoutMs ?? 30000;
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      const text = await res.text();
      clearTimeout(timer);

      if (!res.ok) {
        throw new Error(`Cloudbeds ${res.status}: ${text.slice(0, 300)}`);
      }

      const json = JSON.parse(text);

      if (!json.success) {
        throw new Error(`Cloudbeds error: ${json.message || text.slice(0, 300)}`);
      }

      return json;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      console.warn(`Cloudbeds rate details request failed attempt ${attempt}/${retries}: ${err.message}`);
      if (attempt < retries) await sleep(3000 * attempt);
    }
  }

  throw lastError;
}

async function fetchRateDetails(resultsFrom, resultsTo) {
  const all = [];
  let pageNumber = 1;
  const pageSize = 100;

  while (true) {
    const url =
      `https://api.cloudbeds.com/api/v1.3/getReservationsWithRateDetails` +
      `?propertyID=${PROPERTY_ID}` +
      `&resultsFrom=${encodeURIComponent(resultsFrom)}` +
      `&resultsTo=${encodeURIComponent(resultsTo)}` +
      `&pageNumber=${pageNumber}` +
      `&pageSize=${pageSize}`;

    const json = await cloudbedsGet(url);
    const data = json.data || [];
    all.push(...data);

    if (data.length < pageSize) break;

    pageNumber++;
    if (pageNumber > 100) break;
  }

  return all;
}

function validStatus(status) {
  const s = String(status || "").toLowerCase();
  if (s.includes("cancel")) return false;
  if (s.includes("no_show")) return false;
  if (s.includes("noshow")) return false;
  return true;
}

function collectNightRates(reservations, startDate, endDate) {
  const byMonth = new Map();

  for (const reservation of reservations) {
    if (!validStatus(reservation.status)) continue;

    for (const room of reservation.rooms || []) {
      const detailed = room.detailedRoomRates || {};

      for (const [date, rateRaw] of Object.entries(detailed)) {
        if (date < startDate || date > endDate) continue;

        const rate = Number(rateRaw);
        if (!Number.isFinite(rate) || rate <= 0) continue;

        const key = monthKey(date);

        if (!byMonth.has(key)) {
          byMonth.set(key, {
            month: key,
            label: monthLabel(key),
            roomNightsWithRate: 0,
            roomRevenue: 0,
            rates: []
          });
        }

        const m = byMonth.get(key);
        m.roomNightsWithRate += 1;
        m.roomRevenue += rate;
        m.rates.push(rate);
      }
    }
  }

  return byMonth;
}

const today = mexicoTodayParts();
const year = today.year;
const month = today.month;

const startDate = `${year}-01-01`;
const endDate = `${year}-${String(month).padStart(2, "0")}-${String(lastDayOfMonth(year, month)).padStart(2, "0")}`;

console.log(`Fetching Cloudbeds rate details ${startDate} to ${endDate}...`);

let reservations = [];

try {
  reservations = await fetchRateDetails(`${startDate} 00:00:00`, `${endDate} 23:59:59`);
  console.log(`Rate detail reservations loaded: ${reservations.length}`);
} catch (err) {
  console.warn(`Cloudbeds rate details failed. Continuing without ADR. ${err.message}`);
}

const byMonth = collectNightRates(reservations, startDate, endDate);

const rates = JSON.parse(await fs.readFile(RATES_PATH, "utf8"));

if (!rates.hmCalendarMonthly?.months) {
  console.warn("No hmCalendarMonthly.months found. Run add-hm-calendar-monthly.js first.");
  process.exit(0);
}

for (const monthRow of rates.hmCalendarMonthly.months) {
  const detail = byMonth.get(monthRow.month);

  if (!detail || !detail.roomNightsWithRate) {
    monthRow.avgCloudbedsRate = null;
    monthRow.avgCloudbedsRateLabel = "Pendiente";
    monthRow.cloudbedsRevenue = null;
    monthRow.cloudbedsRoomNightsWithRate = 0;
    continue;
  }

  const adr = Math.round(detail.roomRevenue / detail.roomNightsWithRate);

  monthRow.avgCloudbedsRate = adr;
  monthRow.avgCloudbedsRateLabel = `$${adr.toLocaleString("es-MX")}`;
  monthRow.cloudbedsRevenue = Math.round(detail.roomRevenue);
  monthRow.cloudbedsRoomNightsWithRate = detail.roomNightsWithRate;
}

rates.hmCalendarMonthly.rateDetails = {
  generatedAt: new Date().toISOString(),
  source: "Cloudbeds API getReservationsWithRateDetails",
  methodology: "ADR mensual calculado con rooms[].detailedRoomRates: revenue de noches con tarifa / room nights con tarifa.",
  period: {
    startDate,
    endDate
  }
};

await fs.writeFile(RATES_PATH, JSON.stringify(rates, null, 2));

console.log("Done. Added Cloudbeds monthly ADR from rate details.");
