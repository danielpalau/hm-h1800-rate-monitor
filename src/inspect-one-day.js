import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import { CONFIG } from './config.js';

const checkIn = process.argv[2] || '2026-05-15';
const checkOut = process.argv[3] || '2026-05-16';

async function closePopups(page) {
  const labels = ['Aceptar cookies', 'Aceptar', 'Accept', 'OK', 'Entendido', 'Cerrar', 'Close'];
  for (const label of labels) {
    try {
      const btn = page.getByRole('button', { name: new RegExp(label, 'i') }).first();
      if (await btn.isVisible({ timeout: 800 })) await btn.click({ timeout: 1500 });
    } catch {}
  }
}

async function tryClickAvailability(page, label) {
  console.log(`[${label}] intentando activar búsqueda/disponibilidad...`);

  const candidates = [
    page.getByRole('button', { name: /buscar|search|disponibilidad|availability|reservar|book/i }).first(),
    page.getByText(/buscar|search|disponibilidad|availability|reservar|book/i).first(),
    page.locator('button').filter({ hasText: /buscar|search|disponibilidad|availability|reservar|book/i }).first(),
    page.locator('a').filter({ hasText: /buscar|search|disponibilidad|availability|reservar|book/i }).first()
  ];

  for (const locator of candidates) {
    try {
      if (await locator.isVisible({ timeout: 1500 })) {
        console.log(`[${label}] click encontrado`);
        await locator.click({ timeout: 5000 });
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(8000);
        return true;
      }
    } catch {}
  }

  console.log(`[${label}] no encontré botón visible de búsqueda`);
  return false;
}

async function inspectHotel(label, url) {
  const browser = await chromium.launch({ headless: false, slowMo: 250 });
  const context = await browser.newContext({
    locale: 'es-MX',
    timezoneId: CONFIG.timezone,
    viewport: { width: 1365, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
  });

  const page = await context.newPage();

  console.log(`\n=== ${label} ===`);
  console.log(url);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(8000);
  await closePopups(page);

  if (label === 'hm') {
    await tryClickAvailability(page, label);
  }

  if (label === 'h1800') {
    try {
      const search = page.getByRole('button', { name: /buscar/i }).first();
      if (await search.isVisible({ timeout: 2000 })) {
        await search.click({ timeout: 5000 });
        await page.waitForTimeout(8000);
      }
    } catch {}
  }

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await page.waitForTimeout(3000);

  const title = await page.title().catch(() => '');
  const currentUrl = page.url();
  const bodyText = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
  const html = await page.content();

  await fs.mkdir('debug/inspect', { recursive: true });
  await fs.writeFile(`debug/inspect/${label}-${checkIn}.txt`, bodyText);
  await fs.writeFile(`debug/inspect/${label}-${checkIn}.html`, html);
  await page.screenshot({ path: `debug/inspect/${label}-${checkIn}.png`, fullPage: true });

  const priceTexts = bodyText.match(/(?:\$|MXN|MEX\$)\s*[0-9][0-9,.]*/gi) || [];

  console.log('Title:', title);
  console.log('Final URL:', currentUrl);
  console.log('Body chars:', bodyText.length);
  console.log('Price-like texts:', priceTexts.slice(0, 40));
  console.log('Tiene Suite:', /suite/i.test(bodyText));
  console.log('Tiene Habitación:', /habitación|habitacion/i.test(bodyText));
  console.log('Tiene MXN:', /MXN/i.test(bodyText));
  console.log(`Saved files in debug/inspect/${label}-${checkIn}.*`);

  await browser.close();
}

const hmUrl = CONFIG.hotels.hm.urlForDate(checkIn, checkOut);
const h1800Url = CONFIG.hotels.h1800.urlForDate(checkIn, checkOut);

await inspectHotel('hm', hmUrl);
await inspectHotel('h1800', h1800Url);
