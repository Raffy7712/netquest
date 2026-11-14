/**
 * app.js — glue aplikasi: WebSocket, routing pesan, interaksi UI.
 * Alur: fetch topologi -> render vis-network -> buka WS -> klik node =
 * "SSH" ke device (attach) -> ketik perintah di xterm -> server balas output.
 *
 * Layout responsive: desktop (split view + quest overlay) & mobile (tab bar
 * bawah: Topologi / Konsol / Quest). Tab diatur lewat switchTab().
 */

import { NetTerm } from './terminal.js';
import { TopologyView } from './topology.js';
import { renderQuests, celebrateQuest } from './quest.js';
import { iconSvg, TYPE_LABEL } from './icons.js';

const $ = (id) => document.getElementById(id);

const termView = new NetTerm($('terminal'), {
  onCommand: (line) => sendInput(line),
});
const topo = new TopologyView($('network'), {
  onNodeClick: (deviceId) => attachDevice(deviceId),
});

let ws = null;
let wsReady = false;
let pendingAttach = null;

// Identitas browser utk Virtual Lab Pribadi (lab tersimpan milik sesi ini).
const CLIENT_ID = (() => {
  try {
    let id = localStorage.getItem('netquest-client-id');
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : `lab-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`);
      localStorage.setItem('netquest-client-id', id);
    }
    return id;
  } catch { return 'anon'; }
})();
let currentDeviceId = null;

/* ---------- tab switching (mobile & desktop) ---------- */

const isMobile = () => window.matchMedia('(max-width: 900px)').matches;

function switchTab(panelId) {
  for (const panel of document.querySelectorAll('.tab-panel')) {
    panel.classList.toggle('is-active', panel.id === panelId);
  }
  for (const btn of document.querySelectorAll('.tab-btn')) {
    btn.classList.toggle('active', btn.dataset.tab === panelId);
  }
  if (panelId === 'quest-panel') {
    $('quest-panel').classList.remove('collapsed');
  }
  if (panelId === 'term-panel') {
    // Re-fit xterm setelah panel terlihat lagi (panel tersembunyi berukuran 0).
    setTimeout(() => termView.refit(), 30);
    termView.focus();
  }
}

for (const btn of document.querySelectorAll('.tab-btn')) {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
}

/* ---------- websocket ---------- */

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    wsReady = true;
    setConnStatus(true);
    if (pendingAttach) {
      const id = pendingAttach;
      pendingAttach = null;
      attachDevice(id);
    }
  };

  ws.onclose = () => {
    wsReady = false;
    setConnStatus(false);
    setTimeout(connectWs, 1500); // auto-reconnect
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleWsMessage(msg);
  };
}

function sendInput(line) {
  if (!wsReady || !currentDeviceId) return;
  ws.send(JSON.stringify({ type: 'input', line }));
}

function attachDevice(deviceId) {
  currentDeviceId = deviceId;
  if (!wsReady) {
    pendingAttach = deviceId;
    return;
  }
  ws.send(JSON.stringify({ type: 'attach', deviceId, clientId: CLIENT_ID }));
  termView.clear(false);
  $('term-panel').classList.remove('fullscreen');
  // Di mobile: klik node = pindah ke tab Konsol (perilaku ala Packet Tracer).
  if (isMobile()) switchTab('term-panel');
  termView.focus();
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'attached':
      currentDeviceId = msg.deviceId;
      setDeviceHeader(msg.hostname, msg.deviceType);
      termView.writeln(msg.welcome);
      termView.writePrompt(msg.prompt);
      termView.focus();
      topo.highlight(msg.deviceId);
      break;

    case 'output': {
      if (msg.text) termView.writeln(msg.text);
      termView.writePrompt(msg.prompt);
      break;
    }

    case 'quests':
      renderQuests(msg.data);
      break;

    case 'netstate':
      topo.applyNetState(msg);
      break;

    case 'notify':
      toast(msg.text, msg.kind === 'quest-complete' ? 'ok' : 'warn');
      if (msg.kind === 'quest-complete') celebrateQuest(msg.text);
      break;

    case 'hostname-changed':
      setDeviceHeader(msg.hostname, msg.deviceType);
      break;

    case 'reset':
      toast('Lab direset ke kondisi awal.', 'ok');
      break;

    case 'lab-topology':
      if (msg.data?.active) {
        topo.build(msg.data);
        setLabBadge(true, msg.data.meta?.name);
        toast(`Virtual Lab Pribadi aktif — kanvas milikmu ("${msg.data.meta?.name ?? 'Lab'}"). Quest utama dijeda di mode ini.`, 'warn');
      } else {
        setLabBadge(false);
        topo.load();
        toast('Kembali ke lab utama — quest & XP aktif kembali.', 'ok');
      }
      break;

    case 'detached':
      currentDeviceId = null;
      setDeviceHeader('—', null);
      toast('Perangkat tidak ada di kanvas aktif. Klik node untuk attach ulang.', 'warn');
      break;

    case 'error':
      toast(msg.text, 'warn');
      break;
  }
}

