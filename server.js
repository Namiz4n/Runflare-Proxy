'use strict';

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VERSION = '1.2.0';
const PROCESS_STARTED = Date.now();
const PUBLIC_DIR = path.join(__dirname, 'public');
const VLESS_PATH = '/ws';
const MAX_WS_FRAME = 8 * 1024 * 1024;
const WS_PING_MS = 30_000;
const WS_IDLE_MS = 90_000;

function envInt(name, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

const ADMIN_PORT = envInt('ADMIN_PORT', 3000, 1, 65535);
const PROXY_PORT = envInt('PROXY_PORT', 8000, 1, 65535);
const MAX_CONNECTIONS = envInt('MAX_CONNECTIONS', 64, 1, 512);
const SESSION_TTL_MS = envInt('SESSION_HOURS', 12, 1, 24 * 30) * 60 * 60 * 1000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const PUBLIC_VLESS_ENDPOINT = (process.env.PUBLIC_VLESS_ENDPOINT || '').trim();

function normalizeUuid(value) {
  const uuid = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    uuid
  )
    ? uuid
    : '';
}

function deriveUuid(secret) {
  const bytes = Buffer.from(
    crypto.createHash('sha256').update(`runflare-vless:${secret}`).digest().subarray(0, 16)
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20
  )}-${hex.slice(20)}`;
}

function resolveVlessUuid() {
  const configured = String(process.env.VLESS_UUID || '').trim();
  if (configured) {
    const normalized = normalizeUuid(configured);
    if (!normalized) {
      console.error('[fatal] VLESS_UUID must be a valid UUID.');
      process.exit(1);
    }
    return normalized;
  }
  return deriveUuid(ADMIN_PASSWORD);
}

const VLESS_UUID = resolveVlessUuid();
const VLESS_UUID_BYTES = Buffer.from(VLESS_UUID.replace(/-/g, ''), 'hex');
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
      protocol: 'socks5',
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

class WebSocketConnection {
  constructor(socket, req) {
    this.socket = socket;
    this.req = req;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.closing = false;
    this.closeSent = false;
    this.fragmented = false;
    this.fragmentedText = false;
    this.lastActivity = Date.now();
    this.onData = null;
    this.onClose = null;
    this.onDrain = null;

    socket.setNoDelay(true);
    socket.setTimeout(0);
    socket.on('data', (chunk) => this.feed(chunk));
    socket.on('error', () => this.destroy());
    socket.on('close', () => this.destroy());
    socket.on('drain', () => {
      if (this.onDrain) this.onDrain();
    });

    this.pingTimer = setInterval(() => {
      if (this.closed) return;
      if (Date.now() - this.lastActivity > WS_IDLE_MS) {
        this.destroy();
        return;
      }
      this.sendFrame(0x9, Buffer.from('rf'));
    }, WS_PING_MS);
    this.pingTimer.unref();
  }

  feed(chunk) {
    if (this.closed) return;
    this.lastActivity = Date.now();
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;

    while (!this.closed && !this.closing) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const rsv = first & 0x70;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (rsv !== 0) {
        this.fail(1002, 'RSV bits are not supported');
        return;
      }
      if (!masked) {
        this.fail(1002, 'Client frames must be masked');
        return;
      }

      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const high = this.buffer.readUInt32BE(2);
        const low = this.buffer.readUInt32BE(6);
        if (high !== 0 || low > MAX_WS_FRAME) {
          this.fail(1009, 'Frame is too large');
          return;
        }
        length = low;
        offset = 10;
      }

      if (length > MAX_WS_FRAME) {
        this.fail(1009, 'Frame is too large');
        return;
      }
      if (this.buffer.length < offset + 4 + length) return;

      const mask = this.buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.allocUnsafe(length);
      for (let index = 0; index < length; index += 1) {
        payload[index] = this.buffer[offset + index] ^ mask[index & 3];
      }
      this.buffer = this.buffer.subarray(offset + length);
      this.handleFrame(fin, opcode, payload);
    }
  }

  handleFrame(fin, opcode, payload) {
    if (opcode >= 0x8) {
      if (!fin || payload.length > 125) {
        this.fail(1002, 'Invalid control frame');
        return;
      }
      if (opcode === 0x8) {
        if (!this.closeSent) {
          this.sendFrame(0x8, payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0));
          this.closeSent = true;
        }
        this.destroy();
        return;
      }
      if (opcode === 0x9) {
        this.sendFrame(0xa, payload);
        return;
      }
      if (opcode === 0xa) return;
      this.fail(1002, 'Unsupported control frame');
      return;
    }

    if (opcode === 0x0) {
      if (!this.fragmented) {
        this.fail(1002, 'Unexpected continuation frame');
        return;
      }
      if (!this.fragmentedText && this.onData && payload.length) this.onData(payload);
      if (fin) {
        this.fragmented = false;
        this.fragmentedText = false;
      }
      return;
    }

    if (opcode === 0x1) {
      if (this.fragmented) {
        this.fail(1002, 'Nested fragmented message');
        return;
      }
      if (fin) {
        this.fail(1003, 'Text frames are not supported');
        return;
      }
      this.fragmented = true;
      this.fragmentedText = true;
      return;
    }

    if (opcode === 0x2) {
      if (this.fragmented) {
        this.fail(1002, 'Nested fragmented message');
        return;
      }
      if (payload.length && this.onData) this.onData(payload);
      if (!fin) {
        this.fragmented = true;
        this.fragmentedText = false;
      }
      return;
    }

    this.fail(1002, 'Unsupported opcode');
  }

  sendFrame(opcode, payload) {
    if (this.closed || this.closing || this.socket.destroyed) return false;
    const length = payload.length;
    let header;

    if (length < 126) {
      header = Buffer.allocUnsafe(2);
      header[1] = length;
    } else if (length < 65536) {
      header = Buffer.allocUnsafe(4);
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(length, 6);
    }

    header[0] = 0x80 | opcode;
    try {
      return this.socket.write(Buffer.concat([header, payload]));
    } catch {
      this.destroy();
      return false;
    }
  }

  sendBinary(payload) {
    return this.sendFrame(0x2, payload);
  }

  sendClose(code, reason) {
    if (this.closed || this.closeSent) return;
    const text = Buffer.from(String(reason || '').slice(0, 120), 'utf8');
    const payload = Buffer.allocUnsafe(2 + text.length);
    payload.writeUInt16BE(code, 0);
    text.copy(payload, 2);
    this.sendFrame(0x8, payload);
    this.closeSent = true;
  }

  endSoon() {
    if (this.closed || this.closing) return;
    this.closing = true;
    this.socket.end();
    setTimeout(() => this.destroy(), 1000).unref();
  }

  fail(code, reason) {
    if (this.closed || this.closing) return;
    this.sendClose(code, reason);
    this.endSoon();
  }

  pause() {
    if (!this.closed) this.socket.pause();
  }

  resume() {
    if (!this.closed) this.socket.resume();
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    this.closing = true;
    clearInterval(this.pingTimer);
    this.socket.destroy();
    if (this.onClose) this.onClose();
  }
}

class VlessSession {
  constructor(ws, req, head) {
    this.id = crypto.randomBytes(5).toString('hex');
    this.ws = ws;
    this.req = req;
    this.targetSocket = null;
    this.target = '';
    this.stage = 'header';
    this.buffer = Buffer.alloc(0);
    this.pending = null;
    this.started = Date.now();
    this.up = 0;
    this.down = 0;
    this.closed = false;
    this.cleaned = false;

    this.view = {
      id: this.id,
      client: clientIp(req),
      target: '',
      started: this.started,
      up: 0,
      down: 0,
      phase: 'handshake',
      protocol: 'vless',
    };

    state.connections.set(this.id, this.view);
    state.activeSessions.set(this.id, this);
    state.totals.sessions += 1;

    ws.onData = (chunk) => this.feed(chunk);
    ws.onClose = () => this.cleanup();
    ws.onDrain = () => {
      if (this.targetSocket && !this.targetSocket.destroyed) this.targetSocket.resume();
    };

    this.handshakeTimer = setTimeout(() => {
      if (this.stage === 'header') this.fail('VLESS handshake timed out');
    }, 15_000);
    this.handshakeTimer.unref();

    log('info', `vless session ${this.id} from ${this.view.client}`);

    if (head && head.length) ws.feed(head);
  }

  feed(chunk) {
    if (this.closed) return;
    if (this.stage === 'open') {
      this.writeTarget(chunk);
      return;
    }
    if (this.buffer.length + chunk.length > MAX_WS_FRAME) {
      this.fail('Handshake buffer too large', 1009);
      return;
    }
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    if (this.stage === 'header') this.parseHeader();
  }

  parseHeader() {
    const buffer = this.buffer;
    if (buffer.length < 18) return;

    let offset = 0;
    if (buffer[offset++] !== 0) {
      this.fail('Unsupported VLESS version', 1002);
      return;
    }

    const uuid = buffer.subarray(offset, offset + 16);
    offset += 16;
    if (!crypto.timingSafeEqual(uuid, VLESS_UUID_BYTES)) {
      state.totals.rejected += 1;
      this.fail('Authentication failed', 1008);
      return;
    }

    const addonsLength = buffer[offset++];
    if (buffer.length < offset + addonsLength + 1 + 2 + 1) return;
    offset += addonsLength;

    const command = buffer[offset++];
    const port = buffer.readUInt16BE(offset);
    offset += 2;
    const addressType = buffer[offset++];

    let host = '';
    if (addressType === 0x01) {
      if (buffer.length < offset + 4) return;
      host = Array.from(buffer.subarray(offset, offset + 4)).join('.');
      offset += 4;
    } else if (addressType === 0x02) {
      if (buffer.length < offset + 1) return;
      const length = buffer[offset++];
      if (buffer.length < offset + length) return;
      host = buffer.subarray(offset, offset + length).toString('utf8');
      offset += length;
    } else if (addressType === 0x03) {
      if (buffer.length < offset + 16) return;
      const parts = [];
      for (let index = 0; index < 16; index += 2) {
        parts.push(buffer.readUInt16BE(offset + index).toString(16));
      }
      host = parts.join(':');
      offset += 16;
    } else {
      this.fail('Unsupported address type', 1002);
      return;
    }

    if (command !== 0x01) {
      this.fail('Only TCP is supported', 1003);
      return;
    }
    if (
      !host ||
      port === 0 ||
      Buffer.byteLength(host, 'utf8') > 255 ||
      /[\u0000-\u0020\u007f/\\]/.test(host)
    ) {
      this.fail('Invalid target', 1002);
      return;
    }

    clearTimeout(this.handshakeTimer);
    this.buffer = buffer.subarray(offset);
    this.pending = this.buffer.length ? this.buffer : null;
    this.buffer = Buffer.alloc(0);
    this.target = `${host.slice(0, 255)}:${port}`;
    this.view.target = this.target;
    this.view.phase = 'connecting';
    this.stage = 'connecting';
    this.connectTarget(host, port);
  }

  connectTarget(host, port) {
    let target;
    try {
      target = net.connect({ host, port });
    } catch (error) {
      this.fail(`Target error: ${error.code || error.message}`, 1011);
      return;
    }

    this.targetSocket = target;
    target.setNoDelay(true);

    const connectTimer = setTimeout(() => {
      target.destroy();
      if (this.stage === 'connecting') this.fail('Target connection timed out', 1011);
    }, 20_000);

    target.on('error', (error) => {
      clearTimeout(connectTimer);
      if (this.stage === 'connecting') {
        this.fail(`Target error: ${error.code || error.message}`, 1011);
      } else {
        this.destroy(`target error: ${error.code || error.message}`);
      }
    });

    target.once('close', () => {
      clearTimeout(connectTimer);
      this.destroy(null);
    });

    target.once('connect', () => {
      clearTimeout(connectTimer);
      if (this.closed || this.ws.closed) {
        target.destroy();
        return;
      }

      const early = Buffer.concat([this.pending || Buffer.alloc(0), this.buffer]);
      this.pending = null;
      this.buffer = Buffer.alloc(0);
      this.stage = 'open';
      this.view.phase = 'open';
      this.ws.sendBinary(Buffer.from([0, 0]));

      target.on('data', (chunk) => {
        this.down += chunk.length;
        state.totals.down += chunk.length;
        this.view.down = this.down;
        if (!this.ws.sendBinary(chunk)) target.pause();
      });
      target.on('drain', () => this.ws.resume());
      target.on('end', () => {
        this.ws.sendClose(1000, 'Target closed');
        this.destroy(null);
      });

      if (early.length) this.writeTarget(early);
      log('info', `vless session ${this.id} open ${this.target}`);
    });
  }

  writeTarget(chunk) {
    if (!this.targetSocket || this.targetSocket.destroyed) return;
    this.up += chunk.length;
    state.totals.up += chunk.length;
    this.view.up = this.up;
    if (!this.targetSocket.write(chunk)) this.ws.pause();
  }

  fail(reason, code = 1002) {
    if (this.closed) return;
    this.view.phase = 'failed';
    log('warn', `vless session ${this.id} rejected: ${reason}`);
    clearTimeout(this.handshakeTimer);
    this.ws.sendClose(code, reason);
    this.ws.endSoon();
    this.closed = true;
    if (this.targetSocket) this.targetSocket.destroy();
    this.cleanup();
  }

  destroy(reason) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.handshakeTimer);
    if (reason) log('info', `vless session ${this.id} closed: ${reason}`);
    if (this.targetSocket) this.targetSocket.destroy();
    if (this.ws) this.ws.destroy();
    this.cleanup();
  }

  cleanup() {
    if (this.cleaned) return;
    this.cleaned = true;
    this.closed = true;
    clearTimeout(this.handshakeTimer);
    state.connections.delete(this.id);
    state.activeSessions.delete(this.id);
    if (this.targetSocket && !this.targetSocket.destroyed) this.targetSocket.destroy();
    if (this.view.phase === 'open') {
      log(
        'info',
        `vless session ${this.id} ended ${this.target} (down ${this.down} B, up ${this.up} B)`
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

function parsePublicEndpoint(value, fallbackSecure = true) {
  let raw = String(value || '').trim();
  if (!raw) return null;

  let secure = fallbackSecure;
  if (/^wss:\/\//i.test(raw) || /^https:\/\//i.test(raw)) {
    secure = true;
    raw = raw.replace(/^(wss|https):\/\//i, '');
  } else if (/^ws:\/\//i.test(raw) || /^http:\/\//i.test(raw)) {
    secure = false;
    raw = raw.replace(/^(ws|http):\/\//i, '');
  }

  raw = raw.replace(/\/+$/, '');
  const match = raw.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  if (!match) return null;

  const host = match[1].replace(/^\[|\]$/g, '');
  const port = match[2] ? Number(match[2]) : secure ? 443 : 80;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (port === 443) secure = true;
  else if (port === 80) secure = false;

  return { host, port, secure };
}

function requestTunnelEndpoint(req) {
  const configured = parsePublicEndpoint(PUBLIC_VLESS_ENDPOINT, true);
  if (configured) return configured;

  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const secure = forwardedProto ? forwardedProto === 'https' : Boolean(req.socket.encrypted);
  const forwardedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim();

  return parsePublicEndpoint(forwardedHost, secure);
}

function buildVlessLink(req) {
  const endpoint = requestTunnelEndpoint(req);
  if (!endpoint) return null;

  const linkHost = endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host;
  const params = new URLSearchParams({
    encryption: 'none',
    security: endpoint.secure ? 'tls' : 'none',
    type: 'ws',
    host: linkHost,
    path: VLESS_PATH,
  });

  if (endpoint.secure) {
    params.set('sni', linkHost);
    params.set('alpn', 'http/1.1');
  }

  return {
    link: `vless://${VLESS_UUID}@${linkHost}:${endpoint.port}?${params.toString()}#runflare-443`,
    host: endpoint.host,
    port: endpoint.port,
    secure: endpoint.secure,
    path: VLESS_PATH,
    uuid: VLESS_UUID,
  };
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

