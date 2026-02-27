'use strict';

const http = require('http');
const { URL } = require('url');

const HOST = process.env.SCAN_HOST || '0.0.0.0';
const PORT = Number(process.env.SCAN_PORT || 8090);

const ZAP_BASE_URL = process.env.ZAP_BASE_URL || 'http://127.0.0.1:8081';
const ZAP_API_KEY = process.env.ZAP_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
const MAX_POLL_ROUNDS = Number(process.env.ZAP_MAX_POLL_ROUNDS || 120);
const POLL_INTERVAL_MS = Number(process.env.ZAP_POLL_INTERVAL_MS || 1500);

function writeJson(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function normalizeUrl(input) {
  const parsed = new URL(input);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http/https URLs are allowed');
  }
  return parsed.toString();
}

function zapApiUrl(path, params = {}) {
  const apiUrl = new URL(path, ZAP_BASE_URL);
  if (ZAP_API_KEY) apiUrl.searchParams.set('apikey', ZAP_API_KEY);
  for (const [k, v] of Object.entries(params)) {
    apiUrl.searchParams.set(k, String(v));
  }
  return apiUrl.toString();
}

async function fetchZapJson(path, params) {
  const response = await fetch(zapApiUrl(path, params));
  if (!response.ok) {
    throw new Error(`ZAP request failed (${response.status})`);
  }
  return response.json();
}

async function pollPercent(path, idKey, id) {
  for (let i = 0; i < MAX_POLL_ROUNDS; i += 1) {
    const statusResult = await fetchZapJson(path, { [idKey]: id });
    const value = Object.values(statusResult)[0];
    if (String(value) === '100') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out waiting for ${path} to complete`);
}

async function runZapScan(targetUrl) {
  const spiderStart = await fetchZapJson('/JSON/spider/action/scan/', { url: targetUrl, recurse: true });
  const spiderId = spiderStart.scan;
  if (!spiderId) throw new Error('ZAP spider did not return a scan id');
  await pollPercent('/JSON/spider/view/status/', 'scanId', spiderId);

  const ascanStart = await fetchZapJson('/JSON/ascan/action/scan/', {
    url: targetUrl,
    recurse: true,
    inScopeOnly: false
  });
  const ascanId = ascanStart.scan;
  if (!ascanId) throw new Error('ZAP active scan did not return a scan id');
  await pollPercent('/JSON/ascan/view/status/', 'scanId', ascanId);

  const alerts = await fetchZapJson('/JSON/core/view/alerts/', {
    baseurl: targetUrl,
    start: 0,
    count: 9999
  });

  return alerts.alerts || [];
}

async function askGeminiForVerdict(targetUrl, zapAlerts) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is required');
  }

  const prompt = [
    'You are a security verdict classifier.',
    `Target URL: ${targetUrl}`,
    'ZAP vulnerability report JSON:',
    JSON.stringify(zapAlerts),
    'Rules:',
    '- Return exactly one word.',
    '- Output "unsafe" if any vulnerability/risk is present.',
    '- Output "safe" only if report clearly indicates no vulnerabilities.',
    '- Do not output punctuation, explanations, or extra text.'
  ].join('\n');

  const endpoint = `${GEMINI_BASE_URL}/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 2,
        responseMimeType: 'text/plain'
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Gemini request failed (${response.status})`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim()?.toLowerCase() || '';
  if (text === 'safe' || text === 'unsafe') {
    return text;
  }

  if (Array.isArray(zapAlerts) && zapAlerts.length > 0) {
    return 'unsafe';
  }

  return 'safe';
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    writeJson(res, 200, { ok: true, service: 'zap-gemini-scan-server' });
    return;
  }

  if (req.method !== 'POST' || req.url !== '/scan') {
    writeJson(res, 404, {
      error: 'Not found',
      usage: 'POST /scan with JSON body: {"url":"https://example.com"}'
    });
    return;
  }

  try {
    const payload = await readJsonBody(req);
    if (!payload.url || typeof payload.url !== 'string') {
      writeJson(res, 400, { error: 'Missing required string field: url' });
      return;
    }

    const targetUrl = normalizeUrl(payload.url);
    const zapAlerts = await runZapScan(targetUrl);
    const verdict = await askGeminiForVerdict(targetUrl, zapAlerts);

    writeJson(res, 200, { result: verdict });
  } catch (err) {
    writeJson(res, 500, { error: 'Scan failed', details: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Scan server listening on http://${HOST}:${PORT}`);
  console.log('POST /scan with JSON body: {"url":"https://example.com"}');
});
