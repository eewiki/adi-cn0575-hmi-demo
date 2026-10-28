#!/usr/bin/env node
/*
 * sensor-plot.js: live-plot a TCP sensor stream in the browser.
 * Developed with assistance from Claude (Anthropic)
 *
 *   node sensor-plot.js <sensor-ip> <sensor-port>
 *   (or set SENSOR_HOST / SENSOR_PORT; PORT sets the web port, default 8080)
 *
 * Then open http://localhost:8080 on the Pi. The server does not connect to
 * the sensor until you tap Connect in the browser.
 *
 * Zero npm dependencies. Chart.js is loaded from a CDN by default; to work
 * offline, run `npm install chart.js` once in this folder and it will be
 * served locally instead.
 *
 * Accepts either CSV lines ("1.2, 3.4") or JSON lines ('{"a":1.2,"b":3.4}').
 * Any number of values per line works; each becomes its own series.
 */

const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ------------------------------------------------- settings you may edit

// The messages sent to the sensor (over the same socket) when the user
// changes the corresponding setting. EDIT THIS to match your device's protocol.
const intervalCommand = (seconds) => 'INTERVAL ' + seconds + '\n';
const filterCommand = (enabled) => 'FILTER ' + (enabled ? '1' : '0') + '\n'; 

const INTERVAL_MIN_S = 1;
const INTERVAL_MAX_S = 5;

// ---------------------------------------------------------------------

const SENSOR_HOST = process.argv[2] || process.env.SENSOR_HOST;
const SENSOR_PORT = Number(process.argv[3] || process.env.SENSOR_PORT);
const WEB_PORT = Number(process.env.PORT || 8080);
const MAX_WINDOW_MS = 10 * 60 * 1000; // longest time axis the UI offers

if (!SENSOR_HOST || !SENSOR_PORT) {
  console.error('Usage: node sensor-plot.js <sensor-ip> <sensor-port>');
  process.exit(1);
}

// ---------------------------------------------------------------- data side

let history = []; // [{ t: epoch ms, v: [numbers] }]
let sensorStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'connected'
let sensorSock = null; // the live, connected socket (null otherwise)
let currentSock = null; // the socket we are connecting or connected with
let wantConnected = false; // set by the Connect/Disconnect button
let retryTimer = null;
let intervalSeconds = INTERVAL_MIN_S; // what the UI shows until changed
let intervalTouched = false; // true once the user has set it
let filterEnabled = false;
let filterTouched = false; // true one the user has toggled it
const clients = new Set();

function send(res, event, data) {
  res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
}
function broadcast(event, data) {
  for (const res of clients) send(res, event, data);
}
function setStatus(s) {
  sensorStatus = s;
  broadcast('status', s);
  console.log('sensor ' + s);
}

function writeInterval(seconds) {
  sensorSock.write(intervalCommand(seconds));
  console.log('sent interval command: ' + seconds + ' s');
}

function parseLine(line) {
  line = line.trim();
  if (!line) return null;
  let values;
  if (line[0] === '{' || line[0] === '[') {
    try {
      const j = JSON.parse(line);
      values = Object.values(j).map(Number);
    } catch { return null; }
  } else {
    values = line.split(',').map((s) => Number(s.trim()));
  }
  return values.length && values.every(Number.isFinite) ? values : null;
}

function writeFilter(enabled) {
  sensorSock.write(filterCommand(enabled));
  console.log('sent filter command: ' + (enabled ? 'on' : 'off'));
}

function handleLine(line) {
  const v = parseLine(line);
  if (!v) return;
  const point = { t: Date.now(), v };
  history.push(point);
  const cutoff = point.t - MAX_WINDOW_MS - 5000;
  while (history.length && history[0].t < cutoff) history.shift();
  broadcast('point', point);
}

