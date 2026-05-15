import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const checkIn = process.argv[2] || '2026-06-01';
const checkOut = process.argv[3] || '2026-06-02';

await fs.mkdir('debug/plaza', { recursive: true });

const browser = await chromium.launch({ headless: false, slowMo: 250 });
const context = await browser.newContext({
  locale: 'es-MX',
  timezoneId: 'America/Mexico_City',
  viewport: { width: 1365, height: 900 },
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/147 Safari/537.36'
});

const page = await context.newPage();

const logs = [];

page.on('request', req => {
  const url = req.url();
  if (/zavia|booking|availability|rate|room|reservation|hotel/i.test(url)) {
    logs.push({
      type: 'request',
      method: req.method(),
      url,
      postData: req.postData() || null
    });
  }
});

page.on('response', async res => {
  const url = res.url();
  if (/zavia|booking|availability|rate|room|reservation|hotel/i.test(url)) {
    let body = '';
    try {
      const ct = res.headers()['content-type'] || '';
      if (/json|text|javascript|html/i.test(ct)) {
        body = await res.text();
      }
    } catch {}

    logs.push({
      type: 'response',
      status: res.status(),
      url,
      bodyPreview: body.slice(0, 4000)
    });
  }
});

// Intento 1: URL base con parámetros probables
const url = `https://rbe.zaviaerp.com/hotel/4cienegas?lang=es&currency=MXN&checkin=${checkIn}&checkout=${checkOut}&adults=2&children=0&rooms=1`;

console.log('Opening:', url);

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(12000);

// Intentar interactuar con campos/botón si existen
const clickTexts = [
  /buscar/i,
  /consultar/i,
  /reservar/i,
  /disponibilidad/i,
  /ver disponibilidad/i,
  /search/i
];

for (const rx of clickTexts) {
  try {
    const btn = page.getByRole('button', { name: rx }).first();
    if (await btn.isVisible({ timeout: 1500 })) {
      console.log('Click button:', rx);
      await btn.click({ timeout: 5000 });
      await page.waitForTimeout(8000);
      break;
    }
  } catch {}
}

await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
await page.waitForTimeout(4000);

const text = await page.locator('body').innerText({ timeout: 15000 }).catch(() => '');
const html = await page.content();

await fs.writeFile(`debug/plaza/plaza-zavia-${checkIn}.txt`, text);
await fs.writeFile(`debug/plaza/plaza-zavia-${checkIn}.html`, html);
await fs.writeFile(`debug/plaza/plaza-zavia-${checkIn}.network.json`, JSON.stringify(logs, null, 2));
await page.screenshot({ path: `debug/plaza/plaza-zavia-${checkIn}.png`, fullPage: true });

const prices = text.match(/(?:\$|MXN|mxn)?\s*[0-9]{1,3}(?:[,.][0-9]{3})*(?:[,.][0-9]{2})?\s*(?:MXN|mxn)?/gi) || [];

console.log('Final URL:', page.url());
console.log('Body chars:', text.length);
console.log('Price-like texts:', prices.slice(0, 80));
console.log('Has Superior:', /superior/i.test(text));
console.log('Has Deluxe:', /deluxe/i.test(text));
console.log('Has Jr Suite:', /jr|junior/i.test(text));
console.log('Has MXN:', /mxn/i.test(text));
console.log('Saved: debug/plaza/plaza-zavia-' + checkIn + '.*');

await browser.close();
