import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import { CONFIG } from './config.js';

const daysToScan = Number(process.env.DAYS_TO_SCAN || 30);
const startDate = process.env.START_DATE ? new Date(process.env.START_DATE + 'T12:00:00') : new Date();

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

async function auditOneDay(context, checkIn, checkOut) {
  const page = await context.newPage();

  const result = {
    date: checkIn,
    checkOut,
    url: CONFIG.hotels.hm.urlForDate(checkIn, checkOut),
    quoteSets: null,
    roomTypes: null,
    responses: [],
    errors: []
  };

  page.on('response', async (res) => {
    const url = res.url();

    try {
      if (url.includes('operationName=quoteSets')) {
        const json = await res.json();
        result.quoteSets = json?.data?.quoteSets ?? null;
        result.responses.push({
          type: 'quoteSets',
          status: res.status(),
          url,
          count: Array.isArray(result.quoteSets) ? result.quoteSets.length : null
        });
      }

      if (url.includes('operationName=roomTypes')) {
        const json = await res.json();
        const roomTypes = json?.data?.roomTypes ?? [];
        result.roomTypes = roomTypes.map((room) => ({
          uuid: room.uuid,
          name: room.name,
          category: room.category,
          minAvailability: room.minAvailability,
          maxOccupancy: room.maxOccupancy,
          ratesCount: Array.isArray(room.rates) ? room.rates.length : null,
          rateNames: Array.isArray(room.rates) ? room.rates.map((r) => r.name || r.ratePlanName || r.title || null) : [],
          rawRatesPreview: Array.isArray(room.rates) ? room.rates.slice(0, 2) : []
        }));
        result.responses.push({
          type: 'roomTypes',
          status: res.status(),
          url,
          count: result.roomTypes.length
        });
      }

      if (url.includes('/availability?')) {
        const text = await res.text().catch(() => '');
        result.responses.push({
          type: 'availability',
          status: res.status(),
          url,
          bodyLength: text.length,
          bodyPreview: text.slice(0, 500)
        });
      }
    } catch (err) {
      result.errors.push({ url, message: err.message });
    }
  });

  try {
    await page.goto(result.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(12000);
    await page.screenshot({ path: `debug/hm-audit-${checkIn}.png`, fullPage: true }).catch(() => {});
  } catch (err) {
    result.errors.push({ step: 'page.goto', message: err.message });
  } finally {
    await page.close().catch(() => {});
  }

  return result;
}

await fs.mkdir('debug', { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: 'es-MX',
  timezoneId: CONFIG.timezone,
  viewport: { width: 1365, height: 900 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
});

const results = [];

for (let i = 0; i < daysToScan; i++) {
  const checkIn = isoDate(addDays(startDate, i));
  const checkOut = isoDate(addDays(startDate, i + 1));
  console.log(`Auditing HM ${checkIn}...`);
  results.push(await auditOneDay(context, checkIn, checkOut));
}

await browser.close();

await fs.writeFile('debug/hm-directbook-audit.json', JSON.stringify(results, null, 2));

const summary = results.map((d) => ({
  date: d.date,
  quoteSets: Array.isArray(d.quoteSets) ? d.quoteSets.length : null,
  roomTypes: Array.isArray(d.roomTypes) ? d.roomTypes.length : null,
  roomsWithAvailability: d.roomTypes?.filter((r) => Number(r.minAvailability) > 0).length ?? null,
  roomsWithRates: d.roomTypes?.filter((r) => Number(r.ratesCount) > 0).length ?? null,
  rooms: d.roomTypes?.map((r) => ({
    name: r.name,
    minAvailability: r.minAvailability,
    ratesCount: r.ratesCount
  })) ?? []
}));

await fs.writeFile('debug/hm-directbook-audit-summary.json', JSON.stringify(summary, null, 2));

console.log(JSON.stringify(summary, null, 2));
console.log('Saved debug/hm-directbook-audit.json');
console.log('Saved debug/hm-directbook-audit-summary.json');