function connectToSensor() {
  retryTimer = null;
  const sock = net.connect(SENSOR_PORT, SENSOR_HOST);
  currentSock = sock;
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('connect', () => {
    sensorSock = sock;
    // If the sensor restarted, re-apply the user's previous settings.
    if (intervalTouched) writeInterval(intervalSeconds);
    if (filterTouched) writeFilter(filterEnabled);
    setStatus('connected');
  });
  sock.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      handleLine(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  sock.on('error', () => {}); // 'close' follows and handles the retry
  sock.on('close', () => {
    if (sensorSock === sock) sensorSock = null;
    if (currentSock !== sock) return; // stale socket from an earlier attempt
    currentSock = null;
    if (!wantConnected) return;
    if (sensorStatus !== 'connecting') setStatus('connecting');
    retryTimer = setTimeout(connectToSensor, 2000);
  });
}

function startConnection() {
  if (wantConnected) return;
  wantConnected = true;
  setStatus('connecting');
  connectToSensor();
}

function stopConnection() {
  wantConnected = false;
  clearTimeout(retryTimer);
  retryTimer = null;
  const sock = currentSock;
  currentSock = null;
  sensorSock = null;
  if (sock) sock.destroy();
  setStatus('disconnected');
}

// ---------------------------------------------------------------- web side

const CHART_CDN = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js';
const LOCAL_CHART = path.join(__dirname, 'node_modules/chart.js/dist/chart.umd.js');

function handleIntervalPost(req, res) {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let s;
    try { s = Number(JSON.parse(body).seconds); } catch { /* invalid */ }
    if (!Number.isInteger(s) || s < INTERVAL_MIN_S || s > INTERVAL_MAX_S) {
      res.writeHead(400);
      return res.end();
    }
    if (!sensorSock) {
      res.writeHead(503);
      return res.end();
    }
    intervalSeconds = s;
    intervalTouched = true;
    writeInterval(s);
    broadcast('interval', s);
    res.writeHead(204);
    res.end();
  });
}

function handleConnectionPost(req, res) {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let want;
    try { want = JSON.parse(body).connect; } catch { /* invalid */ }
    if (typeof want !== 'boolean') {
      res.writeHead(400);
      return res.end();
    }
    if (want) startConnection(); else stopConnection();
    res.writeHead(204);
    res.end();
  });
}

function handleFilterPost(req, res) {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let on;
    try { on = JSON.parse(body).enabled; } catch { /* invalid */ }
    if (typeof on !== 'boolean') { res.writeHead(400); return res.end(); }
    if (!sensorSock) { res.writeHead(503); return res.end(); }
    filterEnabled = on;
    filterTouched = true;
    writeFilter(on);
    broadcast('filter', on);
    res.writeHead(204);
    res.end();
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    send(res, 'status', sensorStatus);
    send(res, 'interval', intervalSeconds);
    send(res, 'filter', filterEnabled);
    send(res, 'history', history);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  } else if (req.method === 'POST' && req.url === '/connection') {
    handleConnectionPost(req, res);
  } else if (req.method === 'POST' && req.url === '/filter') {
    handleFilterPost(req, res);
  } else if (req.method === 'POST' && req.url === '/interval') {
    handleIntervalPost(req, res);
  } else if (req.url === '/chart.js') {
    if (fs.existsSync(LOCAL_CHART)) {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      fs.createReadStream(LOCAL_CHART).pipe(res);
    } else {
      res.writeHead(302, { Location: CHART_CDN });
      res.end();
    }
  } else if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(WEB_PORT, () => {
  console.log('Open http://localhost:' + WEB_PORT);
  console.log('Waiting for Connect from the browser (sensor: ' + SENSOR_HOST + ':' + SENSOR_PORT + ')');
});

