import fs from "node:fs/promises";

const RATES_PATH = "data/rates.latest.json";

const OCCUPANCY_RULES = [
  { min: 0.00, max: 0.30, adjustment: -0.15, label: "Ocupación 0-30%" },
  { min: 0.31, max: 0.50, adjustment: 0.05, label: "Ocupación 31-50%" },
  { min: 0.51, max: 0.70, adjustment: 0.00, label: "Ocupación 51-70%" },
  { min: 0.71, max: 0.85, adjustment: 0.10, label: "Ocupación 71-85%" },
  { min: 0.86, max: 1.00, adjustment: 0.20, label: "Ocupación 86-100%" }
];

function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/[$,%\s,]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function normalizePct(value) {
  const n = asNumber(value);
  if (!Number.isFinite(n)) return null;
  return n > 1 ? n / 100 : n;
}

function moneyLabel(value) {
  const n = asNumber(value);
  if (!Number.isFinite(n)) return "Pendiente";
  return `$${Math.round(n).toLocaleString("es-MX")}`;
}

function pctLabel(value) {
  const n = normalizePct(value);
  if (!Number.isFinite(n)) return "Pendiente";
  return `${Math.round(n * 100)}%`;
}

function getOccupancyAdjustment(occupancyPct) {
  const occ = normalizePct(occupancyPct);
  if (!Number.isFinite(occ)) {
    return { adjustment: 0, label: "Sin ocupación disponible" };
  }

  const rule = OCCUPANCY_RULES.find(r => occ >= r.min && occ <= r.max);
  return rule || OCCUPANCY_RULES[OCCUPANCY_RULES.length - 1];
}

function getPickupAdjustment(pickupPct) {
  const pickup = normalizePct(pickupPct);
  return Number.isFinite(pickup) && pickup >= 0.20 ? 0.10 : 0;
}

function getCategory({ occupancyPct, pickupPct, currentRate, suggestedRate }) {
  const occ = normalizePct(occupancyPct) ?? 0;
  const pickup = normalizePct(pickupPct) ?? 0;
  const current = asNumber(currentRate);
  const suggested = asNumber(suggestedRate);

  const rateGap = Number.isFinite(current) && Number.isFinite(suggested) && suggested > 0
    ? (suggested - current) / suggested
    : 0;

  if (occ >= 0.86 || (pickup >= 0.20 && occ >= 0.71) || rateGap >= 0.10) {
    return "urgente";
  }

  if (occ >= 0.71 || pickup >= 0.20 || rateGap >= 0.05) {
    return "medio";
  }

  return "oportunidad";
}

function categoryLabel(category) {
  if (category === "urgente") return "Urgente";
  if (category === "medio") return "Medio";
  return "Oportunidad";
}

function findFirst(obj, keys) {
  if (!obj || typeof obj !== "object") return null;

  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") return obj[key];
  }

  return null;
}

function deriveDate(row) {
  return findFirst(row, [
    "date",
    "fecha",
    "stayDate",
    "night",
    "day",
    "checkInDate",
    "arrivalDate"
  ]);
}

function deriveOccupancy(row) {
  return findFirst(row, [
    "occupancyPct",
    "occupancy",
    "occ",
    "hmOccupancyPct",
    "cloudbedsOccupancyPct",
    "occupiedPct",
    "ocupacion",
    "ocupacionPct"
  ]);
}

function derivePickup(row) {
  return findFirst(row, [
    "pickupPct",
    "pickup7dPct",
    "pickupWeekPct",
    "weeklyPickupPct",
    "reservationsPickupPct",
    "pickup",
    "pickUpPct"
  ]);
}

function deriveBaseRate(row) {
  return findFirst(row, [
    "baseRate",
    "tarifaBase",
    "hmBaseRate",
    "avgCloudbedsRate",
    "cloudbedsRate",
    "rate",
    "hmRate",
    "directRate",
    "direct",
    "publicRate",
    "hmPublicRate",
    "avgRate"
  ]);
}

function deriveCurrentRate(row) {
  return findFirst(row, [
    "currentRate",
    "tarifaActual",
    "hmRate",
    "directRate",
    "direct",
    "publicRate",
    "hmPublicRate",
    "rate",
    "avgRate"
  ]);
}

function collectRowsFromKnownPaths(data) {
  const candidates = [];

  const paths = [
    data?.hmForecastReal?.days,
    data?.hmForecastReal?.dates,
    data?.hmForecastReal?.rows,
    data?.hmForecast?.days,
    data?.hmForecast?.dates,
    data?.hmForecast?.rows,
    data?.hmForecastSegments?.days,
    data?.hmForecastSegments?.dates,
    data?.hmForecastSegments?.rows,
    data?.hmOccupancyForecast?.days,
    data?.hmOccupancyForecast?.dates,
    data?.hmOccupancyForecast?.rows,
    data?.rates,
    data?.days,
    data?.dates
  ];

  for (const path of paths) {
    if (Array.isArray(path)) candidates.push(...path);
  }

  return candidates;
}

