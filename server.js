'use strict';

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VERSION = '1.1.0';
const PROCESS_STARTED = Date.now();
const PUBLIC_DIR = path.join(__dirname, 'public');

function envInt(name, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

const ADMIN_PORT = envInt('ADMIN_PORT', 3000, 1, 65535);
const PROXY_PORT = envInt('PROXY_PORT', 8000, 1, 65535);
const MAX_CONNECTIONS = envInt('MAX_CONNECTIONS', 64, 1, 512);
const SESSION_TTL_MS = envInt('SESSION_HOURS', 12, 1, 24 * 30) * 60 * 60 * 1000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const PUBLIC_ENDPOINT = (process.env.PUBLIC_SOCKS_ENDPOINT || '')
  .trim()
  .replace(/^socks(?:5h?)?:\/\//i, '')
  .replace(/#.*$/, '')
  .replace(/\/+$/, '');
const SPEEDTEST_URL =
  process.env.SPEEDTEST_URL || 'https://speed.cloudflare.com/__down?bytes=100000000';

if (ADMIN_PASSWORD.length < 8) {
  console.error('[fatal] ADMIN_PASSWORD must be set to at least 8 characters.');
  process.exit(1);
}

if (ADMIN_PORT === PROXY_PORT) {
  console.error('[fatal] ADMIN_PORT and PROXY_PORT must be different.');
  process.exit(1);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const state = {
  enabled: String(process.env.PROXY_ENABLED || 'true').toLowerCase() !== 'false',
  user: process.env.PROXY_USER || 'relay',
  pass: process.env.PROXY_PASS || crypto.randomBytes(15).toString('base64url'),
  credSource: process.env.PROXY_PASS ? 'environment' : 'generated',
  maxConnections: MAX_CONNECTIONS,
  connections: new Map(),
  activeSessions: new Map(),
  totals: { up: 0, down: 0, sessions: 0, rejected: 0 },
  log: [],
  speedTestRunning: false,
};

if (!/^[A-Za-z0-9._-]{1,64}$/.test(state.user)) {
  console.error(
    '[fatal] PROXY_USER must be 1-64 characters: letters, numbers, dots, dashes, or underscores.'
  );
  process.exit(1);
}

if (
  process.env.PROXY_PASS &&
  (process.env.PROXY_PASS.length < 8 ||
    process.env.PROXY_PASS.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(process.env.PROXY_PASS))
) {
  console.error('[fatal] PROXY_PASS must be 8-128 printable characters.');
  process.exit(1);
}

const sessions = new Map();
const loginFailures = new Map();

function log(level, message) {
  const entry = { t: Date.now(), level, message };
  state.log.unshift(entry);
  if (state.log.length > 80) state.log.length = 80;
  const stamp = new Date(entry.t).toISOString().slice(11, 19);
  console.log(`[${stamp}] ${level} ${message}`);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function peerLabel(socket) {
  const address = (socket.remoteAddress || '').replace(/^::ffff:/, '');
  return `${address}:${socket.remotePort}`;
}

function replyCode(error) {
  switch (error && error.code) {
    case 'ECONNREFUSED':
      return 0x05;
    case 'ENETUNREACH':
      return 0x03;
    case 'EHOSTUNREACH':
      return 0x04;
    case 'ETIMEDOUT':
      return 0x06;
    default:
      return 0x01;
  }
}

class SocksSession {
  constructor(socket) {
    this.id = crypto.randomBytes(5).toString('hex');
    this.socket = socket;
    this.targetSocket = null;
    this.target = '';
    this.stage = 'greeting';
    this.buffer = Buffer.alloc(0);
    this.pending = null;
    this.started = Date.now();
    this.up = 0;
    this.down = 0;
    this.replied = false;
    this.closed = false;
    this.cleaned = false;

    this.view = {
      id: this.id,
      client: peerLabel(socket),
      target: '',
      started: this.started,
      up: 0,
      down: 0,
      phase: 'handshake',
    };

    state.connections.set(this.id, this.view);
    state.activeSessions.set(this.id, this);
    state.totals.sessions += 1;

    socket.setNoDelay(true);
    socket.setTimeout(15_000, () => this.destroy('handshake timed out'));

    this.onHandshakeData = (chunk) => this.feed(chunk);
    socket.on('data', this.onHandshakeData);
    socket.once('error', () => this.destroy(null));
    socket.once('close', () => this.cleanup());

    log('info', `session ${this.id} from ${this.view.client}`);
  }

  feed(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      this.pump();
    } catch (error) {
      log('warn', `session ${this.id} protocol error: ${error.message}`);
      this.fail(0x01);
    }
  }

  pump() {
    for (;;) {
      if (this.stage === 'greeting') {
        if (this.buffer.length < 2) return;
        if (this.buffer[0] !== 0x05) return this.fail(0x01);
        const methodCount = this.buffer[1];
        if (this.buffer.length < 2 + methodCount) return;
        const methods = this.buffer.subarray(2, 2 + methodCount);
        this.buffer = this.buffer.subarray(2 + methodCount);

        if (!methods.includes(0x02)) {
          this.replied = true;
          this.view.phase = 'failed';
          this.write(Buffer.from([0x05, 0xff]));
          this.socket.end();
          return;
        }

        this.view.phase = 'auth';
        this.write(Buffer.from([0x05, 0x02]));
        this.stage = 'auth';
        continue;
      }

      if (this.stage === 'auth') {
        if (this.buffer.length < 2) return;
        if (this.buffer[0] !== 0x01) return this.fail(0x01);

        const userLength = this.buffer[1];
        if (this.buffer.length < 2 + userLength + 1) return;
        const passLength = this.buffer[2 + userLength];
        if (this.buffer.length < 2 + userLength + 1 + passLength) return;

        const user = this.buffer.subarray(2, 2 + userLength).toString('utf8');
        const pass = this.buffer
          .subarray(3 + userLength, 3 + userLength + passLength)
          .toString('utf8');
        this.buffer = this.buffer.subarray(3 + userLength + passLength);

        const userOk = safeEqual(user, state.user);
        const passOk = safeEqual(pass, state.pass);
        if (!(userOk & passOk)) {
          state.totals.rejected += 1;
          this.replied = true;
          this.view.phase = 'failed';
          log('warn', `session ${this.id} authentication failed`);
          this.write(Buffer.from([0x01, 0x01]));
          this.socket.end();
          return;
        }

        this.view.phase = 'request';
        this.write(Buffer.from([0x01, 0x00]));
        this.stage = 'request';
        continue;
      }

      if (this.stage === 'request') {
        if (this.buffer.length < 4) return;
        if (this.buffer[0] !== 0x05) return this.fail(0x01);

        const command = this.buffer[1];
        const addressType = this.buffer[3];
        let addressLength;
        let addressOffset = 4;

        if (addressType === 0x01) {
          addressLength = 4;
        } else if (addressType === 0x04) {
          addressLength = 16;
        } else if (addressType === 0x03) {
          if (this.buffer.length < 5) return;
          addressLength = this.buffer[4];
          addressOffset = 5;
        } else {
          return this.fail(0x08);
        }

        if (this.buffer.length < addressOffset + addressLength + 2) return;

        const host = this.readAddress(addressType, addressOffset, addressLength);
        const port = this.buffer.readUInt16BE(addressOffset + addressLength);
        this.buffer = this.buffer.subarray(addressOffset + addressLength + 2);

        if (command !== 0x01) return this.fail(0x07);
        if (!host || port === 0) return this.fail(0x01);

        this.pending = this.buffer.length ? this.buffer : null;
        this.buffer = Buffer.alloc(0);
        this.target = `${host}:${port}`;
        this.view.target = this.target;
        this.view.phase = 'connecting';
        this.stage = 'connecting';
        this.connectTarget(host, port);
        return;
      }

      return;
    }
  }

  readAddress(type, offset, length) {
    if (type === 0x01) {
      return Array.from(this.buffer.subarray(offset, offset + 4)).join('.');
    }
    if (type === 0x04) {
      const parts = [];
      for (let index = 0; index < 16; index += 2) {
        parts.push(this.buffer.readUInt16BE(offset + index).toString(16));
      }
      return parts.join(':');
    }
    return this.buffer.subarray(offset, offset + length).toString('utf8');
  }

  connectTarget(host, port) {
    const target = net.connect({ host, port });
    this.targetSocket = target;
    target.setNoDelay(true);

    const connectTimer = setTimeout(() => {
      target.destroy();
      if (!this.replied) this.fail(0x06);
    }, 20_000);

    target.on('error', (error) => {
      clearTimeout(connectTimer);
      if (!this.replied) this.fail(replyCode(error));
      else this.destroy(`target error: ${error.code || error.message}`);
    });

    target.once('close', () => this.destroy(null));

    target.once('connect', () => {
      clearTimeout(connectTimer);
      if (this.closed || this.socket.destroyed) {
        target.destroy();
        return;
      }

      this.socket.setTimeout(0);
      this.socket.removeListener('data', this.onHandshakeData);

      const early = this.buffer.length
        ? Buffer.concat([this.pending || Buffer.alloc(0), this.buffer])
        : this.pending;
      this.buffer = Buffer.alloc(0);
      this.pending = null;

      this.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      this.replied = true;
      this.view.phase = 'open';

      this.socket.on('end', () => target.end());
      target.on('end', () => this.socket.end());

      if (early && early.length) {
        this.up += early.length;
        state.totals.up += early.length;
        this.view.up = this.up;
        target.write(early);
      }

      this.socket.on('data', (chunk) => {
        this.up += chunk.length;
        state.totals.up += chunk.length;
        this.view.up = this.up;
        if (!target.write(chunk)) this.socket.pause();
      });
      this.socket.on('drain', () => target.resume());

      target.on('data', (chunk) => {
        this.down += chunk.length;
        state.totals.down += chunk.length;
        this.view.down = this.down;
        if (!this.socket.write(chunk)) target.pause();
      });
      target.on('drain', () => this.socket.resume());

      log('info', `session ${this.id} open ${this.target}`);
    });
  }

  write(chunk) {
    if (!this.socket.destroyed) this.socket.write(chunk);
  }

  fail(code) {
    if (this.closed) return;
    if (this.replied) {
      this.destroy(null);
      return;
    }
    this.replied = true;
    this.view.phase = 'failed';
    this.write(Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    this.socket.end();
  }

  destroy(reason) {
    if (this.closed) return;
    this.closed = true;
    if (reason) log('info', `session ${this.id} closed: ${reason}`);
    if (this.targetSocket) this.targetSocket.destroy();
    if (this.socket) this.socket.destroy();
  }

  cleanup() {
    if (this.cleaned) return;
    this.cleaned = true;
    state.connections.delete(this.id);
    state.activeSessions.delete(this.id);
    if (this.targetSocket && !this.targetSocket.destroyed) this.targetSocket.destroy();
    if (this.view.phase === 'open') {
      log(
        'info',
        `session ${this.id} ended ${this.target} (down ${this.down} B, up ${this.up} B)`
      );
    }
  }
}

let socksServer = null;

function startSocksListener() {
  if (socksServer) return;
  socksServer = net.createServer({ allowHalfOpen: true }, (socket) => {
    if (!state.enabled) {
      state.totals.rejected += 1;
      socket.destroy();
      return;
    }
    if (state.connections.size >= state.maxConnections) {
      state.totals.rejected += 1;
      socket.end(Buffer.from([0x05, 0xff]));
      return;
    }
    new SocksSession(socket);
  });
  socksServer.on('error', (error) => {
    log('error', `SOCKS listener failed: ${error.message}`);
  });
  socksServer.listen(PROXY_PORT, '0.0.0.0', () => {
    log('info', `SOCKS5 listener on :${PROXY_PORT}`);
  });
}

function createSession(ip) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { expires: Date.now() + SESSION_TTL_MS, ip });
  return token;
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index > 0) {
      const key = part.slice(0, index).trim();
      cookies[key] = decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return cookies;
}

function cookieToken(req) {
  return parseCookies(req.headers.cookie).relay_sid || '';
}

function sessionFor(req) {
  const token = cookieToken(req);
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expires <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function clientIp(req) {
  if (process.env.TRUST_PROXY !== 'false') {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded) {
      return forwarded.split(',')[0].trim();
    }
  }
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function loginBlocked(ip) {
  const record = loginFailures.get(ip);
  if (!record) return false;
  if (Date.now() > record.reset) {
    loginFailures.delete(ip);
    return false;
  }
  return record.count >= 8;
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const record = loginFailures.get(ip);
  if (!record || now > record.reset) {
    loginFailures.set(ip, { count: 1, reset: now + 10 * 60 * 1000 });
  } else {
    record.count += 1;
  }
}

function buildShareLink() {
  if (!PUBLIC_ENDPOINT) return '';
  const userinfo = Buffer.from(`${state.user}:${state.pass}`, 'utf8').toString('base64url');
  return `socks://${userinfo}@${PUBLIC_ENDPOINT}#runflare`;
}

function statusPayload() {
  return {
    version: VERSION,
    startedAt: PROCESS_STARTED,
    uptimeSec: Math.floor((Date.now() - PROCESS_STARTED) / 1000),
    enabled: state.enabled,
    listen: { host: '0.0.0.0', port: PROXY_PORT },
    publicEndpoint: PUBLIC_ENDPOINT,
    credentials: { user: state.user, source: state.credSource },
    limits: { maxConnections: state.maxConnections },
    traffic: {
      up: state.totals.up,
      down: state.totals.down,
      sessions: state.totals.sessions,
      rejected: state.totals.rejected,
    },
    active: state.connections.size,
    connections: Array.from(state.connections.values())
      .sort((left, right) => right.started - left.started)
      .slice(0, 50),
    log: state.log.slice(0, 16),
    speedTest: { running: state.speedTestRunning, url: SPEEDTEST_URL },
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function readJson(req) {
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (!type.startsWith('application/json')) {
    throw new HttpError(415, 'Content-Type must be application/json');
  }
  return readBody(req, 64 * 1024).then((body) => {
    if (!body) return {};
    try {
      return JSON.parse(body);
    } catch {
      throw new HttpError(400, 'Invalid JSON body');
    }
  });
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(303, { Location: location });
  res.end();
}

function serveFile(res, name) {
  const file = path.join(PUBLIC_DIR, name);
  fs.readFile(file, (error, data) => {
    if (error) {
      sendText(res, 404, 'Not found');
      return;
    }
    const extension = path.extname(file);
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.woff2': 'font/woff2',
      '.woff': 'font/woff',
    };
    const isFont = extension === '.woff2' || extension === '.woff';
    res.writeHead(200, {
      'Content-Type': types[extension] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': isFont ? 'public, max-age=31536000, immutable' : 'no-store',
    });
    res.end(data);
  });
}

async function handleLogin(req, res) {
  const ip = clientIp(req);
  if (loginBlocked(ip)) {
    redirect(res, '/login?error=rate');
    return;
  }

  const body = await readBody(req, 4 * 1024);
  const password = new URLSearchParams(body).get('password') || '';

  if (!safeEqual(password, ADMIN_PASSWORD)) {
    recordLoginFailure(ip);
    log('warn', `admin login failed from ${ip}`);
    redirect(res, '/login?error=1');
    return;
  }

  loginFailures.delete(ip);
  const token = createSession(ip);
  const secure = String(req.headers['x-forwarded-proto'] || '').startsWith('https')
    ? '; Secure'
    : '';
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader(
    'Set-Cookie',
    `relay_sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`
  );
  log('info', `admin login from ${ip}`);
  redirect(res, '/');
}

async function handleState(req, res) {
  const body = await readJson(req);
  if (typeof body.enabled !== 'boolean') {
    throw new HttpError(400, 'enabled must be true or false');
  }
  if (state.enabled !== body.enabled) {
    state.enabled = body.enabled;
    if (!state.enabled) {
      for (const session of state.activeSessions.values()) {
        session.destroy('relay paused');
      }
      log('info', 'relay paused from the control panel');
    } else {
      log('info', 'relay resumed from the control panel');
    }
  }
  json(res, 200, statusPayload());
}

async function handleCredentials(req, res) {
  const body = await readJson(req);
  const user = String(body.user || '').trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(user)) {
    throw new HttpError(
      400,
      'Username must be 1-64 characters: letters, numbers, dots, dashes, or underscores'
    );
  }
  if (body.pass !== undefined) {
    const pass = String(body.pass);
    if (pass.length < 8 || pass.length > 128) {
      throw new HttpError(400, 'Password must be 8-128 characters');
    }
    if (/[\u0000-\u001f\u007f]/.test(pass)) {
      throw new HttpError(400, 'Password contains control characters');
    }
    state.pass = pass;
  }
  state.user = user;
  state.credSource = 'panel';
  log('info', 'proxy credentials updated from the control panel');
  json(res, 200, statusPayload());
}

async function handleLimits(req, res) {
  const body = await readJson(req);
  const value = Number(body.maxConnections);
  if (!Number.isInteger(value) || value < 1 || value > 512) {
    throw new HttpError(400, 'maxConnections must be an integer from 1 to 512');
  }
  state.maxConnections = value;
  log('info', `connection limit set to ${value}`);
  json(res, 200, statusPayload());
}

function isLocalHost(hostname) {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host === '::1' ||
    host === '169.254.169.254' ||
    host.endsWith('.local')
  );
}

async function runSpeedTest(rawUrl) {
  const target = new URL(rawUrl);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new HttpError(400, 'Only http and https URLs are supported');
  }
  if (isLocalHost(target.hostname)) {
    throw new HttpError(400, 'Local addresses are not allowed');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  const start = Date.now();
  let bytes = 0;
  let partial = false;

  try {
    const response = await fetch(target, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': `relay-control/${VERSION}` },
    });
    if (!response.ok) throw new Error(`Target returned HTTP ${response.status}`);
    if (!response.body) throw new Error('Target returned an empty body');

    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes >= 200 * 1024 * 1024) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') partial = true;
    else if (bytes === 0) throw error;
  } finally {
    clearTimeout(timer);
  }

  if (bytes === 0) throw new Error('No data received before the timeout');
  const seconds = Math.max(0.001, (Date.now() - start) / 1000);
  return {
    url: target.href,
    bytes,
    seconds: Number(seconds.toFixed(2)),
    mbps: Number(((bytes * 8) / 1e6 / seconds).toFixed(1)),
    partial,
  };
}

async function handleSpeedTest(req, res) {
  if (state.speedTestRunning) {
    throw new HttpError(409, 'A speed test is already running');
  }
  const body = await readJson(req);
  const url = String(body.url || SPEEDTEST_URL);
  state.speedTestRunning = true;
  try {
    const result = await runSpeedTest(url);
    log('info', `route test: ${result.mbps} Mbps from the container`);
    json(res, 200, result);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, error.message);
  } finally {
    state.speedTestRunning = false;
  }
}