// --------------------------------------------------------------- the page
// NOTE: client code below avoids backticks and ${} so it can live in this
// template literal.

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>System Monitor</title>
<style>
  :root {
    --bg: #0e1a24;
    --panel: #142430;
    --key: #1f3546;
    --key-active: #2a4a61;
    --grid: rgba(215, 227, 234, 0.07);
    --text: #d7e3ea;
    --muted: #7f95a3;
    --ok: #5ad1c4;
    --wait: #ffb454;
  }
  html, body, * { cursor: none !important; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: "Inter", "Segoe UI", system-ui, -apple-system, sans-serif;
    display: flex;
    flex-direction: column;
    padding: clamp(12px, 2.5vw, 28px);
    gap: 14px;
    -webkit-user-select: none;
    user-select: none;
  }
  header { display: flex; align-items: center; justify-content: space-between; gap: 24px; }
  
  .stack { display: flex; flex-direction: column; gap: 12px; }
  h1 { font-size: 1.7rem; font-weight: 600; margin: 0; letter-spacing: 0.01em; }
  .status { display: flex; align-items: center; gap: 8px; font-size: 0.85rem; color: var(--muted); }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--wait); transition: background 0.3s; }
  .dot.ok { background: var(--ok); box-shadow: 0 0 0 4px rgba(90, 209, 196, 0.18); }

  .conn { display: flex; align-items: center; gap: 16px; flex: none; }
  .connbtn { min-width: 132px; min-height: 46px; font-size: 1.05rem; font-weight: 600; padding: 0 18px; }
  .connbtn.primary { background: var(--ok); color: #0e1a24; }
  .connbtn.primary:active:not(:disabled) { background: #7fe0d5; }

  #readouts { display: flex; gap: clamp(24px, 6vw, 72px); flex-wrap: wrap; }
  .readout .label { font-size: 0.85rem; color: var(--muted); }
  .readout .value {
    font-size: clamp(1.8rem, 4vw, 3rem);
    font-weight: 300;
    font-variant-numeric: tabular-nums;
    line-height: 1.1;
    width: 9ch;
    white-space: nowrap;
  }
  .readout .unit { font-size: 0.5em; margin-left: 0.25em; opacity: 0.75; }
  
  .info { display: flex; flex-wrap: nowrap; justify-content: space-between; align-items: flex-end; gap: 12px; }

  .controls { display: flex; flex-wrap: nowrap; gap: 12px; flex: 1 }
  .control {
    background: var(--panel);
    border-radius: 14px;
    padding: 10px 14px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex: 1;
  }
  .control .name { font-size: 1rem; color: var(--muted); }
  .control .name b { color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; }
  
  #slider { flex: 1.75 }

  button {
    font: inherit;
    color: var(--text);
    background: var(--key);
    border: 0;
    border-radius: 10px;
    min-height: 48px;
    touch-action: manipulation;
    cursor: pointer;
  }
  button:active:not(:disabled) { background: var(--key-active); }
  button:disabled { opacity: 0.3; cursor: default; }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--ok); outline-offset: 2px; }

  .stepper { display: flex; align-items: center; gap: 12px; }
  .stepper button { width: 46px; font-size: 1.8rem; line-height: 1; }
  .stepper .num {
    flex: 1; text-align: center; font-size: 1.3rem;
    font-variant-numeric: tabular-nums;
  }

  .switch { position: relative; width: 92px; border-radius: 26px; transition: background 0.2s; }
  .switch .knob {
    position: absolute; top: 50%; left: 6px; margin-top: -20px;
    width: 40px; height: 40px; border-radius: 50%;
    background: var(--text); transition: transform 0.2s;
  }
  .switch[aria-checked="true"] { background: var(--ok); }
  .switch[aria-checked="true"] .knob { transform: translateX(40px); background: #0e1a24; }

  .seg { display: flex; gap: 8px; }
  .seg button { flex: 1; font-size: 1.15rem; }
  .seg button[aria-pressed="true"] { background: var(--ok); color: #0e1a24; font-weight: 600; }

  input[type=range] {
    -webkit-appearance: none; appearance: none;
    width: 100%; height: 52px; margin: 0; background: transparent;
    touch-action: pan-y;
  }
  input[type=range]::-webkit-slider-runnable-track { height: 8px; border-radius: 4px; background: var(--key); }
  input[type=range]::-moz-range-track { height: 8px; border-radius: 4px; background: var(--key); }
  input[type=range]::-webkit-slider-thumb {
    -webkit-appearance: none; width: 28px; height: 28px; margin-top: -10px;
    border-radius: 50%; background: var(--ok); border: 0;
  }
  input[type=range]::-moz-range-thumb {
    width: 28px; height: 28px; border-radius: 50%; background: var(--ok); border: 0;
  }

  .plot {
    flex: 1;
    min-height: 200px;
    background: var(--panel);
    border-radius: 14px;
    padding: 18px 18px 10px;
    position: relative;
  }
  .plot canvas { position: absolute; inset: 18px 18px 10px; }
  .empty {
    position: absolute; inset: 0; display: grid; place-items: center;
    color: var(--muted); font-size: 0.95rem; pointer-events: none;
  }

  @media (max-height: 560px) {
    body { gap: 10px; }
    .control { padding: 8px 12px 10px; gap: 6px; }
    button { min-height: 46px; }
    input[type=range] { height: 46px; }
  }
</style>
</head>
<body>
  <header>
    <h1>System<br>Monitor</h1>
    <div class="controls">
      <div class="control">
        <div class="name">Sample every</div>
        <div class="stepper">
          <button id="minus" aria-label="Sample faster">−</button>
          <div class="num" id="interval">1 s</div>
          <button id="plus" aria-label="Sample slower">+</button>
        </div>
      </div>
      <div class="control" id="slider">
        <div class="name">Time axis: <b id="windowLabel">5 min</b></div>
        <input type="range" id="window" min="1" max="10" step="1" value="5" aria-label="Time axis length in minutes">
      </div>
      <div class="control">
        <div class="name">Units</div>
        <div class="seg">
          <button id="unitC" aria-pressed="true">°C</button>
          <button id="unitF" aria-pressed="false">°F</button>
        </div>
      </div>
      <div class="control control-fitler">
        <div class="name">Oversampling: <b id="filterLabel">Off</b></div>
	<button id="filter" class="switch" role="switch" aria-checked="false" aria-label="Digital filter" disabled>
	  <span class="knob"></span>
	</button>
      </div>
    </div>
  </header>

  <div class="info">
    <div id="readouts"></div>
    <div class="conn">
      <div class="status"><span class="dot" id="dot"></span><span id="status">Loading…</span></div>
      <button id="conn" class="connbtn primary" disabled>Connect</button>
    </div>
  </div>

  <div class="plot">
    <div class="empty" id="empty">Not connected. Tap Connect to start.</div>
    <canvas id="chart"></canvas>
  </div>

<script src="/chart.js"></script>
<script>
// ---- settings you may want to change ---------------------------------
var LABELS = ['Thermocouple', 'Cold Junction'];        // names for each series
var TEMP_SERIES = [0, 1];                      // indexes of series that are temperatures (sent as °C)
var COLORS = ['#ffb454', '#5ad1c4', '#c792ea', '#ff7a90'];
var SEPARATE_AXES = false;                  // true = one y-axis per series
var INTERVAL_MIN = 1, INTERVAL_MAX = 5;     // must match the server settings
// -----------------------------------------------------------------------

var MAX_WINDOW_S = 600;
var MUTED = '#7f95a3', GRID = 'rgba(215,227,234,0.07)';
var chart = null, pts = [], lastPoint = null, frozenAt = null;
var $ = function (id) { return document.getElementById(id); };

function load(k, d) {
  try { var v = localStorage.getItem('sp_' + k); return v === null ? d : JSON.parse(v); }
  catch (e) { return d; }
}
function save(k, v) { try { localStorage.setItem('sp_' + k, JSON.stringify(v)); } catch (e) {} }

var unit = load('unit', 'C') === 'F' ? 'F' : 'C';
var windowS = Math.min(600, Math.max(60, Number(load('window', 300)) || 300));
var intervalS = INTERVAL_MIN, sensorUp = false, filterOn = false;

Chart.defaults.color = MUTED;
Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;

function isTemp(i) { return TEMP_SERIES.indexOf(i) >= 0; }
function conv(v, i) { return isTemp(i) && unit === 'F' ? v * 9 / 5 + 32 : v; }
function suffix(i) { return isTemp(i) ? '\u00b0' + unit : ''; }

function tickStep(w) { return w <= 60 ? 10 : w <= 180 ? 30 : 60; }
function tickLabel(v) {
  if (v === 0) return 'now';
  var a = Math.abs(v);
  if (a < 60) return '\u2212' + a + ' s';
  if (a % 60 === 0) return '\u2212' + a / 60 + ' min';
  return '\u2212' + Math.floor(a / 60) + ':' + ('0' + (a % 60)).slice(-2);
}

function fillGradient(color) {
  return function (c) {
    var a = c.chart.chartArea;
    if (!a) return 'transparent';
    var g = c.chart.ctx.createLinearGradient(0, a.top, 0, a.bottom);
    g.addColorStop(0, color + '38');
    g.addColorStop(1, color + '00');
    return g;
  };
}

function buildReadouts(n) {
  var html = '';
  for (var i = 0; i < n; i++) {
    var color = COLORS[i % COLORS.length];
    var label = LABELS[i] || ('Value ' + (i + 1));
    html += '<div class="readout"><div class="label">' + label + '</div>' +
            '<div class="value" style="color:' + color + '">' +
            '<span id="r' + i + '">--.--</span><span class="unit" id="u' + i + '"></span></div></div>';
  }
  $('readouts').innerHTML = html;
}

function build(n) {
  $('empty').style.display = 'none';

  var scales = {
    x: {
      type: 'linear', min: -windowS, max: 0,
      grid: { color: GRID }, border: { display: false },
      ticks: { stepSize: tickStep(windowS), maxRotation: 0, callback: tickLabel }
    }
  };
  var datasets = [];
  for (var i = 0; i < n; i++) {
    var color = COLORS[i % COLORS.length];
    var label = LABELS[i] || ('Value ' + (i + 1));
    var axis = SEPARATE_AXES ? 'y' + i : 'y';
    if (!scales[axis]) {
      scales[axis] = {
        position: i % 2 ? 'right' : 'left', grace: '10%',
        grid: { color: GRID, drawOnChartArea: i === 0 || !SEPARATE_AXES },
        border: { display: false },
        ticks: { color: SEPARATE_AXES ? color : MUTED, padding: 8 }
      };
    }
    datasets.push({
      label: label, data: [], yAxisID: axis,
      borderColor: color, backgroundColor: fillGradient(color),
      fill: 'start', borderWidth: 2.5, tension: 0.35, pointRadius: 0, pointHoverRadius: 5
    });
  }
  if (document.querySelectorAll('.readout').length !== n) buildReadouts(n);

  chart = new Chart($('chart'), {
    type: 'line',
    data: { datasets: datasets },
    options: {
      parsing: false, animation: false, responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      scales: scales,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0e1a24', borderColor: GRID, borderWidth: 1, padding: 10,
          callbacks: {
            title: function (items) { return Math.abs(Math.round(items[0].parsed.x)) + ' s ago'; },
            label: function (item) {
              return item.dataset.label + ': ' + item.parsed.y.toFixed(2) + ' ' + suffix(item.datasetIndex);
            }
          }
        }
      }
    }
  });
  renderReadouts();
}

