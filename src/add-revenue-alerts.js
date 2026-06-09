import fs from "node:fs/promises";

const RATES_PATH = "data/rates.latest.json";

function n(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(num) ? num : null;
}

function money(value) {
  const num = n(value);
  if (!Number.isFinite(num)) return "Pendiente";
  return `$${Math.round(num).toLocaleString("es-MX")}`;
}

function pct(value) {
  const num = n(value);
  if (!Number.isFinite(num)) return "Pendiente";
  const normalized = Math.abs(num) > 1 ? num / 100 : num;
  return `${Math.round(normalized * 100)}%`;
}

function avg(values) {
  const clean = values.map(n).filter(Number.isFinite);
  if (!clean.length) return null;
  return clean.reduce((a, b) => a + b, 0) / clean.length;
}

function categoryLabel(category) {
  if (category === "urgente") return "Urgente";
  if (category === "medio") return "Medio";
  return "Oportunidad";
}

function buildMarketAlert(day, row) {
  const hmRate = n(row.hmDirect);
  const marketRate = avg([row.h1800Direct, row.plazaDirect]);

  if (!Number.isFinite(hmRate) || !Number.isFinite(marketRate) || marketRate <= 0) return null;

  const gap = (hmRate - marketRate) / marketRate;
  const absGap = Math.abs(gap);

  let category = null;
  let action = null;
  let reason = null;
  let suggestedRate = null;

  if (gap <= -0.10) {
    category = "urgente";
    suggestedRate = Math.round(marketRate);
    reason = `HM esta ${pct(gap)} debajo del mercado comparable.`;
    action = `Subir tarifa sugerida a ${money(suggestedRate)} o revisar estrategia comercial hoy.`;
  } else if (gap <= -0.05) {
    category = "medio";
    suggestedRate = Math.round(marketRate);
    reason = `HM esta ${pct(gap)} debajo del mercado comparable.`;
    action = `Revisar subida de tarifa hacia ${money(suggestedRate)}.`;
  } else if (gap >= 0.10) {
    category = "oportunidad";
    suggestedRate = Math.round(marketRate);
    reason = `HM esta ${pct(gap)} arriba del mercado comparable.`;
    action = `Revisar si la tarifa debe sostenerse por demanda o ajustarse hacia ${money(suggestedRate)} para mejorar conversion.`;
  } else {
    return null;
  }

  return {
    date: day.date,
    roomType: row.hm,
    category,
    categoryLabel: categoryLabel(category),
    occupancyPct: null,
    occupancyPctLabel: "Sin dato Cloudbeds",
    pickupPct: null,
    pickupPctLabel: "Sin dato Cloudbeds",
    baseRate: marketRate,
    baseRateLabel: money(marketRate),
    currentRate: hmRate,
    currentRateLabel: money(hmRate),
    suggestedRate,
    suggestedRateLabel: money(suggestedRate),
    totalAdjustment: gap,
    totalAdjustmentLabel: pct(gap),
    reason,
    action,
    source: "comparativo mercado",
    marketRate,
    marketRateLabel: money(marketRate),
    h1800Rate: n(row.h1800Direct),
    plazaRate: n(row.plazaDirect)
  };
}

function summarize(alerts) {
  return {
    total: alerts.length,
    urgente: alerts.filter(a => a.category === "urgente").length,
    medio: alerts.filter(a => a.category === "medio").length,
    oportunidad: alerts.filter(a => a.category === "oportunidad").length,
    urgentDates: [...new Set(alerts.filter(a => a.category === "urgente").map(a => a.date))]
  };
}

const data = JSON.parse(await fs.readFile(RATES_PATH, "utf8"));

const alerts = [];

for (const day of data.days || []) {
  for (const row of day.rows || []) {
    const alert = buildMarketAlert(day, row);
    if (alert) alerts.push(alert);
  }
}

alerts.sort((a, b) => {
  const priority = { urgente: 0, medio: 1, oportunidad: 2 };
  return priority[a.category] - priority[b.category] || a.date.localeCompare(b.date);
});

data.revenueAlerts = {
  generatedAt: new Date().toISOString(),
  mode: "comparativo mercado",
  note: "No se encontraron campos de ocupacion ni pick up en rates.latest.json. Estas alertas usan comparativo HM vs H1800/Plaza como respaldo hasta que Cloudbeds agregue ocupacion/pick up por fecha.",
  summary: summarize(alerts),
  alerts
};

await fs.writeFile(RATES_PATH, JSON.stringify(data, null, 2));

console.log("Revenue alerts generated.");
console.log(JSON.stringify(data.revenueAlerts.summary, null, 2));
