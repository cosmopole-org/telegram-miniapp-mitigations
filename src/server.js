'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30_000);
const MAX_REDIRECTS = Number(process.env.MAX_REDIRECTS || 5);

function writeJson(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

function serveFile(res, filePath, contentType) {
  const stream = fs.createReadStream(filePath);
  stream.on('error', (err) => {
    writeJson(res, 500, { error: 'Failed to read file', details: err.message });
  });
  res.writeHead(200, { 'Content-Type': contentType });
  stream.pipe(res);
}

function sanitizeHopByHopHeaders(headers) {
  const blocked = new Set([
    'proxy-connection',
    'connection',
    'keep-alive',
    'transfer-encoding',
    'te',
    'trailer',
    'upgrade',
    'proxy-authorization',
    'proxy-authenticate'
  ]);

  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!blocked.has(k.toLowerCase())) {
      out[k] = v;
    }
  }
  return out;
}

function getAbsoluteTargetUrl(req) {
  if (/^https?:\/\//i.test(req.url)) {
    return req.url;
  }

  const host = req.headers.host;
  if (!host) {
    return null;
  }

  return `http://${host}${req.url}`;
}

function proxyHttpRequest(clientReq, clientRes, targetUrl, redirects = 0) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    writeJson(clientRes, 400, { error: 'Invalid target URL', targetUrl });
    return;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    writeJson(clientRes, 400, {
      error: 'Only http/https protocols are supported for regular requests',
      protocol: parsed.protocol
    });
    return;
  }

  const isHttps = parsed.protocol === 'https:';
  const requestOptions = {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    method: clientReq.method,
    path: `${parsed.pathname}${parsed.search}`,
    headers: {
      ...sanitizeHopByHopHeaders(clientReq.headers),
      host: parsed.host
    },
    timeout: REQUEST_TIMEOUT_MS,
    family: 4
  };

  const requestFn = isHttps ? https.request : http.request;
  const upstreamReq = requestFn(requestOptions, (upstreamRes) => {
    if (
      upstreamRes.statusCode >= 300 &&
      upstreamRes.statusCode < 400 &&
      upstreamRes.headers.location &&
      redirects < MAX_REDIRECTS
    ) {
      const nextTarget = new URL(upstreamRes.headers.location, parsed).toString();
      upstreamRes.resume();
      proxyHttpRequest(clientReq, clientRes, nextTarget, redirects + 1);
      return;
    }

    clientRes.writeHead(upstreamRes.statusCode || 502, sanitizeHopByHopHeaders(upstreamRes.headers));
    upstreamRes.pipe(clientRes);
  });

  upstreamReq.on('timeout', () => {
    upstreamReq.destroy(new Error('Upstream request timed out'));
  });

  upstreamReq.on('error', (err) => {
    if (!clientRes.headersSent) {
      writeJson(clientRes, 502, { error: 'Bad Gateway', details: err.message, targetUrl });
      return;
    }

    clientRes.destroy(err);
  });

  clientReq.pipe(upstreamReq);
}

function handleTunnelRoute(req, res) {
  const incoming = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const target = incoming.searchParams.get('url');

  if (!target) {
    writeJson(res, 400, {
      error: 'Missing query parameter: url',
      example: '/tunnel?url=https://example.com/'
    });
    return;
  }

  proxyHttpRequest(req, res, target);
}

function serveIndex(req, res) {
  const indexPath = path.join(__dirname, '..', 'public', 'index.html');
  serveFile(res, indexPath, 'text/html; charset=utf-8');
}

const server = http.createServer((req, res) => {
  if (req.url === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/') {
    serveIndex(req, res);
    return;
  }

  if (req.url.startsWith('/healthz')) {
    writeJson(res, 200, { ok: true, service: 'node-browser-proxy' });
    return;
  }

  if (req.url.startsWith('/tunnel')) {
    handleTunnelRoute(req, res);
    return;
  }

  // Generic forward-proxy behavior for non-CONNECT methods.
  const target = getAbsoluteTargetUrl(req);
  if (!target) {
    writeJson(res, 400, {
      error: 'Cannot determine upstream target URL',
      hint: 'Use this as a browser/system proxy so full absolute URLs are sent, or use /tunnel?url=...'
    });
    return;
  }

  proxyHttpRequest(req, res, target);
});

// HTTPS tunneling for browsers using CONNECT through this proxy.
server.on('connect', (req, clientSocket, head) => {
  const [host, portRaw] = req.url.split(':');
  const port = Number(portRaw) || 443;

  if (!host) {
    clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    clientSocket.destroy();
    return;
  }

  const upstreamSocket = net.connect({ port, host, family: 4 }, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length > 0) {
      upstreamSocket.write(head);
    }
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });

  upstreamSocket.setTimeout(REQUEST_TIMEOUT_MS, () => {
    upstreamSocket.destroy(new Error('CONNECT tunnel timed out'));
  });

  upstreamSocket.on('error', () => {
    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    clientSocket.destroy();
  });

  clientSocket.on('error', () => {
    upstreamSocket.destroy();
  });
});

// WebSocket upgrade proxy support (ws/wss over HTTP proxy route)
server.on('upgrade', (req, socket, head) => {
  const targetUrl = getAbsoluteTargetUrl(req);
  if (!targetUrl) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const isSecure = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
  const port = Number(parsed.port) || (isSecure ? 443 : 80);

  const upstream = net.connect({ port, host: parsed.hostname, family: 4 }, () => {
    const lines = [];
    lines.push(`${req.method} ${parsed.pathname}${parsed.search} HTTP/${req.httpVersion}`);

    const headers = {
      ...sanitizeHopByHopHeaders(req.headers),
      host: parsed.host,
      connection: 'Upgrade',
      upgrade: req.headers.upgrade || 'websocket'
    };

    for (const [k, v] of Object.entries(headers)) {
      lines.push(`${k}: ${v}`);
    }

    lines.push('', '');
    upstream.write(lines.join('\r\n'));

    if (head && head.length > 0) {
      upstream.write(head);
    }

    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  upstream.setTimeout(REQUEST_TIMEOUT_MS, () => {
    upstream.destroy(new Error('Upgrade tunnel timed out'));
  });

  upstream.on('error', () => {
    socket.destroy();
  });

  socket.on('error', () => {
    upstream.destroy();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Proxy server listening on http://${HOST}:${PORT}`);
  console.log('Use as browser/system proxy for HTTP and HTTPS (CONNECT).');
  console.log('Frontend tunnel UI available at /');
});
