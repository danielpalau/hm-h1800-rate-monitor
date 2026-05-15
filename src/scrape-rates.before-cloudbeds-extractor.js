import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import roomMap from '../data/room-map.json' with { type: 'json' };
import { CONFIG } from './config.js';

const OUT_DIR = path.resolve('data');
const DEBUG_DIR = path.resolve('debug');

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function moneyToNumber(text) {
  if (!text) return null;

  let s = String(text)
    .replace(/\s/g, '')
    .replace(/MXN|MEX\$|\$/gi, '')
    .replace(/[^\d.,]/g, '');

  if (!s) return null;

  // Formato español/europeo: 13.035,75
  if (s.includes('.') && s.includes(',') && s.lastIndexOf(',') > s.lastIndexOf('.')) {
    s = s.replace(/\./g, '').replace(',', '.');
  }
  // Formato US/MX: 13,035.75
  else if (s.includes(',') && s.includes('.') && s.lastIndexOf('.') > s.lastIndexOf(',')) {
    s = s.replace(/,/g, '');
  }
  // Formato 13,035 o 2386,97
  else if (s.includes(',') && !s.includes('.')) {
    const parts = s.split(',');
    if (parts[parts.length - 1].length === 3) {
      s = s.replace(/,/g, '');
    } else {
      s = s.replace(',', '.');
    }
  }
  // Formato 13.035 o 2386.97
  else if (s.includes('.') && !s.includes(',')) {
    const parts = s.split('.');
    if (parts[parts.length - 1].length === 3) {
      s = s.replace(/\./g, '');
    }
  }

  const n = Number(s);
  return Number.isFinite(n) && n > 100 ? Math.round(n) : null;
}

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function textMatchesAny(text, aliases = []) {
  const nText = normalize(text);
  return aliases.some((a) => nText.includes(normalize(a)));
}

async function closePopups(page) {
  const labels = ['Aceptar cookies', 'Aceptar', 'Accept', 'OK', 'Entendido', 'Guardar', 'Save', 'Cerrar', 'Close', 'Rechazar todas'];
  for (const label of labels) {
    try {
      const btn = page.getByRole('button', { name: new RegExp(label, 'i') }).first();
      if (await btn.isVisible({ timeout: 700 })) await btn.click({ timeout: 1500 });
    } catch {}
  }
}

async function extractPricesByAliases(page, roomAliasesByTarget) {
  await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
  await closePopups(page);
  await page.waitForTimeout(6000);

  // Scroll para activar lazy loading
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(2000);

  const candidates = await page.evaluate(() => {
    function visible(el) {
      const s = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s && s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.height > 0;
    }
    const nodes = Array.from(document.querySelectorAll('article, section, li, div, tr, [class*=room], [class*=Room], [class*=rate], [class*=Rate]'));
    return nodes
      .filter(visible)
      .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
      .filter((t) => t.length > 20 && /\$|MXN|MEX\$|\b[0-9][0-9,.]{2,}\b/i.test(t))
      .slice(0, 800);
  });

  const results = {};
  for (const [targetRoom, aliases] of Object.entries(roomAliasesByTarget)) {
    const matchingBlocks = candidates.filter((txt) => textMatchesAny(txt, aliases));
    const prices = [];
    for (const block of matchingBlocks) {
      const matches = block.match(/(?:MXN|MEX\$|\$)?\s*[0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,]\d{2})?\s*(?:MXN|MEX\$)?|(?:MXN|MEX\$|\$)\s*[0-9]+/gi) || [];
      for (const m of matches) {
        const value = moneyToNumber(m);
        if (value && value >= 500 && value <= 30000) prices.push(value);
      }
    }
    results[targetRoom] = prices.length ? Math.min(...prices) : null;
  }

  return { results, candidatesCount: candidates.length };
}

async function extractH1800ByVisibleLines(page, roomAliasesByTarget) {
  await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
  await closePopups(page);
  await page.waitForTimeout(6000);

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await page.waitForTimeout(3000);

  const bodyText = await page.locator('body').innerText({ timeout: 15000 }).catch(() => '');
  const lines = bodyText
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

  const priceRegex = /(?:MXN|MEX\$|\$)?\s*[0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,]\d{2})?\s*(?:MXN|MEX\$)?|(?:MXN|MEX\$|\$)\s*[0-9]+/gi;

  const allRoomAliases = Object.values(roomAliasesByTarget).flat().map(normalize);

  function isAnotherRoomTitle(line, currentAliases) {
    const nLine = normalize(line);
    const current = currentAliases.map(normalize);
    if (current.some((a) => nLine.includes(a))) return false;
    return allRoomAliases.some((a) => a.length >= 8 && nLine.includes(a));
  }

  const results = {};

  for (const [targetRoom, aliases] of Object.entries(roomAliasesByTarget)) {
    let foundPrice = null;
    let foundIndex = -1;

    for (let i = 0; i < lines.length; i++) {
      const nLine = normalize(lines[i]);
      const matched = aliases.some((alias) => {
        const nAlias = normalize(alias);
        return nAlias.length >= 6 && (nLine === nAlias || nLine.includes(nAlias));
      });

      if (!matched) continue;

      foundIndex = i;
      const prices = [];

      for (let j = i; j < Math.min(lines.length, i + 80); j++) {
        if (j > i && isAnotherRoomTitle(lines[j], aliases)) break;

        // Solo considerar líneas que claramente son precio, no teléfonos ni metadatos
        if (!/(MXN|MEX\$|\$)/i.test(lines[j])) continue;

        const matches = lines[j].match(priceRegex) || [];
        for (const m of matches) {
          const value = moneyToNumber(m);
          if (value && value >= 1000 && value <= 30000) prices.push(value);
        }
      }

      if (prices.length) {
        foundPrice = Math.min(...prices);
        break;
      }
    }

    results[targetRoom] = foundPrice;
  }

  return { results, candidatesCount: lines.length };
}


