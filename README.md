# Node.js Browser Proxy Server

A forward proxy server built from scratch in Node.js that supports:

- HTTP methods (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, etc.)
- HTTPS tunneling via `CONNECT` (browser/system proxy compatible)
- WebSocket upgrade pass-through
- A simple frontend tunnel UI served at `/`

## Quick start

```bash
npm start
```

Server defaults:

- Host: `0.0.0.0`
- Port: `8080`

## Endpoints

- `GET /` — frontend tunnel page
- `GET /healthz` — health check
- `ANY /tunnel?url=https://target` — proxy/tunnel a URL via query param

## Use as a browser proxy

Set your browser (or system) proxy to:

- HTTP proxy host: your server host
- HTTP proxy port: `8080`
- HTTPS proxy host: your server host
- HTTPS proxy port: `8080`

The proxy handles:

- regular HTTP requests with absolute URLs
- HTTPS traffic through `CONNECT` tunnel

## Security scan server (ZAP + Gemini)

A second server script runs a POST API that accepts a URL, scans it with self-hosted OWASP ZAP, sends the report to Gemini, and returns exactly one verdict word:

- `safe`
- `unsafe`

Start it with:

```bash
npm run start:scan
```

Default host/port for scan server:

- `SCAN_HOST=0.0.0.0`
- `SCAN_PORT=8090`

### Scan API

`POST /scan`

Body:

```json
{
  "url": "https://example.com"
}
```

Success response:

```json
{
  "result": "safe"
}
```

### Required environment for scan server

- `ZAP_BASE_URL` (default `http://127.0.0.1:8081`)
- `ZAP_API_KEY` (optional unless your ZAP instance requires one)
- `GEMINI_API_KEY` (required)
- `GEMINI_MODEL` (default `gemini-1.5-flash`)
- `GEMINI_BASE_URL` (default `https://generativelanguage.googleapis.com`)
- `ZAP_MAX_POLL_ROUNDS` (default `120`)
- `ZAP_POLL_INTERVAL_MS` (default `1500`)

## Telegram bot script (Telegraf + SQLi-safe parameterization)

A third script provides a Telegram bot implemented with **Telegraf** that accepts text commands, validates/sanitizes text parameters, and then queries a PostgreSQL database using **parameterized SQL** (`$1`, `$2`) to prevent SQL injection.

Start it with:

```bash
npm run start:bot
```

Environment variables:

- `TELEGRAM_BOT_TOKEN` (required)
- `DATABASE_URL` (required)
- `DB_SSL` (`true`/`false`, default `false`)
- `BOT_COMMAND_PREFIX` (default `/`)

Supported commands:

- `/user_by_role <role>`
- `/orders_by_status <status> <limit>`
- `/product_by_sku <sku>`

Security behavior:

- incoming command params are normalized, character-filtered, and length-limited
- numeric arguments are range checked
- all DB reads use parameter arrays instead of string concatenation

## Environment variables

Proxy server variables:

- `HOST` (default `0.0.0.0`)
- `PORT` (default `8080`)
- `REQUEST_TIMEOUT_MS` (default `30000`)
- `MAX_REDIRECTS` (default `5`)

## Notes

Some websites may refuse iframe embedding in the frontend tunnel because of:

- `X-Frame-Options`
- restrictive `Content-Security-Policy`

In those cases, use the proxy as a browser/system proxy instead of iframe mode.
