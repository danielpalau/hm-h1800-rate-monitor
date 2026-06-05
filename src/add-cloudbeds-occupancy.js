import fs from 'node:fs/promises';

const API_KEY = process.env.CLOUDBEDS_API_KEY;
const PROPERTY_ID = process.env.CLOUDBEDS_PROPERTY_ID || "161682624172278";
const TOTAL_ROOMS = Number(process.env.HM_TOTAL_ROOMS || 38);
const RATES_PATH = "data/rates.latest.json";

if (!API_KEY) {
  console.warn("Missing CLOUDBEDS_API_KEY. Skipping Cloudbeds occupancy.");
  process.exit(0);
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

function nightsBetween(start, end) {
  if (!start || !end) return null;
  const a = new Date(start + "T12:00:00");
  const b = new Date(end + "T12:00:00");
  const nights = Math.round((b - a) / (1000 * 60 * 60 * 24));
  return nights > 0 ? nights : null;
}

function overlapsNight(reservation, date) {
  const start = reservation?.startDate;
  const end = reservation?.endDate;
  if (!start || !end) return false;
  return start <= date && end > date;
}

function validReservationStatus(status) {
  const s = String(status || "").toLowerCase();
  if (s.includes("cancel")) return false;
  if (s.includes("no_show")) return false;
  if (s.includes("noshow")) return false;
  return true;
}

async function cloudbedsGet(url) {
  const res = await fetch(url, { headers });
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Cloudbeds ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = JSON.parse(text);

  if (!json.success) {
    throw new Error(`Cloudbeds error: ${json.message || text.slice(0, 300)}`);
  }

  return json;
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
    if (pageNumber > 80) break;
  }

  return reservationsById;
}

function calculateOccupancy(assignments, reservationsById, date) {
  const occupiedRooms = new Map();
  const reservationsCounted = new Map();

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

    reservationsCounted.set(reservationID, reservation);
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

  let revenueOTB = 0;

  for (const reservation of reservationsCounted.values()) {
    const balance = Number(reservation.balance);
    const nights = nightsBetween(reservation.startDate, reservation.endDate);

    if (Number.isFinite(balance) && nights) {
      // Prorrateo simple: balance total / noches de estancia.
      // Si una reserva tiene varias habitaciones, el balance suele ser total de la reserva.
      revenueOTB += balance / nights;
    }
  }

  const adr = roomsSold > 0 ? revenueOTB / roomsSold : null;
  const revpar = TOTAL_ROOMS > 0 ? revenueOTB / TOTAL_ROOMS : null;

  return {
    roomsTotal: TOTAL_ROOMS,
    roomsSold,
    roomsSoldRaw,
    roomsAvailable,
    occupancyPct,
    occupancyPctLabel: occupancyPct == null ? null : `${Math.round(occupancyPct * 100)}%`,
    adr: Number.isFinite(adr) ? Math.round(adr) : null,
    revpar: Number.isFinite(revpar) ? Math.round(revpar) : null,
    revenueOTB: Number.isFinite(revenueOTB) ? Math.round(revenueOTB) : null,
    adrSource: "Cloudbeds API balance prorated by stay night",
    byRoomType
  };
}

const rates = JSON.parse(await fs.readFile(RATES_PATH, "utf8"));
const days = rates.days || [];

if (!days.length) {
  console.warn("No days found in rates.latest.json");
  process.exit(0);
}

const firstDate = days[0].date;
const lastDate = days[days.length - 1].date;

console.log(`Fetching Cloudbeds reservations for ${firstDate} to ${lastDate}...`);
const reservationsById = await fetchReservationsForWindow(firstDate, lastDate);
console.log(`Reservations loaded: ${reservationsById.size}`);

rates.sources = {
  ...(rates.sources || {}),
  cloudbedsOccupancy: "Cloudbeds API getReservationAssignments + getReservations overnight filter"
};

rates.cloudbedsOccupancyAddedAt = new Date().toISOString();

for (const day of days) {
  const date = day.date;
  console.log(`Adding Cloudbeds occupancy ${date}...`);

  try {
    const assignments = await fetchAssignments(date);
    day.hmOccupancy = calculateOccupancy(assignments, reservationsById, date);
  } catch (err) {
    day.hmOccupancy = {
      error: err.message,
      roomsTotal: TOTAL_ROOMS,
      roomsSold: null,
      roomsSoldRaw: null,
      roomsAvailable: null,
      occupancyPct: null,
      occupancyPctLabel: null,
      adr: null,
      revpar: null,
      revenueOTB: null,
      byRoomType: {}
    };
  }
}

await fs.writeFile(RATES_PATH, JSON.stringify(rates, null, 2));

console.log(`Done. Updated ${RATES_PATH} with corrected Cloudbeds occupancy + ADR.`);
