import fs from 'node:fs/promises';

const API_KEY = process.env.CLOUDBEDS_API_KEY;
const PROPERTY_ID = process.env.CLOUDBEDS_PROPERTY_ID || "161682624172278";
const TOTAL_ROOMS = Number(process.env.HM_TOTAL_ROOMS || 38);
const RATES_PATH = "data/rates.latest.json";

if (!API_KEY) {
  console.warn("Missing CLOUDBEDS_API_KEY. Skipping HM calendar monthly report.");
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
    month: Number(obj.month),
    day: Number(obj.day),
    date: `${obj.year}-${obj.month}-${obj.day}`
  };
}

function dateToIso(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + days);
  return dateToIso(d);
}

function lastDayOfMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function listDates(startDate, endDate) {
  const dates = [];
  let d = startDate;

  while (d <= endDate) {
    dates.push(d);
    d = addDays(d, 1);
  }

  return dates;
}

function isWeekendNight(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  const day = d.getDay();
  // 0 domingo, 1 lunes, ..., 5 viernes, 6 sábado
  return day === 5 || day === 6;
}

function monthKey(dateStr) {
  return dateStr.slice(0, 7);
}

function monthLabel(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  return new Intl.DateTimeFormat("es-MX", { month: "long", year: "numeric" }).format(d);
}

function validReservationStatus(status) {
  const s = String(status || "").toLowerCase();
  if (s.includes("cancel")) return false;
  if (s.includes("no_show")) return false;
  if (s.includes("noshow")) return false;
  return true;
}

function overlapsNight(reservation, date) {
  const start = reservation?.startDate;
  const end = reservation?.endDate;
  if (!start || !end) return false;
  return start <= date && end > date;
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
      if (attempt < retries) await sleep(3000 * attempt);
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

function calculateDay(date, assignments, reservationsById) {
  const occupiedRooms = new Map();

  for (const reservationAssignment of assignments) {
    const reservationID = reservationAssignment.reservationID;
    const reservation = reservationsById.get(reservationID);

    if (!reservation || !overlapsNight(reservation, date)) continue;

    for (const room of reservationAssignment.assigned || []) {
      if (!room.roomID) continue;

      occupiedRooms.set(`${reservationID}-${room.roomID}`, {
        reservationID,
        roomTypeName: room.roomTypeName,
        roomName: room.roomName,
        roomID: room.roomID
      });
    }
  }

  const roomsSoldRaw = occupiedRooms.size;
  const roomsSold = Math.min(roomsSoldRaw, TOTAL_ROOMS);
  const roomsAvailable = Math.max(TOTAL_ROOMS - roomsSold, 0);
  const occupancyPct = TOTAL_ROOMS ? roomsSold / TOTAL_ROOMS : null;

  return {
    date,
    roomsTotal: TOTAL_ROOMS,
    roomsSold,
    roomsSoldRaw,
    roomsAvailable,
    occupancyPct,
    occupancyPctLabel: occupancyPct == null ? null : `${Math.round(occupancyPct * 100)}%`,
    segment: isWeekendNight(date) ? "weekend" : "weekday"
  };
}

function buildSegment(days) {
  const totalRoomNights = days.reduce((a, d) => a + (Number(d.roomsTotal) || 0), 0);
  const soldRoomNights = days.reduce((a, d) => a + (Number(d.roomsSold) || 0), 0);
  const availableRoomNights = days.reduce((a, d) => a + (Number(d.roomsAvailable) || 0), 0);
  const occupancyPct = totalRoomNights > 0 ? soldRoomNights / totalRoomNights : null;

  return {
    days: days.length,
    totalRoomNights,
    soldRoomNights,
    availableRoomNights,
    occupancyPct,
    occupancyPctLabel: occupancyPct == null ? null : `${Math.round(occupancyPct * 100)}%`
  };
}

function buildMonthlyCalendar(days) {
  const groups = new Map();

  for (const day of days) {
    const key = monthKey(day.date);

    if (!groups.has(key)) {
      groups.set(key, {
        month: key,
        label: monthLabel(day.date),
        days: []
      });
    }

    groups.get(key).days.push(day);
  }

  return Array.from(groups.values()).map(group => {
    const weekendDays = group.days.filter(d => d.segment === "weekend");
    const weekdayDays = group.days.filter(d => d.segment === "weekday");

    return {
      month: group.month,
      label: group.label,
      total: buildSegment(group.days),
      weekend: {
        label: "Fin de Semana",
        definition: "Noches de viernes y sábado",
        ...buildSegment(weekendDays)
      },
      weekday: {
        label: "Entre Semana",
        definition: "Noches de domingo a jueves",
        ...buildSegment(weekdayDays)
      },
      avgCloudbedsRate: null,
      avgCloudbedsRateLabel: "Pendiente"
    };
  });
}

const today = mexicoTodayParts();
const year = today.year;
const month = today.month;

const startDate = `${year}-01-01`;
const endDate = `${year}-${String(month).padStart(2, "0")}-${String(lastDayOfMonth(year, month)).padStart(2, "0")}`;

console.log(`Building HM calendar monthly report ${startDate} to ${endDate}...`);
console.log("Fetching Cloudbeds reservations...");

let reservationsById = new Map();

try {
  reservationsById = await fetchReservationsForWindow(startDate, endDate);
  console.log(`Reservations loaded: ${reservationsById.size}`);
} catch (err) {
  console.warn(`Cloudbeds reservations fetch failed. Continuing with empty calendar data. ${err.message}`);
}

const dates = listDates(startDate, endDate);
const dayRows = [];

for (const date of dates) {
  console.log(`Calendar HM ${date}...`);

  try {
    const assignments = await fetchAssignments(date);
    dayRows.push(calculateDay(date, assignments, reservationsById));
  } catch (err) {
    dayRows.push({
      date,
      roomsTotal: TOTAL_ROOMS,
      roomsSold: null,
      roomsSoldRaw: null,
      roomsAvailable: null,
      occupancyPct: null,
      occupancyPctLabel: null,
      segment: isWeekendNight(date) ? "weekend" : "weekday",
      error: err.message
    });
  }
}

const rates = JSON.parse(await fs.readFile(RATES_PATH, "utf8"));

rates.hmCalendarMonthly = {
  generatedAt: new Date().toISOString(),
  source: "Cloudbeds API",
  period: {
    year,
    startDate,
    endDate,
    currentMonth: month
  },
  methodology: "Histórico/acumulado del año calendario actual: enero al mes en curso. Fin de Semana = noches de viernes y sábado. Entre Semana = noches de domingo a jueves. Ocupación calculada como room nights vendidas / room nights totales. No incluye meses futuros.",
  months: buildMonthlyCalendar(dayRows),
  daysDetail: dayRows
};

await fs.writeFile(RATES_PATH, JSON.stringify(rates, null, 2));

console.log("Done. Added HM calendar monthly report to data/rates.latest.json");