function renderReadouts() {
  if (!lastPoint) return;
  for (var i = 0; i < lastPoint.v.length; i++) {
    var r = $('r' + i), u = $('u' + i);
    if (r) r.textContent = conv(lastPoint.v[i], i).toFixed(2);
    if (u) u.textContent = suffix(i);
  }
}

// Re-map timestamps to "seconds ago" so the plot scrolls smoothly,
// even between readings.
function refresh() {
  if (!chart) return;
  var now = frozenAt === null ? Date.now() : frozenAt;
  pts = pts.filter(function (p) { return now - p.t <= (MAX_WINDOW_S + 5) * 1000; });
  chart.data.datasets.forEach(function (d, i) {
    d.data = pts.map(function (p) { return { x: (p.t - now) / 1000, y: conv(p.v[i], i) }; });
  });
  chart.update('none');
}
setInterval(refresh, 100);

// ---- controls ---------------------------------------------------------

function renderInterval() {
  $('interval').textContent = intervalS + ' s';
  $('minus').disabled = !sensorUp || intervalS <= INTERVAL_MIN;
  $('plus').disabled = !sensorUp || intervalS >= INTERVAL_MAX;
}
function requestInterval(s) {
  fetch('/interval', { method: 'POST', body: JSON.stringify({ seconds: s }) }).catch(function () {});
}
$('minus').onclick = function () { requestInterval(Math.max(INTERVAL_MIN, intervalS - 1)); };
$('plus').onclick = function () { requestInterval(Math.min(INTERVAL_MAX, intervalS + 1)); };