async function handleKill(req, res) {
  const body = await readJson(req);
  const session = state.activeSessions.get(String(body.id || ''));
  if (!session) throw new HttpError(404, 'Connection not found');
  session.destroy('closed from the control panel');
  json(res, 200, { ok: true });
}

async function handleRequest(req, res) {
  req.on('error', () => {});
  res.on('error', () => {});
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'"
  );

  const url = new URL(req.url || '/', 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/healthz') {
    sendText(res, 200, 'ok');
    return;
  }

  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === '/login') {
    if (req.method === 'GET') {
      if (sessionFor(req)) {
        redirect(res, '/');
        return;
      }
      serveFile(res, 'login.html');
      return;
    }
    if (req.method === 'POST') {
      await handleLogin(req, res);
      return;
    }
    sendText(res, 405, 'Method not allowed');
    return;
  }

  if (pathname === '/logout') {
    if (req.method !== 'POST') {
      sendText(res, 405, 'Method not allowed');
      return;
    }
    const token = cookieToken(req);
    if (token) sessions.delete(token);
    res.setHeader(
      'Set-Cookie',
      'relay_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
    );
    redirect(res, '/login');
    return;
  }

  if (
    req.method === 'GET' &&
    (pathname === '/style.css' || pathname === '/app.js' || pathname === '/login.js')
  ) {
    serveFile(res, pathname.slice(1));
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/fonts/')) {
    if (!/^\/fonts\/[A-Za-z0-9._-]+\.woff2$/.test(pathname)) {
      sendText(res, 404, 'Not found');
      return;
    }
    serveFile(res, pathname.slice(1));
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    if (!sessionFor(req)) {
      redirect(res, '/login');
      return;
    }
    serveFile(res, 'index.html');
    return;
  }

  if (pathname.startsWith('/api/')) {
    if (!sessionFor(req)) {
      json(res, 401, { error: 'Not signed in' });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/status') {
      json(res, 200, statusPayload());
      return;
    }
    if (req.method === 'GET' && pathname === '/api/secret') {
      json(res, 200, { user: state.user, pass: state.pass, link: buildShareLink() });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/state') {
      await handleState(req, res);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/credentials') {
      await handleCredentials(req, res);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/limits') {
      await handleLimits(req, res);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/speedtest') {
      await handleSpeedTest(req, res);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/connections/kill') {
      await handleKill(req, res);
      return;
    }
    json(res, 404, { error: 'Not found' });
    return;
  }

  sendText(res, 404, 'Not found');
}

const adminServer = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) {
      log('error', `request failed: ${error.stack || error.message}`);
    }
    if (!res.headersSent) {
      json(res, status, { error: status >= 500 ? 'Server error' : error.message });
    } else {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expires <= now) sessions.delete(token);
  }
  for (const [ip, record] of loginFailures) {
    if (record.reset <= now) loginFailures.delete(ip);
  }
}, 10 * 60 * 1000).unref();

startSocksListener();

adminServer.listen(ADMIN_PORT, '0.0.0.0', () => {
  log('info', `control panel listening on :${ADMIN_PORT}`);
  log('info', `relay is ${state.enabled ? 'active' : 'paused'}`);
  if (state.credSource === 'generated') {
    log('warn', 'no PROXY_PASS set; generated a proxy password at boot. Use Reveal in the panel to copy it.');
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('info', `received ${signal}, shutting down`);
    for (const session of state.activeSessions.values()) {
      session.destroy('shutdown');
    }
    if (socksServer) socksServer.close();
    adminServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