async function scrapeHotelMarielena(page, checkIn, checkOut) {
  const url = CONFIG.hotels.hm.urlForDate(checkIn, checkOut);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await closePopups(page);
  // Esperar a que aparezcan habitaciones
  await page.waitForSelector('[class*=room], [class*=Room], [class*=rate], article', { timeout: 20000 }).catch(() => {});
  const aliases = CONFIG.hotels.hm.roomAliases;
  const extracted = await extractPricesByAliases(page, aliases);
  return { url, ...extracted };
}

async function scrapeHacienda1800(page, checkIn, checkOut) {
  const url = CONFIG.hotels.h1800.urlForDate(checkIn, checkOut);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await closePopups(page);
  await page.waitForTimeout(4000);

  // Intentar hacer clic en "VER HABITACIONES" del Hotel Hacienda 1800 específicamente
  try {
    // Buscar el enlace/botón de ver habitaciones cerca del texto "Hacienda 1800"
    const allVerHabitaciones = page.getByRole('link', { name: /ver habitaciones/i });
    const count = await allVerHabitaciones.count();
    // El hotel Hacienda 1800 suele aparecer de último en el listado (índice 2 o el último)
    if (count > 0) {
      await allVerHabitaciones.nth(count - 1).click({ timeout: 5000 });
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(4000);
    }
  } catch {}

  // Si apareció botón de buscar, hacer clic
  try {
    const search = page.getByRole('button', { name: /buscar|search/i }).first();
    if (await search.isVisible({ timeout: 2000 })) await search.click({ timeout: 3000 });
    await page.waitForTimeout(3000);
  } catch {}

  const aliasMap = {};
  for (const r of roomMap) aliasMap[r.h1800] = Array.from(new Set([r.h1800, ...(r.h1800_aliases || [])]));
  const extracted = await extractH1800ByVisibleLines(page, aliasMap);
  return { url, ...extracted };
}

function buildRows(date, hmData, h1800Data) {
  return roomMap.map((m) => {
    const hmDirect = hmData.results[m.hm] ?? null;
    const h1800Direct = h1800Data.results[m.h1800] ?? null;
    const diff = hmDirect != null && h1800Direct != null ? hmDirect - h1800Direct : null;
    const pct = diff != null && h1800Direct ? diff / h1800Direct : null;
    return {
      date,
      hm: m.hm,
      inventory: m.inventory,
      h1800: m.h1800,
      hmDirect,
      h1800Direct,
      diff,
      pct,
      status:
        hmDirect == null || h1800Direct == null ? 'missing_data' :
        Math.abs(pct) >= CONFIG.discrepancyPctAlert / 100 ? 'high_discrepancy' : 'ok'
    };
  });
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.mkdir(DEBUG_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'es-MX',
    timezoneId: CONFIG.timezone,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
  });

  const startDate = process.env.START_DATE ? new Date(process.env.START_DATE + 'T12:00:00') : new Date();
  const today = startDate;
  const allDays = [];
  const errors = [];

  const daysToScan = Number(process.env.DAYS_TO_SCAN || CONFIG.daysToScan);
  for (let i = 0; i < daysToScan; i++) {
    const checkIn = isoDate(addDays(today, i));
    const checkOut = isoDate(addDays(today, i + CONFIG.nights));
    const page = await context.newPage();
    console.log(`Scraping ${checkIn}...`);

    try {
      const hm = await scrapeHotelMarielena(page, checkIn, checkOut);
      await page.screenshot({ path: path.join(DEBUG_DIR, `hm-${checkIn}.png`), fullPage: true }).catch(() => {});

      const h1800 = await scrapeHacienda1800(page, checkIn, checkOut);
      await page.screenshot({ path: path.join(DEBUG_DIR, `h1800-${checkIn}.png`), fullPage: true }).catch(() => {});

      allDays.push({
        date: checkIn,
        checkOut,
        urls: { hm: hm.url, h1800: h1800.url },
        extraction: { hmCandidates: hm.candidatesCount, h1800Candidates: h1800.candidatesCount },
        rows: buildRows(checkIn, hm, h1800)
      });
    } catch (err) {
      errors.push({ date: checkIn, message: err.message });
      allDays.push({ date: checkIn, checkOut, rows: roomMap.map((m) => ({ date: checkIn, hm: m.hm, h1800: m.h1800, inventory: m.inventory, hmDirect: null, h1800Direct: null, diff: null, pct: null, status: 'error' })) });
    } finally {
      await page.close().catch(() => {});
    }
  }

  await browser.close();

  const output = {
    generatedAt: new Date().toISOString(),
    source: 'live_scraper',
    hotels: { hm: CONFIG.hotels.hm.name, h1800: CONFIG.hotels.h1800.name },
    roomMap,
    days: allDays,
    errors
  };

  const stamp = isoDate(new Date());
  await fs.writeFile(path.join(OUT_DIR, `rates.${stamp}.json`), JSON.stringify(output, null, 2));
  await fs.writeFile(path.join(OUT_DIR, 'rates.latest.json'), JSON.stringify(output, null, 2));
  console.log(`Done. Wrote data/rates.latest.json with ${errors.length} errors.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