function renderFilter() {
  $('filter').setAttribute('aria-checked', filterOn);
  $('filterLabel').textContent = filterOn ? 'On' : 'Off';
  $('filter').disabled = !sensorUp;
}
$('filter').onclick = function () {
  fetch('/filter', { method: 'POST', body: JSON.stringify({ enabled: !filterOn }) })
    .catch(function () {});
};

function applyWindow() {
  $('window').value = windowS / 60;
  $('windowLabel').textContent = windowS / 60 + ' min';
  if (chart) {
    var x = chart.options.scales.x;
    x.min = -windowS;
    x.ticks.stepSize = tickStep(windowS);
    refresh();
  }
}
$('window').oninput = function () {
  windowS = Number(this.value) * 60;
  save('window', windowS);
  applyWindow();
};

function applyUnit() {
  $('unitC').setAttribute('aria-pressed', unit === 'C');
  $('unitF').setAttribute('aria-pressed', unit === 'F');
  renderReadouts();
  refresh();
}
$('unitC').onclick = function () { unit = 'C'; save('unit', unit); applyUnit(); };
$('unitF').onclick = function () { unit = 'F'; save('unit', unit); applyUnit(); };

applyWindow();
applyUnit();
buildReadouts(LABELS.length);
renderInterval();
renderFilter();

