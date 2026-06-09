import fs from 'node:fs/promises';

const RATES_PATH = "data/rates.latest.json";
const OVERRIDES_PATH = "data/manual/hm-monthly-overrides.json";

function pctLabel(pct) {
  if (!Number.isFinite(pct)) return "Pendiente";
  return `${Math.round(pct * 100)}%`;
}

function moneyLabel(value) {
  if (!Number.isFinite(value)) return "Pendiente";
  return `$${Number(value).toLocaleString("es-MX", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function buildManualSegment(label, definition, segment) {
  const sold = Number(segment?.soldRoomNights);
  const total = Number(segment?.totalRoomNights);
  const available = Number.isFinite(total) && Number.isFinite(sold)
    ? Math.max(total - sold, 0)
    : null;

  const occupancyPct = Number.isFinite(total) && total > 0 && Number.isFinite(sold)
    ? sold / total
    : null;

  return {
    label,
    definition,
    days: null,
    totalRoomNights: Number.isFinite(total) ? total : null,
    soldRoomNights: Number.isFinite(sold) ? sold : null,
    availableRoomNights: available,
    occupancyPct,
    occupancyPctLabel: pctLabel(occupancyPct),
    source: "manual"
  };
}

function applyManualTotal(monthRow) {
  const weekend = monthRow.weekend || {};
  const weekday = monthRow.weekday || {};

  const sold = Number(weekend.soldRoomNights || 0) + Number(weekday.soldRoomNights || 0);
  const total = Number(weekend.totalRoomNights || 0) + Number(weekday.totalRoomNights || 0);
  const available = Math.max(total - sold, 0);
  const occupancyPct = total > 0 ? sold / total : null;

  monthRow.total = {
    label: "Total mes",
    definition: "Todas las noches del mes",
    days: null,
    totalRoomNights: total,
    soldRoomNights: sold,
    availableRoomNights: available,
    occupancyPct,
    occupancyPctLabel: pctLabel(occupancyPct),
    source: "manual"
  };
}

function calculateYtd(months) {
  let totalSoldRoomNights = 0;
  let totalRoomNights = 0;
  let revenueForRate = 0;
  let roomNightsForRate = 0;

  for (const m of months || []) {
    const total = m.total || {};

    const sold = Number(total.soldRoomNights);
    const availableTotal = Number(total.totalRoomNights);

    if (Number.isFinite(sold)) totalSoldRoomNights += sold;
    if (Number.isFinite(availableTotal)) totalRoomNights += availableTotal;

    if (m.manualOverride && Number.isFinite(Number(m.avgCloudbedsRate)) && Number.isFinite(sold) && sold > 0) {
      revenueForRate += Number(m.avgCloudbedsRate) * sold;
      roomNightsForRate += sold;
      continue;
    }

    if (Number.isFinite(Number(m.cloudbedsRevenue)) && Number.isFinite(Number(m.cloudbedsRoomNightsWithRate)) && Number(m.cloudbedsRoomNightsWithRate) > 0) {
      revenueForRate += Number(m.cloudbedsRevenue);
      roomNightsForRate += Number(m.cloudbedsRoomNightsWithRate);
      continue;
    }

    if (Number.isFinite(Number(m.avgCloudbedsRate)) && Number.isFinite(sold) && sold > 0) {
      revenueForRate += Number(m.avgCloudbedsRate) * sold;
      roomNightsForRate += sold;
    }
  }

  const occupancyPct = totalRoomNights > 0 ? totalSoldRoomNights / totalRoomNights : null;
  const avgRate = roomNightsForRate > 0 ? revenueForRate / roomNightsForRate : null;

  return {
    title: "Acumulado 2026",
    source: "Enero-febrero manual; marzo en adelante Cloudbeds",
    totalSoldRoomNights,
    totalRoomNights,
    occupancyPct,
    occupancyPctLabel: pctLabel(occupancyPct),
    avgRate,
    avgRateLabel: moneyLabel(avgRate),
    revenueForRate: Math.round(revenueForRate),
    roomNightsForRate
  };
}

let rates = JSON.parse(await fs.readFile(RATES_PATH, "utf8"));
let overrides = JSON.parse(await fs.readFile(OVERRIDES_PATH, "utf8"));

if (!rates.hmCalendarMonthly?.months) {
  console.warn("No existe hmCalendarMonthly.months. Corre primero add-hm-calendar-monthly.js.");
  process.exit(0);
}

for (const monthRow of rates.hmCalendarMonthly.months) {
  const override = overrides[monthRow.month];
  if (!override) continue;

  console.log(`Applying manual override for ${monthRow.month}`);

  monthRow.label = override.label || monthRow.label;
  monthRow.source = override.source || "Manual histórico pre-Cloudbeds";
  monthRow.manualOverride = true;

  monthRow.weekend = buildManualSegment(
    "Fin de Semana",
    "Noches de viernes y sábado",
    override.weekend
  );

  monthRow.weekday = buildManualSegment(
    "Entre Semana",
    "Noches de domingo a jueves",
    override.weekday
  );

  applyManualTotal(monthRow);

  const avgRate = Number(override.avgRate);

  monthRow.avgCloudbedsRate = Number.isFinite(avgRate) ? avgRate : null;
  monthRow.avgCloudbedsRateLabel = moneyLabel(avgRate);

  const sold = Number(monthRow.total?.soldRoomNights);
  monthRow.cloudbedsRevenue = Number.isFinite(avgRate) && Number.isFinite(sold)
    ? Math.round(avgRate * sold)
    : null;

  monthRow.cloudbedsRoomNightsWithRate = Number.isFinite(sold) ? sold : null;
}

rates.hmCalendarMonthly.manualOverrides = {
  appliedAt: new Date().toISOString(),
  sourceFile: OVERRIDES_PATH,
  months: Object.keys(overrides),
  note: "Enero y febrero 2026 reemplazan datos Cloudbeds por histórico manual pre-Cloudbeds."
};

rates.hmCalendarMonthly.ytd2026 = calculateYtd(rates.hmCalendarMonthly.months);

await fs.writeFile(RATES_PATH, JSON.stringify(rates, null, 2));

console.log("Done. Manual overrides and YTD KPIs applied.");
console.log(JSON.stringify(rates.hmCalendarMonthly.ytd2026, null, 2));
