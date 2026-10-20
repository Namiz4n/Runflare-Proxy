'use strict';

const $ = (id) => document.getElementById(id);

let current = null;
let firstLoad = true;
let pollTimer = null;
let refreshSeq = 0;
let stopPolling = false;
let offline = false;
let lastDown = null;
let lastSampleAt = null;
let rates = [];
let lastConnSignature = '';
let lastLogSignature = '';
let revealTimer = null;
let toastTimer = null;
let speedBusy = false;

async function api(path, options = {}) {
  const init = { credentials: 'same-origin', ...options };
  if (init.body && typeof init.body !== 'string') {
    init.headers = { ...(init.headers || {}), 'Content-Type': 'application/json' };
    init.body = JSON.stringify(init.body);
  }

  const response = await fetch(path, init);
  if (response.status === 401) {
    stopPolling = true;
    location.href = '/login';
    throw new Error('Signed out');
  }

  let data = {};
  try {
    data = await response.json();
  } catch {
    /* empty or non-JSON response */
  }

  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = value;
}

function formatBytes(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(number) / Math.log(1024)));
  const scaled = number / 1024 ** index;
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)} ${units[index]}`;
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour12: false });
}

function toast(message) {
  const element = $('toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 3600);
}

function drawSpark() {
  const line = $('spark-line');
  const width = 240;
  const height = 48;

  if (!rates.length) {
    line.setAttribute('points', '');
    return;
  }

  const max = Math.max(...rates, 1);
  const step = rates.length > 1 ? width / (rates.length - 1) : width;
  const points = rates.map((rate, index) => {
    const x = index * step;
    const y = height - 4 - (rate / max) * (height - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  if (rates.length === 1) points.unshift(`0,${height - 4}`);
  line.setAttribute('points', points.join(' '));
}

function setOffline() {
  $('top-status').textContent = 'Offline';
  $('lamp').className = 'lamp offline';
  $('hero-note').textContent = 'Cannot reach the container. Retrying every few seconds.';
  $('toggle').disabled = true;
  $('speed-run').disabled = true;
}

function render(data) {
  const first = firstLoad;
  current = data;
  firstLoad = false;

  $('hero-title').textContent = data.enabled ? 'Relay is live.' : 'Relay is paused.';
  $('hero-note').textContent = data.enabled
    ? `SOCKS5 on port ${data.listen.port}. Password required.`
    : 'The listener is on, but it rejects every connection while paused.';
  $('top-status').textContent = data.enabled ? 'Live' : 'Paused';
  $('lamp').className = `lamp ${data.enabled ? 'live' : 'paused'}`;
  $('uptime').textContent = formatDuration(data.uptimeSec);

  $('toggle').disabled = false;
  $('toggle').textContent = data.enabled ? 'Pause relay' : 'Resume relay';

  const endpoint = data.publicEndpoint ? `socks5h://${data.publicEndpoint}` : '';
  $('endpoint').textContent =
    endpoint || 'Set PUBLIC_SOCKS_ENDPOINT to show the public address';
  $('copy').disabled = !endpoint;

  $('down').textContent = formatBytes(data.traffic.down);
  $('up').textContent = formatBytes(data.traffic.up);
  $('active').textContent = String(data.active);
  $('sessions').textContent = String(data.traffic.sessions);
  $('traffic-hint').textContent = data.traffic.rejected
    ? `${data.traffic.rejected} rejected`
    : 'session totals';

  const now = Date.now();
  if (lastDown !== null && lastSampleAt !== null && now > lastSampleAt) {
    const rate = Math.max(0, data.traffic.down - lastDown) / ((now - lastSampleAt) / 1000);
    rates.push(rate);
    if (rates.length > 48) rates.shift();
    $('spark-rate').textContent = rate > 0 ? `${formatBytes(rate)}/s` : 'idle';
    drawSpark();
  }
  lastDown = data.traffic.down;
  lastSampleAt = now;

  if (first) {
    $('username').value = data.credentials.user;
    $('speed-url').value = data.speedTest.url;
  }

  const sourceLabels = {
    environment: 'from environment',
    generated: 'generated at boot',
    panel: 'set here, resets on redeploy',
  };
  $('cred-source').textContent =
    sourceLabels[data.credentials.source] || data.credentials.source;

  if (data.speedTest.running || speedBusy) {
    $('speed-run').disabled = true;
    $('speed-run').textContent = 'Running…';
  } else {
    $('speed-run').disabled = false;
    $('speed-run').textContent = 'Run test';
  }

  const connectionSignature = [
    Math.floor(now / 10000),
    data.active,
    ...data.connections.map(
      (connection) => `${connection.id}:${connection.down}:${connection.up}:${connection.phase}`
    ),
  ].join('|');

  if (connectionSignature !== lastConnSignature) {
    lastConnSignature = connectionSignature;
    const body = $('connections');
    body.replaceChildren();

    for (const connection of data.connections) {
      const row = document.createElement('tr');
      row.append(
        cell(connection.client),
        cell(connection.target || connection.phase, 'target'),
        cell(formatDuration((now - connection.started) / 1000)),
        cell(formatBytes(connection.down)),
        cell(formatBytes(connection.up)),
        killCell(connection)
      );
      body.append(row);
    }
  }

  $('conn-count').textContent = `${data.active} active`;
  $('conn-empty').hidden = data.connections.length > 0;

  const logSignature = data.log.length ? `${data.log[0].t}:${data.log.length}` : '';
  if (logSignature !== lastLogSignature) {
    lastLogSignature = logSignature;
    const list = $('log');
    list.replaceChildren();
    for (const entry of data.log) {
      const item = document.createElement('li');
      const time = document.createElement('time');
      time.textContent = formatTime(entry.t);
      const message = document.createElement('span');
      message.className = entry.level;
      message.textContent = entry.message;
      item.append(time, message);
      list.append(item);
    }
  }

  setText('version', `v${data.version}`);
}