/* ---------- UI kecil ---------- */

function setDeviceHeader(hostname, deviceType, role) {
  $('term-device').textContent = `— ${hostname}${role === 'server' ? ' (SERVER)' : ''}`;
  const icon = $('term-device-icon');
  if (deviceType && TYPE_LABEL[deviceType]) {
    icon.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(iconSvg(deviceType));
    icon.hidden = false;
  } else {
    icon.hidden = true;
  }
}

function setLabBadge(on, labName) {
  const el = $('lab-badge');
  if (!el) return;
  el.hidden = !on;
  el.textContent = `🧪 LAB PRIBADI${labName ? ` — ${labName}` : ''}`;
}

function setConnStatus(on) {
  const el = $('conn-status');
  el.textContent = on ? '◉ online' : '○ offline';
  el.classList.toggle('badge-on', on);
  el.classList.toggle('badge-off', !on);
}

function toast(text, kind = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'warn' ? ' warn' : '');
  el.textContent = text;
  $('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

/** Legenda ikon perangkat (SVG sama seperti node). */
function renderLegend() {
  const legend = $('legend');
  legend.innerHTML = '';
  for (const type of ['router', 'switch', 'pc']) {
    const item = document.createElement('span');
    item.className = 'legend-item';
    const img = document.createElement('img');
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(iconSvg(type));
    img.alt = TYPE_LABEL[type];
    item.appendChild(img);
    item.appendChild(document.createTextNode(TYPE_LABEL[type]));
    legend.appendChild(item);
  }
  for (const role of ['server']) {
    const item = document.createElement('span');
    item.className = 'legend-item';
    const img = document.createElement('img');
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(iconSvg('pc'));
    item.appendChild(img);
    item.appendChild(document.createTextNode('Server (dari PC: role server)'));
    legend.appendChild(item);
  }
  const up = document.createElement('span');
  up.className = 'legend-item';
  up.innerHTML = '<i class="line line-up"></i> link up';
  const down = document.createElement('span');
  down.className = 'legend-item';
  down.innerHTML = '<i class="line line-down"></i> link down';
  const cable = document.createElement('span');
  cable.className = 'legend-item';
  cable.title = 'Kabel otomatis: switch<->router/PC = straight-through; router<->router / PC<->PC / switch<->switch = crossover; serial<->serial = Serial DCE/DTE (connect <if> <device> <if>)';
  cable.innerHTML = '<i class="line line-up"></i> kabel otomatis per jenis port';
  legend.append(up, down, cable);
}

$('btn-quest-toggle').addEventListener('click', () => {
  $('quest-panel').classList.toggle('collapsed');
});
$('btn-quest-collapse').addEventListener('click', () => {
  $('quest-panel').classList.add('collapsed');
  // di mobile kembali ke tab topologi
  if (isMobile()) switchTab('topo-panel');
});
$('btn-term-clear').addEventListener('click', () => termView.clear(true));
$('btn-pcap').addEventListener('click', () => {
  if (!currentDeviceId) {
    toast('Pilih perangkat dulu — capture diambil dari ping/traceroute.', 'warn');
    return;
  }
  window.open(`/api/pcap/${currentDeviceId}`, '_blank');
});
$('btn-term-fullscreen').addEventListener('click', () => {
  $('term-panel').classList.toggle('fullscreen');
  setTimeout(() => termView.focus(), 50);
});

// Saat quest selesai (event dari quest.js): desktop = buka overlay, mobile = pindah tab.
window.addEventListener('netquest:open-quest', () => {
  if (isMobile()) switchTab('quest-panel');
  else $('quest-panel').classList.remove('collapsed');
});

// Tombol cepat (touch): sisipkan teks / kirim control char.
for (const btn of document.querySelectorAll('#quickkeys button')) {
  btn.addEventListener('click', () => {
    if (btn.dataset.insert !== undefined) termView.insert(btn.dataset.insert);
    else if (btn.dataset.ctrl) termView.sendCtrl(btn.dataset.ctrl);
  });
}

// Reset lab: minta server membangun ulang world + quest.
$('btn-reset').addEventListener('click', () => {
  if (!wsReady) return toast('Belum tersambung ke server.', 'warn');
  ws.send(JSON.stringify({ type: 'reset' }));
});

/* ---------- bootstrap ---------- */

(async function main() {
  renderLegend();
  try {
    await topo.load();
  } catch (e) {
    toast('Gagal memuat topologi: ' + e.message, 'warn');
  }
  connectWs();
  // Klik PC-1 sebagai device awal agar terminal langsung hidup.
  attachDevice('pc1');
})();
