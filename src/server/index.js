/**
 * index.js — Express + WebSocket server untuk NetQuest.
 *
 * HTTP  : /health, /api/topology, /api/devices, /api/quests, static /public,
 *         /vendor/* (file dist xterm & vis-network dari node_modules).
 * WS    : ws://host:PORT/ws — sesi CLI interaktif (lihat ws.js).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';

import express from 'express';
import { WebSocketServer } from 'ws';

import { buildWorld, applyInitialConditions, refreshOperStatus, resetWorld, linkStatuses } from '../simulator/network.js';
import { createLabStore } from '../simulator/lab.js';
import { pcapFromCapture } from '../simulator/pcap.js';
import { CommandParser } from '../parser/parser.js';
import { QuestManager } from '../quests/quests.js';
import { initWebSocket } from './ws.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 3000);

/* ---------- load data ---------- */
const readJson = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));
const commandsJson = readJson('data/commands.json');
const devicesJson = readJson('data/devices.json');
const topologyJson = readJson('data/topology.json');
const questsJson = readJson('src/quests/definitions.json');

/* ---------- bangun dunia simulasi ---------- */
let world = buildWorld(devicesJson, topologyJson);
applyInitialConditions(world, questsJson.quests); // kerusakan quest disuntikkan di sini
for (const dev of world.devices.values()) dev.captureFactoryState(); // pabrik = kondisi quest awal
const parser = new CommandParser(commandsJson);
let quests = new QuestManager(questsJson.quests, world);
quests.verifyAll(world); // baseline (tidak ada yang selesai saat boot)

// Penyimpanan Virtual Lab Pribadi: data/labs/<clientId>.json (per browser).
const labStore = createLabStore(path.join(ROOT, 'data', 'labs'));

/** Reset total: world & quest dibangun ulang, semua klien diberi tahu. */
function handleReset(wss) {
  world = resetWorld(devicesJson, topologyJson, questsJson);
  quests = new QuestManager(questsJson.quests, world);
  appState.world = world;
  appState.quests = quests;
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    client.send(JSON.stringify({ type: 'reset' }));
    sendQuestsTo(client);
    // Klien yang sedang di lab pribadi tidak diganggu lab utamanya.
    const labW = client.labState?.active && client.labState.world ? client.labState.world : world;
    client.send(JSON.stringify({
      type: 'netstate',
      links: linkStatuses(labW),
      devices: [...labW.devices.values()].map((d) => d.toSummary()),
    }));
  }
  console.log('[NetQuest] Lab direset ke kondisi awal.');
}

let appState = { world, parser, quests, labStore, onReset: handleReset };

/* ---------- express ---------- */
const app = express();
app.use(express.json());

// File dist frontend dari node_modules -> /vendor (tanpa CDN, jalan offline).
const vendorMap = {
  '/vendor/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
  '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  '/vendor/xterm-addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
  '/vendor/vis-network.min.js': 'node_modules/vis-network/standalone/umd/vis-network.min.js',
};
for (const [route, rel] of Object.entries(vendorMap)) {
  app.get(route, (_req, res) => res.sendFile(path.join(ROOT, rel)));
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    name: 'NetQuest',
    uptimeSec: Math.floor(process.uptime()),
    devices: world.devices.size,
    quests: quests.definitions.length,
    wsPath: '/ws',
    lab: 'personal-virtual-lab',
  });
});

app.get('/api/topology', (_req, res) => {
  refreshOperStatus(world);
  res.json({
    meta: topologyJson.meta,
    nodes: topologyJson.nodes,
    links: topologyJson.links,
    devices: [...world.devices.values()].map((d) => d.toSummary()),
  });
});

app.get('/api/devices', (_req, res) => {
  res.json({ devices: [...world.devices.values()].map((d) => d.toSummary()) });
});

app.get('/api/quests', (_req, res) => {
  res.json(quests.snapshot());
});

/** Ekspor frame capture sebuah device sebagai file .pcap (buka di Wireshark). */
app.get('/api/pcap/:deviceId', (req, res) => {
  const dev = world.devices.get(req.params.deviceId);
  if (!dev) return res.status(404).json({ error: 'device not found' });
  const bytes = pcapFromCapture(dev.captureLog || []);
  res.setHeader('Content-Type', 'application/vnd.tcpdump.pcap');
  res.setHeader('Content-Disposition', `attachment; filename="${dev.hostname}.pcap"`);
  res.send(Buffer.from(bytes));
});

/** Helper kirim state ke satu klien (dipakai handleReset). */
function sendQuestsTo(client) {
  client.send(JSON.stringify({ type: 'quests', data: quests.snapshot() }));
}
function sendNetStateTo(client) {
  client.send(JSON.stringify({
    type: 'netstate',
    links: linkStatuses(world),
    devices: [...world.devices.values()].map((d) => d.toSummary()),
  }));
}

app.use(express.static(path.join(ROOT, 'public')));

/* ---------- http + websocket ---------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
initWebSocket(wss, appState);

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/ws') wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  else socket.destroy();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[NetQuest] Port ${PORT} sudah dipakai. Tutup proses lain atau jalankan: PORT=${PORT + 1} npm run dev`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log('==========================================');
  console.log('  NetQuest — Cisco CLI Educational Game');
  console.log(`  HTTP   : http://localhost:${PORT}`);
  console.log(`  WS     : ws://localhost:${PORT}/ws`);
  console.log(`  Health : http://localhost:${PORT}/health`);
  console.log(`  Devices: ${world.devices.size} | Links: ${world.links.length} | Quests: ${quests.definitions.length}`);
  console.log('==========================================');
});