function cell(text, className) {
  const element = document.createElement('td');
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function killCell(connection) {
  const element = document.createElement('td');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'kill';
  button.dataset.id = connection.id;
  button.textContent = '×';
  button.title = 'Close connection';
  button.setAttribute('aria-label', `Close connection to ${connection.target || 'target'}`);
  element.append(button);
  return element;
}

async function refresh() {
  clearTimeout(pollTimer);
  const sequence = ++refreshSeq;

  try {
    const data = await api('/api/status');
    if (sequence !== refreshSeq) return;
    if (offline) {
      offline = false;
      toast('Panel reconnected.');
    }
    render(data);
  } catch (error) {
    if (error.message === 'Signed out') return;
    if (sequence !== refreshSeq) return;
    if (!offline) {
      offline = true;
      setOffline();
    }
  } finally {
    if (!stopPolling && sequence === refreshSeq) {
      pollTimer = setTimeout(refresh, 2500);
    }
  }
}

$('toggle').addEventListener('click', async () => {
  if (!current) return;
  const button = $('toggle');
  button.disabled = true;
  try {
    const data = await api('/api/state', {
      method: 'POST',
      body: { enabled: !current.enabled },
    });
    render(data);
    toast(data.enabled ? 'Relay resumed.' : 'Relay paused. Active connections were closed.');
  } catch (error) {
    toast(error.message);
    button.disabled = false;
  }
});

$('copy').addEventListener('click', async () => {
  if (!current || !current.publicEndpoint) return;
  const value = `socks5h://${current.publicEndpoint}`;
  try {
    await navigator.clipboard.writeText(value);
    toast('Endpoint copied.');
  } catch {
    toast('Copy failed. Select the endpoint and copy it manually.');
  }
});

$('cred-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const user = $('username').value.trim();
  const pass = $('password').value;
  if (!user) {
    toast('Enter a username.');
    return;
  }
  if (pass && pass.length < 8) {
    toast('Use at least 8 characters for the password.');
    return;
  }

  const button = event.submitter || $('cred-form').querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  try {
    const body = { user };
    if (pass) body.pass = pass;
    const data = await api('/api/credentials', { method: 'POST', body });
    $('password').value = '';
    $('password').type = 'password';
    $('show-pass').textContent = 'Show';
    $('current-pass').hidden = true;
    $('current-pass').textContent = '';
    $('reveal').textContent = 'Reveal current password';
    clearTimeout(revealTimer);
    render(data);
    toast('Credentials saved. New connections will use them.');
  } catch (error) {
    toast(error.message);
  } finally {
    if (button) button.disabled = false;
  }
});

$('generate').addEventListener('click', () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const random = new Uint32Array(20);
  crypto.getRandomValues(random);
  let value = '';
  for (const number of random) value += alphabet[number % alphabet.length];

  const field = $('password');
  field.value = value;
  field.type = 'text';
  $('show-pass').textContent = 'Hide';
  toast('Password generated. Save credentials to apply it.');
});

$('show-pass').addEventListener('click', () => {
  const field = $('password');
  const show = field.type === 'password';
  field.type = show ? 'text' : 'password';
  $('show-pass').textContent = show ? 'Hide' : 'Show';
});

$('reveal').addEventListener('click', async () => {
  const code = $('current-pass');
  if (!code.hidden) {
    code.hidden = true;
    code.textContent = '';
    $('reveal').textContent = 'Reveal current password';
    clearTimeout(revealTimer);
    return;
  }

  try {
    const secret = await api('/api/secret');
    code.textContent = secret.pass;
    code.hidden = false;
    $('reveal').textContent = 'Hide current password';
    clearTimeout(revealTimer);
    revealTimer = setTimeout(() => {
      code.hidden = true;
      code.textContent = '';
      $('reveal').textContent = 'Reveal current password';
    }, 30000);
  } catch (error) {
    toast(error.message);
  }
});

$('speed-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = $('speed-url').value.trim();
  if (!url) {
    toast('Enter a test URL.');
    return;
  }

  speedBusy = true;
  const button = $('speed-run');
  button.disabled = true;
  button.textContent = 'Running…';
  $('speed-result').textContent = 'Downloading a sample from the container…';

  try {
    const result = await api('/api/speedtest', { method: 'POST', body: { url } });
    const suffix = result.partial ? ' (partial, timed out)' : '';
    $('speed-result').textContent = `${result.mbps.toFixed(1)} Mbps, ${formatBytes(
      result.bytes
    )} in ${result.seconds.toFixed(1)} s${suffix}`;
  } catch (error) {
    $('speed-result').textContent = error.message;
  } finally {
    speedBusy = false;
    button.disabled = false;
    button.textContent = 'Run test';
  }
});

$('connections').addEventListener('click', async (event) => {
  const button = event.target.closest('button.kill');
  if (!button) return;
  button.disabled = true;
  try {
    await api('/api/connections/kill', {
      method: 'POST',
      body: { id: button.dataset.id },
    });
    toast('Connection closed.');
    refresh();
  } catch (error) {
    toast(error.message);
    button.disabled = false;
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});

refresh();
