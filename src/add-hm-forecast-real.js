import fs from 'node:fs/promises';

const API_KEY = process.env.CLOUDBEDS_API_KEY;
const PROPERTY_ID = process.env.CLOUDBEDS_PROPERTY_ID || "161682624172278";
const TOTAL_ROOMS = Number(process.env.HM_TOTAL_ROOMS || 38);
const FORECAST_DAYS = Number(process.env.HM_FORECAST_DAYS || 90);
const RATES_PATH = "data/rates.latest.json";

if (!API_KEY) {
  console.warn("Missing CLOUDBEDS_API_KEY. Skipping HM forecast.");
  process.exit(0);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const headers = {
  "accept": "application/json",
  "Authorization": `Bearer ${API_KEY}`
};

function addDays(dateStr, days) {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function avg(values) {
  const nums = values.filter(v => Number.isFinite(v));
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

function sum(values) {
  return values.filter(v => Number.isFinite(v)).reduce((a, b) => a + b, 0);
}

function pct(v) {
  return Number.isFinite(v) ? Math.round(v * 1000) / 10 : null;
}

function overlapsNight(reservation, date) {
  const start = reservation?.startDate;
  const end = reservation?.endDate;
  if (!start || !end) return false;

  // Ocupa la noche si llegó antes o ese día, y sale después de ese día.
  return start <= date && end > date;
}

function validReservationStatus(status) {
  const s = String(status || "").toLowerCase();
  if (s.includes("cancel")) return false;
  if (s.includes("no_show")) return false;
  if (s.includes("noshow")) return false;
  return true;
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
      console.warn(`Cloudbeds request failed attempt ${attempt}/${retries}: ${err.message}`);

      if (attempt < retries) {
        await sleep(3000 * attempt);
      }
    }
  }

  throw lastError;
}

async function fetchAssignments(date) {
  const url = `https://api.cloudbeds.com/api/v1.3/getReservationAssignments?propertyID=${PROPERTY_ID}&date=${date}`;
  const json = await cloudbedsGet(url);
  return json.data || [];
}

async function fetchReservationsForWindow(firstDate, lastDate) {
  const checkInFrom = addDays(firstDate, -370);
  const checkInTo = lastDate;

  const reservationsById = new Map();
  let pageNumber = 1;
  const pageSize = 100;

  while (true) {
    const url =
      `https://hotels.cloudbeds.com/api/v1.2/getReservations` +
      `?propertyID=${PROPERTY_ID}` +
      `&checkInFrom=${checkInFrom}` +
      `&checkInTo=${checkInTo}` +
      `&pageNumber=${pageNumber}` +
      `&pageSize=${pageSize}`;

    const json = await cloudbedsGet(url);
    const data = json.data || [];

    let newItems = 0;

    for (const r of data) {
      if (!r.reservationID) continue;
      if (!validReservationStatus(r.status)) continue;

      if (!reservationsById.has(r.reservationID)) {
        reservationsById.set(r.reservationID, r);
        newItems++;
      }
    }

    if (data.length < pageSize || newItems === 0) break;

    pageNumber++;
    if (pageNumber > 100) break;
  }

  return reservationsById;
}

function calculateDayForecast(assignments, reservationsById, date) {
  const occupiedRooms = new Map();

  for (const reservationAssignment of assignments) {
    const reservationID = reservationAssignment.reservationID;
    const reservation = reservationsById.get(reservationID);

    if (!reservation || !overlapsNight(reservation, date)) continue;

    for (const room of reservationAssignment.assigned || []) {
      if (!room.roomID) continue;

      occupiedRooms.set(`${reservationID}-${room.roomID}`, {
        reservationID,
        guestName: reservationAssignment.guestName,
        roomTypeName: room.roomTypeName,
        roomTypeNameShort: room.roomTypeNameShort,
        roomName: room.roomName,
        roomID: room.roomID,
        startDate: reservation.startDate,
        endDate: reservation.endDate
      });
    }
  }

  const roomsSoldRaw = occupiedRooms.size;
  const roomsSold = Math.min(roomsSoldRaw, TOTAL_ROOMS);
  const roomsAvailable = Math.max(TOTAL_ROOMS - roomsSold, 0);
  const occupancyPct = TOTAL_ROOMS ? roomsSold / TOTAL_ROOMS : null;

  const byRoomType = {};
  for (const r of occupiedRooms.values()) {
    const key = r.roomTypeName || "Unknown";
    byRoomType[key] = (byRoomType[key] || 0) + 1;
  }

  let status = "normal";
  let recommendation = "Mantener monitoreo";

  if (Number.isFinite(occupancyPct)) {
    if (occupancyPct >= 0.85) {
      status = "alta_ocupacion";
      recommendation = "Proteger inventario / revisar alza tarifaria";
    } else if (occupancyPct <= 0.35) {
      status = "baja_ocupacion";
      recommendation = "Impulsar demanda / revisar campañas";
    } else if (occupancyPct >= 0.65) {
      status = "buena_ocupacion";
      recommendation = "Monitorear pickup / posible alza moderada";
    }
  }

  return {
    date,
    roomsTotal: TOTAL_ROOMS,
    roomsSold,
    roomsSoldRaw,
    roomsAvailable,
    occupancyPct,
    occupancyPctLabel: occupancyPct == null ? null : `${Math.round(occupancyPct * 100)}%`,
    byRoomType,
    status,
    recommendation
  };
}

function buildWindow(days, windowDays) {
  const selected = days.slice(0, windowDays);

  const occupancies = selected.map(d => d.occupancyPct).filter(v => Number.isFinite(v));
  const sold = selected.map(d => d.roomsSold).filter(v => Number.isFinite(v));
  const available = selected.map(d => d.roomsAvailable).filter(v => Number.isFinite(v));

  return {
    windowDays,
    daysIncluded: selected.length,
    firstDate: selected[0]?.date || null,
    lastDate: selected[selected.length - 1]?.date || null,

    avgOccupancyPct: pct(avg(occupancies)),
    avgOccupancyLabel: avg(occupancies) == null ? null : `${Math.round(avg(occupancies) * 100)}%`,

    totalRoomNightsSold: sum(sold),
    totalRoomNightsAvailable: sum(available),

    highOccupancyDays: selected.filter(d => (d.occupancyPct ?? 0) >= 0.85).length,
    mediumHighOccupancyDays: selected.filter(d => {
      const o = d.occupancyPct;
      return Number.isFinite(o) && o >= 0.65 && o < 0.85;
    }).length,
    lowOccupancyDays: selected.filter(d => {
      const o = d.occupancyPct;
      return Number.isFinite(o) && o <= 0.35;
    }).length,

    topHighOccupancyDates: selected
      .filter(d => d.status === "alta_ocupacion")
      .slice(0, 10),

    topLowOccupancyDates: selected
      .filter(d => d.status === "baja_ocupacion")
      .slice(0, 10),

    daysDetail: selected
  };
}

const rates = JSON.parse(await fs.readFile(RATES_PATH, "utf8"));
const baseDate = rates.days?.[0]?.date || new Date().toISOString().slice(0, 10);
const lastDate = addDays(baseDate, FORECAST_DAYS - 1);

console.log(`Building real HM forecast ${baseDate} to ${lastDate}...`);
console.log(`Fetching Cloudbeds reservations...`);

let reservationsById = new Map();

try {
  reservationsById = await fetchReservationsForWindow(baseDate, lastDate);
  console.log(`Reservations loaded: ${reservationsById.size}`);
} catch (err) {
  console.warn(`Cloudbeds reservations fetch failed for HM forecast. Continuing with empty forecast data. ${err.message}`);
}

const forecastDays = [];

for (let i = 0; i < FORECAST_DAYS; i++) {
  const date = addDays(baseDate, i);
  console.log(`Forecast HM ${date}...`);

  try {
    const assignments = await fetchAssignments(date);
    forecastDays.push(calculateDayForecast(assignments, reservationsById, date));
  } catch (err) {
    forecastDays.push({
      date,
      roomsTotal: TOTAL_ROOMS,
      roomsSold: null,
      roomsSoldRaw: null,
      roomsAvailable: null,
      occupancyPct: null,
      occupancyPctLabel: null,
      byRoomType: {},
      status: "error",
      recommendation: "Error consultando Cloudbeds",
      error: err.message
    });
  }
}

rates.hmForecast = {
  generatedAt: new Date().toISOString(),
  demoMode: false,
  source: "Cloudbeds API",
  methodology: "Forecast interno real de Hotel Marielena basado en ocupación futura de Cloudbeds. No incluye comp set. ADR y revenue quedan pendientes hasta conectar rate details real.",
  windows: {
    "30": buildWindow(forecastDays, 30),
    "60": buildWindow(forecastDays, 60),
    "90": buildWindow(forecastDays, 90)
  }
};

await fs.writeFile(RATES_PATH, JSON.stringify(rates, null, 2));

console.log("Done. Added real HM forecast 30/60/90 to data/rates.latest.json");
