import { createServer } from 'node:http';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

function serveStatic(req, res) {
  const safePath = req.url.replace(/\.\./g, '').split('?')[0];
  const filePath = join(PUBLIC_DIR, safePath === '/' ? 'index.html' : safePath);
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) throw new Error('not a file');
    const ext = extname(filePath);
    const body = readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function noContent(res) {
  res.writeHead(204);
  res.end();
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function checkAuth(req, res, password) {
  if (!password) return true;
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Basic ')) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="FlunkieBot"' });
    res.end();
    return false;
  }
  const decoded = Buffer.from(auth.slice(6), 'base64').toString();
  const colonIdx = decoded.indexOf(':');
  const pass = colonIdx >= 0 ? decoded.slice(colonIdx + 1) : decoded;
  if (pass !== password) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="FlunkieBot"' });
    res.end();
    return false;
  }
  return true;
}

export function createDashboard({ memory, systemPromptPath, port = 4444, password, logEmitter, logger, sendDirect, triggerAI }) {
  // Ring buffer of recent log entries, flushed to new SSE clients immediately.
  const LOG_RING = 500;
  const logBuffer = [];
  const sseClients = new Set();

  if (logEmitter) {
    logEmitter.on('log', (entry) => {
      logBuffer.push(entry);
      if (logBuffer.length > LOG_RING) logBuffer.shift();
      const line = `data: ${JSON.stringify(entry)}\n\n`;
      for (const res of sseClients) {
        try { res.write(line); } catch { sseClients.delete(res); }
      }
    });
  }

  // Heartbeat keeps proxies from closing idle SSE connections.
  setInterval(() => {
    const ping = ': ping\n\n';
    for (const res of sseClients) {
      try { res.write(ping); } catch { sseClients.delete(res); }
    }
  }, 25_000).unref();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost`);
    const path = url.pathname;

    // Static files
    if (!path.startsWith('/api')) {
      if (!serveStatic(req, res)) {
        // SPA fallback
        const index = readFileSync(join(PUBLIC_DIR, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(index);
      }
      return;
    }

    // Auth
    if (!checkAuth(req, res, password)) return;

    const method = req.method;

    try {
      // GET /api/logs/stream  (SSE)
      if (method === 'GET' && path === '/api/logs/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(': connected\n\n');
        // Flush ring buffer to new client
        for (const entry of logBuffer) {
          res.write(`data: ${JSON.stringify(entry)}\n\n`);
        }
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      // GET /api/stats
      if (method === 'GET' && path === '/api/stats') {
        return json(res, 200, memory.dashboard.stats());
      }

      // GET /api/conversations
      if (method === 'GET' && path === '/api/conversations') {
        return json(res, 200, memory.dashboard.conversations());
      }

      // GET /api/messages
      if (method === 'GET' && path === '/api/messages') {
        const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
        const offset = Number(url.searchParams.get('offset')) || 0;
        const convId = url.searchParams.has('conversationId')
          ? Number(url.searchParams.get('conversationId'))
          : null;
        return json(res, 200, memory.dashboard.messages(limit, offset, convId));
      }

      // GET /api/participants
      if (method === 'GET' && path === '/api/participants') {
        return json(res, 200, memory.dashboard.participants());
      }

      // GET /api/memories/claims
      if (method === 'GET' && path === '/api/memories/claims') {
        return json(res, 200, memory.dashboard.claims());
      }

      // GET /api/memories/episodes
      if (method === 'GET' && path === '/api/memories/episodes') {
        return json(res, 200, memory.dashboard.episodes());
      }

      // GET /api/memories/patterns
      if (method === 'GET' && path === '/api/memories/patterns') {
        return json(res, 200, memory.dashboard.patterns());
      }

      // DELETE /api/memories  (reset all)
      if (method === 'DELETE' && path === '/api/memories') {
        memory.dashboard.resetAllMemory();
        return noContent(res);
      }

      // DELETE /api/memories/claims/:id
      const claimDelete = path.match(/^\/api\/memories\/claims\/(\d+)$/);
      if (method === 'DELETE' && claimDelete) {
        memory.dashboard.deleteClaim(Number(claimDelete[1]));
        return noContent(res);
      }

      // DELETE /api/memories/episodes/:id
      const episodeDelete = path.match(/^\/api\/memories\/episodes\/(\d+)$/);
      if (method === 'DELETE' && episodeDelete) {
        memory.dashboard.deleteEpisode(Number(episodeDelete[1]));
        return noContent(res);
      }

      // DELETE /api/memories/patterns/:id
      const patternDelete = path.match(/^\/api\/memories\/patterns\/(\d+)$/);
      if (method === 'DELETE' && patternDelete) {
        memory.dashboard.deletePattern(Number(patternDelete[1]));
        return noContent(res);
      }

      // GET /api/extraction-runs
      if (method === 'GET' && path === '/api/extraction-runs') {
        const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
        const offset = Number(url.searchParams.get('offset')) || 0;
        return json(res, 200, memory.dashboard.extractionRuns(limit, offset));
      }

      // GET /api/analytics
      if (method === 'GET' && path === '/api/analytics') {
        const days = Math.min(Number(url.searchParams.get('days')) || 30, 90);
        return json(res, 200, memory.dashboard.analytics(days));
      }

      // GET /api/system-prompt
      if (method === 'GET' && path === '/api/system-prompt') {
        return json(res, 200, { text: readFileSync(systemPromptPath, 'utf-8') });
      }

      // POST /api/system-prompt
      if (method === 'POST' && path === '/api/system-prompt') {
        const body = await parseBody(req);
        if (typeof body.text !== 'string') return json(res, 400, { error: 'text must be a string' });
        writeFileSync(systemPromptPath, body.text, 'utf-8');
        return json(res, 200, { ok: true });
      }

      // POST /api/conversations/:id/send  (send exact text as bot)
      const sendMatch = path.match(/^\/api\/conversations\/(\d+)\/send$/);
      if (method === 'POST' && sendMatch) {
        const convId = Number(sendMatch[1]);
        const body = await parseBody(req);
        if (!body.text?.trim()) return json(res, 400, { error: 'text required' });
        if (!sendDirect) return json(res, 503, { error: 'sendDirect not configured' });
        await sendDirect({ convId, text: body.text.trim() });
        return noContent(res);
      }

      // POST /api/conversations/:id/inject  (trigger AI response)
      const injectMatch = path.match(/^\/api\/conversations\/(\d+)\/inject$/);
      if (method === 'POST' && injectMatch) {
        const convId = Number(injectMatch[1]);
        const body = await parseBody(req);
        if (!triggerAI) return json(res, 503, { error: 'triggerAI not configured' });
        await triggerAI({ convId, type: body.type || 'normal', query: body.query });
        return noContent(res);
      }

      json(res, 404, { error: 'Not found' });
    } catch (err) {
      logger?.error({ err }, 'Dashboard request failed');
      json(res, 500, { error: err.message });
    }
  });

  server.listen(port, () => {
    logger?.info({ port }, 'Dashboard listening');
  });

  return server;
}