// ---- live data --------------------------------------------------------

var connState = 'disconnected';
var CONN_TEXT = { connected: 'Connected', connecting: 'Connecting\u2026', disconnected: 'Disconnected' };
var CONN_BUTTON = { connected: 'Disconnect', connecting: 'Cancel', disconnected: 'Connect' };
var EMPTY_TEXT = { connected: 'Waiting for the first reading\u2026', connecting: 'Connecting to sensor\u2026', disconnected: 'Not connected. Tap Connect to start.' };

function setConn(s) {
  connState = s;
  if (s === 'disconnected') { if (frozenAt === null) frozenAt = Date.now(); }
  else frozenAt = null;
  sensorUp = s === 'connected';
  $('dot').className = 'dot' + (sensorUp ? ' ok' : '');
  $('status').textContent = CONN_TEXT[s];
  $('empty').textContent = EMPTY_TEXT[s];
  var b = $('conn');
  b.textContent = CONN_BUTTON[s];
  b.className = 'connbtn' + (s === 'disconnected' ? ' primary' : '');
  b.disabled = false;
  renderInterval();
  renderFilter();
}
function serverLost() {
  sensorUp = false;
  $('dot').className = 'dot';
  $('status').textContent = 'Lost connection to the Pi server';
  $('conn').disabled = true;
  renderInterval();
  renderFilter();
}
$('conn').onclick = function () {
  this.disabled = true; // re-enabled when the server reports the new state
  fetch('/connection', { method: 'POST', body: JSON.stringify({ connect: connState === 'disconnected' }) })
    .catch(serverLost);
};

var es = new EventSource('/events');
es.addEventListener('status', function (e) {
  setConn(JSON.parse(e.data));
});
es.addEventListener('interval', function (e) {
  intervalS = JSON.parse(e.data);
  renderInterval();
});
es.addEventListener('filter', function (e) {
  filterOn = JSON.parse(e.data);
  renderFilter();
});
es.addEventListener('history', function (e) {
  pts = JSON.parse(e.data);
  if (pts.length) {
    lastPoint = pts[pts.length - 1];
    if (!chart) build(lastPoint.v.length);
    renderReadouts();
  }
});
es.addEventListener('point', function (e) {
  var p = JSON.parse(e.data);
  lastPoint = p;
  if (!chart) build(p.v.length);
  pts.push(p);
  renderReadouts();
});
es.onerror = serverLost;
</script>
</body>
</html>`;
