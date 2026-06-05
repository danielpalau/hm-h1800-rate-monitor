import fs from 'node:fs/promises';

const API_KEY = process.env.CLOUDBEDS_API_KEY;
const PROPERTY_ID = process.env.CLOUDBEDS_PROPERTY_ID || "161682624172278";
const TOTAL_ROOMS = Number(process.env.HM_TOTAL_ROOMS || 38);
const RATES_PATH = "data/rates.latest.json";

if (!API_KEY) {
  console.warn("Missing CLOUDBEDS_API_KEY. Skipping Cloudbeds occupancy.");
  process.exit(0);
}

async function fetchAssignments(date) {
  const url = `https://api.cloudbeds.com/api/v1.3/getReservationAssignments?propertyID=${PROPERTY_ID}&date=${date}`;

  const res = await fetch(url, {
    headers: {
      "accept": "application/json",
      "Authorization": `Bearer ${API_KEY}`
    }
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Cloudbeds ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = JSON.parse(text);

  if (!json.success) {
    throw new Error(`Cloudbeds error: ${json.message || text.slice(0, 300)}`);
  }

  return json.data || [];
}

function calculateOccupancy(assignments) {
  const assignedRooms = [];

  for (const reservation of assignments) {
    for (const room of reservation.assigned || []) {
      if (room.roomID) {
        assignedRooms.push({
          reservationID: reservation.reservationID,
          guestName: reservation.guestName,
          roomTypeName: room.roomTypeName,
          roomTypeNameShort: room.roomTypeNameShort,
          roomName: room.roomName,
          roomID: room.roomID
        });
      }
    }
  }

  // Por seguridad, deduplicar por roomID + reservationID.
  const unique = new Map();
  for (const r of assignedRooms) {
    unique.set(`${r.reservationID}-${r.roomID}`, r);
  }

  const roomsSold = unique.size;
  const roomsAvailable = Math.max(TOTAL_ROOMS - roomsSold, 0);
  const occupancyPct = TOTAL_ROOMS ? roomsSold / TOTAL_ROOMS : null;

  const byRoomType = {};
  for (const r of unique.values()) {
    const key = r.roomTypeName || "Unknown";
    byRoomType[key] = (byRoomType[key] || 0) + 1;
  }

  return {
    roomsTotal: TOTAL_ROOMS,
    roomsSold,
    roomsAvailable,
    occupancyPct,
    occupancyPctLabel: occupancyPct == null ? null : `${Math.round(occupancyPct * 100)}%`,
    byRoomType
  };
}

const rates = JSON.parse(await fs.readFile(RATES_PATH, "utf8"));

rates.sources = {
  ...(rates.sources || {}),
  cloudbedsOccupancy: "Cloudbeds API getReservationAssignments"
};

rates.cloudbedsOccupancyAddedAt = new Date().toISOString();

for (const day of rates.days || []) {
  const date = day.date;
  console.log(`Adding Cloudbeds occupancy ${date}...`);

  try {
    const assignments = await fetchAssignments(date);
    day.hmOccupancy = calculateOccupancy(assignments);
  } catch (err) {
    day.hmOccupancy = {
      error: err.message,
      roomsTotal: TOTAL_ROOMS,
      roomsSold: null,
      roomsAvailable: null,
      occupancyPct: null,
      occupancyPctLabel: null,
      byRoomType: {}
    };
  }
}

await fs.writeFile(RATES_PATH, JSON.stringify(rates, null, 2));

console.log(`Done. Updated ${RATES_PATH} with Cloudbeds occupancy.`);
