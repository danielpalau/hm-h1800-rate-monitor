import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import { CONFIG } from './config.js';

const checkIn = process.argv[2] || '2026-05-18';
const checkOut = process.argv[3] || '2026-05-19';

await fs.mkdir('debug/network', { recursive: true });

const browser = await chromium.launch({ headless: false, slowMo: 300 });
const context = await browser.newContext({
  locale: 'es-MX',
  timezoneId: CONFIG.timezone,
  viewport: { width: 1365, height: 900 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
});

const page = await context.newPage();
const logs = [];

page.on('request', req => {
  const url = req.url();
  if (/direct-book|api|availability|rate|room|booking|properties|quote|reservation|hotelmarielena/i.test(url)) {
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
  if (/direct-book|api|availability|rate|room|booking|properties|quote|reservation|hotelmarielena/i.test(url)) {
    let body = '';
    try {
      const ct = res.headers()['content-type'] || '';
      if (/json|text|javascript/i.test(ct)) {
        body = await res.text();
      }
    } catch {}

    logs.push({
      type: 'response',
      status: res.status(),
      url,
      bodyPreview: body.slice(0, 5000)
    });
  }
});

const url = CONFIG.hotels.hm.urlForDate(checkIn, checkOut);

console.log('Opening:', url);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(20000);

await page.screenshot({ path: `debug/network/hm-network-${checkIn}.png`, fullPage: true });

const bodyText = await page.locator('body').innerText().catch(() => '');
await fs.writeFile(`debug/network/hm-network-${checkIn}.txt`, bodyText);
await fs.writeFile(`debug/network/hm-network-${checkIn}.json`, JSON.stringify(logs, null, 2));

console.log('Saved:');
console.log(`debug/network/hm-network-${checkIn}.json`);
console.log(`debug/network/hm-network-${checkIn}.txt`);
console.log(`debug/network/hm-network-${checkIn}.png`);
console.log('Network entries:', logs.length);

await browser.close();