function collectRowsRecursively(value, output = [], seen = new Set()) {
  if (!value || typeof value !== "object") return output;
  if (seen.has(value)) return output;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === "object") {
        const date = deriveDate(item);
        const occ = deriveOccupancy(item);
        const rate = deriveBaseRate(item);
        if (date && (occ !== null || rate !== null)) output.push(item);
        collectRowsRecursively(item, output, seen);
      }
    }
    return output;
  }

  for (const child of Object.values(value)) {
    collectRowsRecursively(child, output, seen);
  }

  return output;
}

function dedupeRows(rows) {
  const map = new Map();

  for (const row of rows) {
    const date = deriveDate(row);
    if (!date) continue;

    const key = String(date).slice(0, 10);
    const existing = map.get(key);

    if (!existing) {
      map.set(key, row);
      continue;
    }

    const existingScore = scoreRow(existing);
    const newScore = scoreRow(row);

    if (newScore > existingScore) map.set(key, row);
  }

  return [...map.entries()]
    .map(([date, row]) => ({ date, row }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function scoreRow(row) {
  let score = 0;
  if (deriveOccupancy(row) !== null) score += 3;
  if (deriveBaseRate(row) !== null) score += 2;
  if (deriveCurrentRate(row) !== null) score += 2;
  if (derivePickup(row) !== null) score += 2;
  return score;
}

function buildAlert(date, row) {
  const occupancyPct = normalizePct(deriveOccupancy(row));
  const pickupPct = normalizePct(derivePickup(row)) ?? 0;
  const baseRate = asNumber(deriveBaseRate(row));
  const currentRate = asNumber(deriveCurrentRate(row)) ?? baseRate;

  if (!Number.isFinite(baseRate) || baseRate <= 0) return null;
  if (!Number.isFinite(occupancyPct)) return null;

  const occRule = getOccupancyAdjustment(occupancyPct);
  const pickupAdjustment = getPickupAdjustment(pickupPct);
  const totalAdjustment = occRule.adjustment + pickupAdjustment;
  const suggestedRate = Math.round(baseRate * (1 + totalAdjustment));
  const category = getCategory({ occupancyPct, pickupPct, currentRate, suggestedRate });

  const pickupText = pickupAdjustment > 0
    ? `Pick up semanal ${pctLabel(pickupPct)}: subir 10% extra.`
    : `Pick up semanal ${pctLabel(pickupPct)}: sin ajuste extra.`;

  let action = "";

  if (totalAdjustment > 0) {
    action = `Subir tarifa a ${moneyLabel(suggestedRate)}. Ajuste sugerido: +${Math.round(totalAdjustment * 100)}%.`;
  } else if (totalAdjustment < 0) {
    action = `Bajar tarifa a ${moneyLabel(suggestedRate)}. Ajuste sugerido: ${Math.round(totalAdjustment * 100)}%.`;
  } else {
    action = `Mantener tarifa base en ${moneyLabel(suggestedRate)}.`;
  }

  return {
    date,
    category,
    categoryLabel: categoryLabel(category),
    occupancyPct,
    occupancyPctLabel: pctLabel(occupancyPct),
    pickupPct,
    pickupPctLabel: pctLabel(pickupPct),
    baseRate,
    baseRateLabel: moneyLabel(baseRate),
    currentRate,
    currentRateLabel: moneyLabel(currentRate),
    suggestedRate,
    suggestedRateLabel: moneyLabel(suggestedRate),
    occupancyAdjustment: occRule.adjustment,
    pickupAdjustment,
    totalAdjustment,
    totalAdjustmentLabel: `${totalAdjustment >= 0 ? "+" : ""}${Math.round(totalAdjustment * 100)}%`,
    reason: `${occRule.label}: ${occRule.adjustment >= 0 ? "+" : ""}${Math.round(occRule.adjustment * 100)}%. ${pickupText}`,
    action
  };
}

function summarize(alerts) {
  return {
    total: alerts.length,
    urgente: alerts.filter(a => a.category === "urgente").length,
    medio: alerts.filter(a => a.category === "medio").length,
    oportunidad: alerts.filter(a => a.category === "oportunidad").length,
    urgentDates: alerts.filter(a => a.category === "urgente").map(a => a.date)
  };
}

let data;

try {
  data = JSON.parse(await fs.readFile(RATES_PATH, "utf8"));
} catch (err) {
  console.error(`No pude leer ${RATES_PATH}: ${err.message}`);
  process.exit(1);
}

const knownRows = collectRowsFromKnownPaths(data);
const recursiveRows = collectRowsRecursively(data);
const rows = dedupeRows([...knownRows, ...recursiveRows]);

const alerts = rows
  .map(({ date, row }) => buildAlert(date, row))
  .filter(Boolean)
  .sort((a, b) => {
    const priority = { urgente: 0, medio: 1, oportunidad: 2 };
    return priority[a.category] - priority[b.category] || a.date.localeCompare(b.date);
  });

data.revenueAlerts = {
  generatedAt: new Date().toISOString(),
  rules: {
    occupancy: OCCUPANCY_RULES,
    pickup: {
      threshold: 0.20,
      extraAdjustment: 0.10,
      label: "Aumento de reservas semanal de 20% o más: subir tarifa 10% extra"
    }
  },
  summary: summarize(alerts),
  alerts
};

await fs.writeFile(RATES_PATH, JSON.stringify(data, null, 2));

console.log("Revenue alerts generated.");
console.log(JSON.stringify(data.revenueAlerts.summary, null, 2));