function rejectUpgrade(socket, status, message) {
  const reasons = {
    400: 'Bad Request',
    404: 'Not Found',
    503: 'Service Unavailable',
  };
  const body = `${message}\n`;
  try {
    socket.write(
      `HTTP/1.1 ${status} ${reasons[status] || 'Error'}\r\n` +
        'Connection: close\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        '\r\n' +
        body
    );
  } catch {
    /* ignore */
  }
  socket.destroy();
}

function handleUpgrade(req, socket, head) {
  socket.on('error', () => {});

  let pathname = '';
  try {
    pathname = new URL(req.url || '/', 'http://localhost').pathname;
  } catch {
    rejectUpgrade(socket, 400, 'Bad request');
    return;
  }

  if (pathname !== VLESS_PATH) {
    rejectUpgrade(socket, 404, 'Not found');
    return;
  }
  if (!state.enabled) {
    state.totals.rejected += 1;
    rejectUpgrade(socket, 503, 'Relay is paused');
    return;
  }
  if (state.connections.size >= state.maxConnections) {
    state.totals.rejected += 1;
    rejectUpgrade(socket, 503, 'Connection limit reached');
    return;
  }

  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  const version = String(req.headers['sec-websocket-version'] || '');
  const keyBytes = key ? Buffer.from(String(key), 'base64') : Buffer.alloc(0);

  if (req.method !== 'GET' || upgrade !== 'websocket' || version !== '13' || keyBytes.length !== 16) {
    rejectUpgrade(socket, 400, 'Bad WebSocket request');
    return;
  }

  const accept = crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');

  try {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        '\r\n'
    );
  } catch {
    socket.destroy();
    return;
  }

  const ws = new WebSocketConnection(socket, req);
  new VlessSession(ws, req, head);
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
      json(res, 200, {
        user: state.user,
        pass: state.pass,
        link: buildShareLink(),
        vless: buildVlessLink(req),
      });
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

adminServer.on('upgrade', handleUpgrade);

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
