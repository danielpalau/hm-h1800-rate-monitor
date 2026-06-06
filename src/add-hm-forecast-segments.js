import fs from 'node:fs/promises';

const RATES_PATH = "data/rates.latest.json";

function isWeekendNight(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  const day = d.getDay(); 
  // 0 domingo, 1 lunes, ..., 5 viernes, 6 sábado
  return day === 5 || day === 6;
}

function pct(v) {
  return Number.isFinite(v) ? Math.round(v * 1000) / 10 : null;
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
    occupancyPctLabel: occupancyPct == null ? null : `${Math.round(occupancyPct * 100)}%`,
    highOccupancyDays: days.filter(d => (d.occupancyPct ?? 0) >= 0.85).length,
    lowOccupancyDays: days.filter(d => Number.isFinite(d.occupancyPct) && d.occupancyPct <= 0.35).length
  };
}

const rates = JSON.parse(await fs.readFile(RATES_PATH, "utf8"));

if (!rates.hmForecast?.windows) {
  console.warn("No hmForecast.windows found. Run add-hm-forecast-real.js first.");
  process.exit(0);
}

for (const [windowKey, windowData] of Object.entries(rates.hmForecast.windows)) {
  const days = windowData.daysDetail || [];

  const weekend = days.filter(d => isWeekendNight(d.date));
  const weekday = days.filter(d => !isWeekendNight(d.date));

  windowData.segments = {
    weekend: {
      label: "Fin de Semana",
      definition: "Noches de viernes y sábado",
      ...buildSegment(weekend)
    },
    weekday: {
      label: "Entre Semana",
      definition: "Noches de domingo a jueves",
      ...buildSegment(weekday)
    }
  };
}

rates.hmForecast.segmentMethodology = "Fin de Semana = noches de viernes y sábado. Entre Semana = noches de domingo a jueves. Ocupación calculada como room nights vendidas / room nights totales.";

await fs.writeFile(RATES_PATH, JSON.stringify(rates, null, 2));

console.log("Done. Added HM forecast segments for weekend vs weekday.");
