import fs from 'node:fs/promises';

const RATES_PATH = "data/rates.latest.json";

function avg(values) {
  const nums = values.filter(v => Number.isFinite(v));
  return nums.length ? nums.reduce((a,b)=>a+b,0) / nums.length : null;
}

function sum(values) {
  return values.filter(v => Number.isFinite(v)).reduce((a,b)=>a+b,0);
}

function money(v) {
  return Number.isFinite(v) ? Math.round(v) : null;
}

function pct(v) {
  return Number.isFinite(v) ? Math.round(v * 1000) / 10 : null;
}

function dayHmAvgRate(day) {
  if (Number.isFinite(day.hmOccupancy?.adr)) return day.hmOccupancy.adr;

  const vals = (day.rows || []).map(r => r.hmDirect).filter(v => Number.isFinite(v));
  return avg(vals);
}

function expandDaysForDemo(days, targetDays) {
  if (!days.length) return [];
  const expanded = [];

  for (let i = 0; i < targetDays; i++) {
    const base = days[i % days.length];
    const d = new Date(days[0].date + "T12:00:00");
    d.setDate(d.getDate() + i);
    const date = d.toISOString().slice(0, 10);

    expanded.push({
      ...base,
      date,
      demoExtrapolated: i >= days.length
    });
  }

  return expanded;
}

function buildHmForecast(days, windowSize) {
  const selected = expandDaysForDemo(days, windowSize);

  const occupancies = selected.map(d => d.hmOccupancy?.occupancyPct).filter(v => Number.isFinite(v));
  const roomsSold = selected.map(d => d.hmOccupancy?.roomsSold).filter(v => Number.isFinite(v));
  const roomsAvailable = selected.map(d => d.hmOccupancy?.roomsAvailable).filter(v => Number.isFinite(v));
  const hmRates = selected.map(dayHmAvgRate).filter(v => Number.isFinite(v));

  const estimatedRevenueByDay = selected.map(d => {
    const sold = d.hmOccupancy?.roomsSold;
    const rate = dayHmAvgRate(d);
    if (!Number.isFinite(sold) || !Number.isFinite(rate)) return null;
    return sold * rate;
  }).filter(v => Number.isFinite(v));

  const daysDetail = selected.map(d => {
    const occ = d.hmOccupancy || {};
    const hmAvgRate = dayHmAvgRate(d);
    const revenue = Number.isFinite(occ.roomsSold) && Number.isFinite(hmAvgRate)
      ? occ.roomsSold * hmAvgRate
      : null;

    let status = "normal";
    let recommendation = "Mantener monitoreo";

    if (Number.isFinite(occ.occupancyPct)) {
      if (occ.occupancyPct >= 0.85) {
        status = "alta_ocupacion";
        recommendation = "Proteger inventario / revisar alza tarifaria";
      } else if (occ.occupancyPct <= 0.35) {
        status = "baja_ocupacion";
        recommendation = "Impulsar demanda / revisar tarifa y campañas";
      } else if (occ.occupancyPct >= 0.65) {
        status = "buena_ocupacion";
        recommendation = "Monitorear pickup / posible alza moderada";
      }
    }

    return {
      date: d.date,
      demoExtrapolated: !!d.demoExtrapolated,
      occupancyPct: occ.occupancyPct ?? null,
      occupancyPctLabel: occ.occupancyPctLabel ?? null,
      roomsSold: occ.roomsSold ?? null,
      roomsAvailable: occ.roomsAvailable ?? null,
      roomsTotal: occ.roomsTotal ?? null,
      hmAvgPublicRate: money(hmAvgRate),
      estimatedRevenue: money(revenue),
      status,
      recommendation
    };
  });

  return {
    windowDays: windowSize,
    daysIncluded: selected.length,
    demoMode: true,
    note: "Forecast demo extrapolado con los datos disponibles actualmente. No es forecast real de 90 días todavía.",
    firstDate: selected[0]?.date || null,
    lastDate: selected[selected.length - 1]?.date || null,

    avgOccupancyPct: pct(avg(occupancies)),
    avgOccupancyLabel: avg(occupancies) == null ? null : `${Math.round(avg(occupancies) * 100)}%`,

    totalRoomNightsSold: sum(roomsSold),
    totalRoomNightsAvailable: sum(roomsAvailable),

    avgHmPublicRate: money(avg(hmRates)),
    estimatedRoomRevenue: money(sum(estimatedRevenueByDay)),

    highOccupancyDays: selected.filter(d => (d.hmOccupancy?.occupancyPct ?? 0) >= 0.85).length,
    mediumHighOccupancyDays: selected.filter(d => {
      const o = d.hmOccupancy?.occupancyPct;
      return Number.isFinite(o) && o >= 0.65 && o < 0.85;
    }).length,
    lowOccupancyDays: selected.filter(d => {
      const o = d.hmOccupancy?.occupancyPct;
      return Number.isFinite(o) && o <= 0.35;
    }).length,

    topHighOccupancyDates: daysDetail.filter(d => d.status === "alta_ocupacion").slice(0, 10),
    topLowOccupancyDates: daysDetail.filter(d => d.status === "baja_ocupacion").slice(0, 10),

    daysDetail
  };
}

const rates = JSON.parse(await fs.readFile(RATES_PATH, "utf8"));
const days = rates.days || [];

rates.hmForecast = {
  generatedAt: new Date().toISOString(),
  demoMode: true,
  methodology: "Forecast demo solo de Hotel Marielena. Usa ocupación Cloudbeds y ADR estimado desde Cloudbeds API. Para 60/90 días extrapola los datos disponibles para revisar diseño antes de correr 90 días reales.",
  windows: {
    "30": buildHmForecast(days, 30),
    "60": buildHmForecast(days, 60),
    "90": buildHmForecast(days, 90)
  }
};

await fs.writeFile(RATES_PATH, JSON.stringify(rates, null, 2));

console.log("Done. Added HM forecast demo 30/60/90 to data/rates.latest.json");
