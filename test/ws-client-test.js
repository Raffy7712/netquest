/**
 * ws-client-test.js — uji end-to-end jalur WebSocket seperti browser nyata:
 * attach device, kirim perintah, cek output & quest broadcast.
 * Jalankan dari root proyek: node test/ws-client-test.js (server harus jalan).
 */

import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:3000/ws');
const messages = [];
let step = -1;
let fail = false;

// Langkah: {send, expect?: regex pada output, type?: 'attached'|'output'}
const script = [
  { send: { type: 'attach', deviceId: 'pc1', clientId: 'ws-tester' }, type: 'attached', label: 'attach PC-1' },
  { send: { type: 'input', line: 'ping 10.0.0.2' }, expect: /UUUUU/, label: 'ping gagal saat awal' },
  { send: { type: 'attach', deviceId: 'r1' }, type: 'attached', label: 'attach R1' },
  { send: { type: 'input', line: 'enable' }, expect: /.*/, label: 'enable R1' },
  { send: { type: 'input', line: 'conf t' }, expect: /Enter configuration/, label: 'conf t' },
  { send: { type: 'input', line: 'int g0/1' }, expect: /.*/, label: 'int g0/1' },
  { send: { type: 'input', line: 'no shut' }, expect: /LINK-5-CHANGED/, label: 'no shut -> syslog' },
  { send: { type: 'input', line: 'end' }, expect: /.*/, label: 'end' },
  { send: { type: 'attach', deviceId: 'r2' }, type: 'attached', label: 'attach R2' },
  { send: { type: 'input', line: 'enable' }, expect: /.*/, label: 'enable R2' },
  { send: { type: 'input', line: 'conf t' }, expect: /.*/, label: 'conf t R2' },
  { send: { type: 'input', line: 'ip route 192.168.1.0 255.255.255.0 10.0.0.1' }, expect: /.*/, label: 'rute balik R2' },
  { send: { type: 'input', line: 'end' }, expect: /.*/, label: 'end R2' },
  { send: { type: 'attach', deviceId: 'pc1' }, type: 'attached', label: 'attach ulang PC-1' },
  { send: { type: 'input', line: 'ping 10.0.0.2' }, expect: /!!!!!/, label: 'ping sukses setelah perbaikan' },
  { send: { type: 'input', line: 'sh ip routex' }, expect: /Invalid input detected/, label: 'caret invalid via WS' },
  // Virtual Lab Pribadi via WS
  { send: { type: 'input', line: 'lab start' }, expect: /Mode lab pribadi aktif/, label: 'lab start via WS' },
  { send: { type: 'input', line: 'lab add router R5' }, expect: /ditambahkan/, label: 'lab add router via WS' },
  { send: { type: 'input', line: 'lab status' }, expect: /Perangkat: 7/, label: 'lab status 7 perangkat' },
  { send: { type: 'input', line: 'lab exit' }, expect: /Kembali ke lab utama/, label: 'lab exit via WS' },
];

const timeout = setTimeout(() => {
  console.error(`TIMEOUT di langkah ${step}: ${script[step]?.label}`);
  process.exit(1);
}, 8000);

function advance() {
  step++;
  if (step >= script.length) {
    const quests = messages.filter((m) => m.type === 'quests').pop();
    const q1 = quests?.data?.quests?.find((q) => q.id === 'quest-1');
    console.log(`  ${q1?.completed ? 'PASS' : 'FAIL'}  quest-1 tercatat selesai via WS (xp=${quests?.data?.xp})`);
    if (!q1?.completed) fail = true;
    const labTopos = messages.filter((m) => m.type === 'lab-topology');
    const active = labTopos.find((m) => m.data?.active && m.data?.devices?.length === 7);
    console.log(`  ${active ? 'PASS' : 'FAIL'}  lab-topology dikirim via WS (aktif, 7 perangkat; ${labTopos.length} pesan)`);
    if (!active) fail = true;
    clearTimeout(timeout);
    ws.close();
    console.log(fail ? 'SELESAI DENGAN GAGAL' : 'Semua langkah WS PASS.');
    process.exit(fail ? 1 : 0);
    return;
  }
  const s = script[step];
  // langkah tanpa 'expect' (attach) dinilai dari pesan 'attached'
  ws.send(JSON.stringify(s.send));
}

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  messages.push(msg);
  const s = script[step];
  if (!s) return;

  if (s.type === 'attached') {
    if (msg.type === 'attached') {
      console.log(`  PASS  ${s.label} (${msg.hostname})`);
      advance();
    }
    return;
  }

  if (s.expect && msg.type === 'output') {
    const hay = [msg.text || '', msg.prompt || ''].join('\n');
    if (s.expect.test(hay)) {
      console.log(`  PASS  ${s.label}`);
      advance();
    }
  }
});

ws.on('open', advance);
ws.on('error', (e) => {
  console.error('WS ERROR', e.message);
  process.exit(1);
});
