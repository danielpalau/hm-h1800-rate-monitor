import fs from 'node:fs/promises';

const RATES_PATH = "data/rates.latest.json";

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

function buildMonthlySegments(days) {
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
    const weekendDays = group.days.filter(d => isWeekendNight(d.date));
    const weekdayDays = group.days.filter(d => !isWeekendNight(d.date));

    const weekend = buildSegment(weekendDays);
    const weekday = buildSegment(weekdayDays);
    const total = buildSegment(group.days);

    // ADR real Cloudbeds sigue pendiente hasta conectar rate details.
    // Si más adelante existe d.adr o d.hmAdr, aquí se puede agregar.
    const adrValues = group.days
      .map(d => d.adr || d.hmAdr || d.cloudbedsAdr)
      .filter(v => Number.isFinite(v));

    const avgRate = adrValues.length
      ? Math.round(adrValues.reduce((a,b)=>a+b,0) / adrValues.length)
      : null;

    return {
      month: group.month,
      label: group.label,
      total,
      weekend: {
        label: "Fin de Semana",
        definition: "Noches de viernes y sábado",
        ...weekend
      },
      weekday: {
        label: "Entre Semana",
        definition: "Noches de domingo a jueves",
        ...weekday
      },
      avgCloudbedsRate: avgRate,
      avgCloudbedsRateLabel: avgRate ? `$${avgRate.toLocaleString("es-MX")}` : "Pendiente"
    };
  });
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

  windowData.monthlySegments = buildMonthlySegments(days);
}

// Atajo específico para la vista de 90 días
rates.hmForecast.monthlyCalendar = rates.hmForecast.windows["90"]?.monthlySegments || [];

rates.hmForecast.segmentMethodology =
  "Fin de Semana = noches de viernes y sábado. Entre Semana = noches de domingo a jueves. Ocupación calculada como room nights vendidas / room nights totales por segmento y mes calendario. Tarifa promedio Cloudbeds pendiente hasta conectar rate details real.";

await fs.writeFile(RATES_PATH, JSON.stringify(rates, null, 2));

console.log("Done. Added HM monthly calendar segments for weekend vs weekday.");
