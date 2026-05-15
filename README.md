# Hotel Marielena vs Hacienda 1800 — Monitor real de tarifas

Este paquete reemplaza el mockup con un scraper real usando Playwright. Revisa los próximos 30 días, compara la página directa de Hotel Marielena contra Hacienda 1800 y genera `data/rates.latest.json`, que alimenta `dashboard-real.html`.

## Qué compara

Mapeo de habitaciones:

| Hotel Marielena | Hacienda 1800 |
|---|---|
| Suite Patio King | Habitación sencilla |
| Suite Patio Doble | Habitación doble |
| Suite Standard Doble | Habitación doble |
| Jr Suite | Suite Gobernador cama king |
| Master Suite | Suite Gobernador cama king |
| Handicap | Habitación sencilla |

## Instalación local

```bash
npm install
npm run install-browsers
npm run scrape
npm run serve
```

Después abre:

```text
http://localhost:8080/dashboard-real.html
```

## Ejecución diaria

Incluye workflow de GitHub Actions en `.github/workflows/daily-rate-scrape.yml` para correr diario. También se puede programar en una computadora o servidor con cron:

```bash
0 6 * * * cd /ruta/hm_h1800_real_rate_monitor && npm run scrape
```

## Archivos importantes

- `src/scrape-rates.js`: scraper real.
- `src/config.js`: URLs, parámetros, umbrales y configuración.
- `data/room-map.json`: equivalencias de habitaciones.
- `data/rates.latest.json`: archivo generado por el scraper.
- `dashboard-real.html`: dashboard que lee `data/rates.latest.json`.
- `debug/*.png`: capturas de pantalla por fecha para auditar qué vio el scraper.

## Notas importantes

1. Los motores de reserva pueden cambiar su HTML sin avisar. Por eso el scraper guarda screenshots en `debug/` para validar rápidamente si algo dejó de detectar.
2. Si Hacienda 1800/Omnibees no respeta parámetros por URL, el scraper intenta interactuar con el botón de búsqueda. Puede requerir ajustar selectores después de la primera corrida real.
3. La mejor alternativa de largo plazo es pedir API oficial al motor de reservas o channel manager. Para Hotel Marielena, la URL detectada usa Direct Book. Para Hacienda 1800, el botón de reserva apunta a Omnibees.
4. La fórmula de HM Prom. 30 días es promedio simple: suma de tarifas HM detectadas por habitación durante 30 días dividida entre número de días con tarifa detectada.

## Validación después de la primera ejecución

Revisa:

- `data/rates.latest.json`: confirmar que `hmDirect` y `h1800Direct` traen montos.
- `debug/hm-YYYY-MM-DD.png` y `debug/h1800-YYYY-MM-DD.png`: comparar visualmente contra el motor real.
- `dashboard-real.html`: verificar gráfica de días con mayor discrepancia.
