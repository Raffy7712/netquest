/**
 * smoke.js — pengujian end-to-end backend tanpa browser:
 * parser, mode, caret invalid input, show dinamis, ping, dan quest.
 * Jalankan: npm test
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

import { cableTypeBetween } from '../src/simulator/network.js';
import { buildWorld, applyInitialConditions, resetWorld } from '../src/simulator/network.js';
import { CommandParser } from '../src/parser/parser.js';
import { QuestManager } from '../src/quests/quests.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const readJson = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));

const world = buildWorld(readJson('data/devices.json'), readJson('data/topology.json'));
applyInitialConditions(world, readJson('src/quests/definitions.json').quests);
// Sama seperti server: kondisi pabrik = kondisi SETELAH injeksi quest awal.
for (const dev of world.devices.values()) dev.captureFactoryState();
const parser = new CommandParser(readJson('data/commands.json'));
const quests = new QuestManager(readJson('src/quests/definitions.json').quests, world);

const r1 = world.devices.get('r1');
const r2 = world.devices.get('r2');
const pc1 = world.devices.get('pc1');
const pc2 = world.devices.get('pc2');

let passed = 0;
function run(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${label}`);
  } catch (e) {
    console.error(`  FAIL  ${label}\n        ${e.message}`);
    console.error('STACK:', e.name, e.stack ? e.stack.split('\n').slice(0, 6).join(' | ') : '(no stack)');
    process.exitCode = 1;
  }
}

function exec(dev, line) {
  return parser.execute(dev, line, world);
}
function out(dev, line) {
  const r = parser.execute(dev, line, world);
  return r.output;
}

console.log('\n== 1. Navigasi mode ==');
run('user prompt', () => assert.equal(r1.prompt, 'R1> '));
run('enable -> privileged', () => {
  exec(r1, 'enable');
  assert.equal(r1.currentMode, 'privileged');
  assert.equal(r1.prompt, 'R1# ');
});
run('conf t -> global config + output IOS', () => {
  const r = exec(r1, 'conf t');
  assert.equal(r1.currentMode, 'global-config');
  assert.match(r.output, /Enter configuration commands/);
});
run('interface alias g0/0', () => {
  exec(r1, 'int g0/0');
  assert.equal(r1.currentMode, 'interface-config');
  assert.equal(r1.currentInterface, 'GigabitEthernet0/0');
});
run('end -> privileged', () => {
  exec(r1, 'end');
  assert.equal(r1.currentMode, 'privileged');
});
run('disable -> user', () => {
  exec(r1, 'disable');
  assert.equal(r1.currentMode, 'user');
});

console.log('\n== 2. Invalid input & caret ==');
run('token salah -> caret di posisi token', () => {
  exec(r1, 'enable');
  const r = exec(r1, 'sh ip routex');
  assert.match(r.output, /% Invalid input detected at '\^' marker/);
  assert.match(r.output, /^\s{11}\^/m); // "sh ip route" = 11 char, caret di 'x'
});
run('perintah exec di config mode -> caret kolom 0', () => {
  exec(r1, 'conf t');
  const r = exec(r1, 'show ip route');
  assert.match(r.output, /^\^\n% Invalid input/m);
});
run('octet 999 -> caret menunjuk argumen', () => {
  exec(r1, 'int g0/0');
  const r = exec(r1, 'ip address 999.1.1.1 255.255.255.0');
  assert.match(r.output, /^\s{11}\^\n% Invalid input/m); // kolom mulai "999"
});
run('hostname 1buruk ditolak', () => {
  exec(r1, 'end');
  exec(r1, 'conf t');
  const r = exec(r1, 'hostname 1buruk');
  assert.match(r.output, /Invalid hostname/);
  exec(r1, 'end');
});

console.log('\n== 3. State quest awal diterapkan ==');
run('R1 Gi0/1 shutdown oleh quest-1', () => {
  assert.equal(r1.interfaces['GigabitEthernet0/1'].adminUp, false);
});
run('R2 Gi0/1 salah IP oleh quest-3', () => {
  assert.equal(r2.interfaces['GigabitEthernet0/1'].ip, '192.168.3.1');
});

console.log('\n== 4. show dinamis ==');
run('show ip interface brief: kolom & status', () => {
  exec(r1, 'enable');
  const o = out(r1, 'sh ip int br');
  assert.match(o, /GigabitEthernet0\/0\s+192\.168\.1\.1\s+YES\s+manual\s+up\s+up/);
  assert.match(o, /GigabitEthernet0\/1\s+10\.0\.0\.1\s+YES\s+manual\s+administratively down/);
});
run('show ip route: C/L saja sebelum konfigurasi', () => {
  const o = out(r1, 'show ip route');
  assert.match(o, /C\s+192\.168\.1\.0\/24 is directly connected/);
  assert.doesNotMatch(o, /S\s+192\.168\.2\.0/);
});
run('show running-config memuat hostname & shutdown', () => {
  const o = out(r1, 'show run');
  assert.match(o, /hostname R1/);
  assert.match(o, /interface GigabitEthernet0\/1[\s\S]*?\n shutdown/);
});
run('show version memuat hostname & uptime', () => {
  const o = out(r1, 'show version');
  assert.match(o, /R1 uptime is/);
  assert.match(o, /CISCO2911/);
});
run('? di user mode mencantumkan enable & ping', () => {
  const o = out(r1, '?');
  assert.match(o, /enable/);
  assert.match(o, /ping/);
});
run('"show ?" kontekstual', () => {
  const o = out(r1, 'show ?');
  assert.match(o, /show ip route/);
  assert.match(o, /show version/);
});

console.log('\n== 5. ping & routing ==');
run('PC-1 ping 10.0.0.2 gagal (link shutdown) -> UUUUU', () => {
  const o = out(pc1, 'ping 10.0.0.2');
  assert.match(o, /UUUUU/);
  assert.match(o, /Success rate is 0 percent/);
});
run('no shutdown memunculkan syslog LINK-5-CHANGED', () => {
  exec(r1, 'conf t');
  exec(r1, 'int g0/1');
  const r = exec(r1, 'no shut');
  const text = [r.output, ...(r.syslog || [])].join('\n');
  assert.match(text, /%LINK-5-CHANGED: Interface GigabitEthernet0\/1, changed state to up/);
  assert.match(text, /%LINEPROTO-5-UPDOWN/);
  exec(r1, 'end');
});
run('PC-1 ping 10.0.0.2 masih gagal: R2 tak punya rute balik', () => {
  const o = out(pc1, 'ping 10.0.0.2');
  assert.match(o, /UUUUU/);
  assert.match(o, /no route back/);
});
run('tambah rute balik R2 -> ping sukses !!!!!', () => {
  exec(r2, 'enable');
  exec(r2, 'conf t');
  exec(r2, 'ip route 192.168.1.0 255.255.255.0 10.0.0.1');
  exec(r2, 'end');
  const o = out(pc1, 'ping 10.0.0.2');
  assert.match(o, /!!!!!/);
  assert.match(o, /Success rate is 100 percent \(5\/5\)/);
});
run('show ip route R2 kini punya S 192.168.1.0/24', () => {
  exec(r2, 'enable');
  const o = out(r2, 'show ip route');
  assert.match(o, /S\s+192\.168\.1\.0\/24 \[1\/0\] via 10\.0\.0\.1/);
});
run('no ip route menghapus rute (dan ping gagal lagi)', () => {
  exec(r2, 'conf t');
  exec(r2, 'no ip route 192.168.1.0 255.255.255.0 10.0.0.1');
  exec(r2, 'end');
  const o = out(pc1, 'ping 10.0.0.2');
  assert.match(o, /UUUUU/);
  exec(r2, 'conf t');
  exec(r2, 'ip route 192.168.1.0 255.255.255.0 10.0.0.1');
  exec(r2, 'end');
});
run('PC ipconfig', () => {
  const o = out(pc1, 'ipconfig');
  assert.match(o, /192\.168\.1\.10/);
  assert.match(o, /192\.168\.1\.1/);
});
run('switch: show vlan brief', () => {
  const sw1 = world.devices.get('sw1');
  exec(sw1, 'enable');
  const o = out(sw1, 'show vlan brief');
  assert.match(o, /1\s+default\s+active/);
});
run('switch tidak mengenal ip route', () => {
  const sw1 = world.devices.get('sw1');
  const o = out(sw1, 'ip route 1.0.0.0 255.0.0.0 192.168.1.1');
  assert.match(o, /% Invalid input detected/);
});

console.log('\n== 6. Quest auto-verify ==');
run('setelah rute balik: quest-1 otomatis selesai +100 XP', () => {
  const done = quests.verifyAll(world);
  assert.equal(done.length, 1);
  assert.equal(done[0].id, 'quest-1');
  assert.equal(quests.progress.xp, 100);
});
run('sebelum semua diperbaiki: quest-2 & quest-3 belum selesai', () => {
  quests.verifyAll(world);
  assert.ok(!quests.progress.completed.includes('quest-2'));
  assert.ok(!quests.progress.completed.includes('quest-3'));
});
run('perbaiki R2 Gi0/1 + rute R1 -> quest-2 & quest-3 selesai', () => {
  // quest-3: kembalikan IP R2 Gi0/1
  exec(r2, 'conf t');
  exec(r2, 'int g0/1');
  exec(r2, 'ip address 192.168.2.1 255.255.255.0');
  exec(r2, 'end');
  // quest-2: rute R1 ke LAN cabang
  exec(r1, 'conf t');
  exec(r1, 'ip route 192.168.2.0 255.255.255.0 10.0.0.2');
  exec(r1, 'end');
  const done = quests.verifyAll(world);
  const ids = done.map((q) => q.id).sort();
  assert.deepEqual(ids, ['quest-2', 'quest-3']);
  assert.equal(quests.progress.xp, 400);
});
run('ping PC-1 -> PC-2 end-to-end sukses', () => {
  const o = out(pc1, 'ping 192.168.2.10');
  assert.match(o, /!!!!!/);
});
run('ping PC-2 -> PC-1 end-to-end sukses', () => {
  const o = out(pc2, 'ping 192.168.1.10');
  assert.match(o, /!!!!!/);
});

console.log('\n== 7. Paritas Packet Tracer: perintah baru ==');
run('do show ip route dari config mode', () => {
  exec(r1, 'conf t');
  const o = out(r1, 'do show ip route');
  assert.match(o, /192\.168\.1\.0\/24 is directly connected/);
  assert.equal(r1.currentMode, 'global-config'); // prompt tetap config
  exec(r1, 'end');
});
run('exit singkatan ex juga jalan', () => {
  exec(r1, 'conf t');
  exec(r1, 'ex');
  assert.equal(r1.currentMode, 'privileged');
});
run('enable secret + tampil di running-config', () => {
  exec(r1, 'conf t');
  exec(r1, 'enable secret cisco123');
  const o = out(r1, 'do show run');
  assert.match(o, /enable secret 5 /);
  exec(r1, 'no enable secret');
  const o2 = out(r1, 'do show run');
  assert.doesNotMatch(o2, /enable secret/);
  exec(r1, 'end');
});
run('banner motd + line console 0 + password + login', () => {
  exec(r1, 'conf t');
  exec(r1, 'banner motd #Akses Terbatas#');
  assert.equal(r1.bannerMotd, 'Akses Terbatas');
  exec(r1, 'line console 0');
  assert.equal(r1.currentMode, 'line-config');
  assert.match(r1.prompt, /\(config-line\)# /);
  exec(r1, 'password conpass');
  exec(r1, 'login');
  exec(r1, 'end');
  const o = out(r1, 'show run');
  assert.match(o, /line console 0/);
  assert.match(o, / password conpass/);
  assert.match(o, / login/);
  assert.match(o, /banner motd/);
});
run('copy run start + show startup + [OK]', () => {
  exec(r1, 'enable');
  const o = out(r1, 'copy run start');
  assert.match(o, /Destination filename \[startup-config\]/);
  assert.match(o, /\[OK\]/);
  const s = out(r1, 'show start');
  assert.match(s, /hostname R1/);
});
run('write memory juga menyimpan', () => {
  const o = out(r1, 'wr');
  assert.match(o, /\[OK\]/);
});
run('erase startup-config lalu show start kosong', () => {
  out(r1, 'erase start');
  const s = out(r1, 'show start');
  assert.match(s, /startup-config is not present/);
});
run('reload mengembalikan kondisi quest awal (Gi0/1 down lagi)', () => {
  const o = out(r1, 'reload');
  assert.match(o, /Proceed with reload\? \[confirm\]/);
  assert.equal(r1.interfaces['GigabitEthernet0/1'].adminUp, false);
});
run('show history mencatat perintah', () => {
  exec(r1, 'enable');
  exec(r1, 'show version');
  const o = out(r1, 'show history');
  assert.match(o, /show version/);
});
run('show clock format IOS', () => {
  const o = out(r1, 'show clock');
  assert.match(o, /^\*[A-Z][a-z][a-z] [A-Z][a-z][a-z] \d{1,2} \d{2}:\d{2}:\d{2}\.\d{3} UTC$/);
});

console.log('\n== 8. PC ala Windows ==');
run('ipconfig /all ala Windows', () => {
  const o = out(pc1, 'ipconfig /all');
  assert.match(o, /Windows IP Configuration/);
  assert.match(o, /Physical Address/);
  assert.match(o, /192\.168\.1\.10/);
  assert.match(o, /Default Gateway (?:\. )+: 192\.168\.1\.1/);
});
run('arp -a setelah ping terisi', () => {
  // pulihkan jalur (quest-1 dikerjakan ulang cepat)
  exec(r1, 'enable'); exec(r1, 'conf t'); exec(r1, 'int g0/1'); exec(r1, 'no shut'); exec(r1, 'end');
  exec(r2, 'conf t'); exec(r2, 'ip route 192.168.1.0 255.255.255.0 10.0.0.1'); exec(r2, 'end');
  out(pc1, 'ping 10.0.0.2');
  const o = out(pc1, 'arp -a');
  assert.match(o, /Interface: 192\.168\.1\.10/);
  assert.match(o, /dynamic/);
});
run('tracert PC-1 -> 10.0.0.2 lewat gateway', () => {
  const o = out(pc1, 'tracert 10.0.0.2');
  assert.match(o, /Tracing route to 10\.0\.0\.2/);
  assert.match(o, /Trace complete/);
  assert.match(o, /192\.168\.1\.1/); // hop gateway
});
run('traceroute IOS di router', () => {
  exec(r1, 'enable'); // pastikan di privileged EXEC (bukan user)
  const o = out(r1, 'tracer 10.0.0.2');
  assert.match(o, /Tracing the route to 10\.0\.0\.2/);
  assert.match(o, /10\.0\.0\.2 \d+ msec/);
});
run('ping hostname tidak dikenal -> Unrecognized host', () => {
  const o = out(pc1, 'ping webserver.example.com');
  assert.match(o, /% Unrecognized host or address/);
});

console.log('\n== 9. Reset world ==');
run('resetWorld mengembalikan semua kondisi awal', () => {
  const world2 = resetWorld(
    JSON.parse(readFileSync(path.join(ROOT, 'data/devices.json'), 'utf8')),
    JSON.parse(readFileSync(path.join(ROOT, 'data/topology.json'), 'utf8')),
    JSON.parse(readFileSync(path.join(ROOT, 'src/quests/definitions.json'), 'utf8'))
  );
  const r1b = world2.devices.get('r1');
  const r2b = world2.devices.get('r2');
  assert.equal(r1b.interfaces['GigabitEthernet0/1'].adminUp, false); // quest-1
  assert.equal(r2b.interfaces['GigabitEthernet0/1'].ip, '192.168.3.1'); // quest-3
  const q = new QuestManager(readJson('src/quests/definitions.json').quests, world2);
  const done = q.verifyAll(world2);
  assert.equal(done.length, 0); // tidak ada yang selesai setelah reset
});

console.log('\n== 10. Routing dinamis: RIP / OSPF / EIGRP ==');
/* Persiapan: pulihkan link quest-1, hapus rute statis agar routing dinamis
   benar-benar yang mengkonvergensi. */
exec(r1, 'enable');
exec(r1, 'conf t'); exec(r1, 'int g0/1'); exec(r1, 'no shut'); exec(r1, 'end');
exec(r2, 'conf t'); exec(r2, 'no ip route 192.168.1.0 255.255.255.0 10.0.0.1'); exec(r2, 'end');

run('tanpa routing: ping PC-1 -> PC-2 gagal', () => {
  const o = out(pc1, 'ping 192.168.2.10');
  assert.match(o, /Success rate is 0 percent/);
});

run('RIP: prompt (config-router)# + konfigurasi dua router', () => {
  exec(r1, 'conf t');
  exec(r1, 'router rip');
  assert.equal(r1.currentMode, 'router-config');
  assert.equal(r1.prompt, 'R1(config-router)# ');
  exec(r1, 'version 2');
  exec(r1, 'network 10.0.0.0');
  exec(r1, 'network 192.168.1.0');
  exec(r1, 'no auto-summary');
  exec(r1, 'end');
  exec(r2, 'conf t');
  exec(r2, 'router rip');
  exec(r2, 'version 2');
  exec(r2, 'network 10.0.0.0');
  exec(r2, 'network 192.168.2.0');
  exec(r2, 'no auto-summary');
  exec(r2, 'end');
});
run('RIP: show ip route R1 ada R 192.168.2.0/24 [120/1] via 10.0.0.2', () => {
  const o = out(r1, 'show ip route');
  assert.match(o, /R\s+192\.168\.2\.0\/24 \[120\/1\] via 10\.0\.0\.2, \d{2}:\d{2}:\d{2}, GigabitEthernet0\/1/);
});
run('RIP: show ip route R2 ada R 192.168.1.0/24 [120/1]', () => {
  const o = out(r2, 'show ip route');
  assert.match(o, /R\s+192\.168\.1\.0\/24 \[120\/1\] via 10\.0\.0\.1, \d{2}:\d{2}:\d{2}, GigabitEthernet0\/0/);
});
run('RIP: ping PC-1 -> PC-2 end-to-end sukses', () => {
  const o = out(pc1, 'ping 192.168.2.10');
  assert.match(o, /!!!!!/);
});
run('RIP: show ip protocols', () => {
  const o = out(r1, 'sh ip pro');
  assert.match(o, /Routing Protocol is "rip"/);
  assert.match(o, /Sending updates every 30 seconds/);
  assert.match(o, /10\.0\.0\.0/);
  assert.match(o, /Distance: \(default is 120\)/);
});
run('RIP: show ip rip database', () => {
  const o = out(r1, 'sh ip rip da');
  assert.match(o, /directly connected/);
  assert.match(o, /\[1\] via 10\.0\.0\.2/);
});
run('RIP: network masuk running-config', () => {
  const o = out(r1, 'show run');
  assert.match(o, /router rip/);
  assert.match(o, / version 2/);
  assert.match(o, / network 10\.0\.0\.0/);
  assert.match(o, /no auto-summary/);
});

run('OSPF: ganti ke ospf 1 (RIP dihapus)', () => {
  exec(r1, 'conf t'); // hapus RIP
  exec(r1, 'no router rip');
  exec(r1, 'router ospf 1');
  assert.equal(r1.prompt, 'R1(config-router)# ');
  exec(r1, 'network 10.0.0.0 0.0.0.3 area 0');
  exec(r1, 'network 192.168.1.0 0.0.0.255 area 0');
  exec(r1, 'end');
  exec(r2, 'conf t');
  exec(r2, 'no router rip');
  exec(r2, 'router ospf 1');
  // adjacency terbentuk saat subnet WAN cocok di kedua router -> log ADJCHG di sini
  exec(r2, 'network 192.168.2.0 0.0.0.255 area 0');
  const r = exec(r2, 'network 10.0.0.0 0.0.0.3 area 0');
  assert.match(
    (r.syslog || []).join('\n'),
    /%OSPF-5-ADJCHG: Process 1, Nbr 10\.0\.0\.1 on GigabitEthernet0\/0 from LOADING to FULL, Loading Done/
  );
  exec(r2, 'end');
});
run('OSPF: show ip route R1 ada O 192.168.2.0/24 [110/2]', () => {
  const o = out(r1, 'show ip route');
  assert.match(o, /O\s+192\.168\.2\.0\/24 \[110\/2\] via 10\.0\.0\.2, \d{2}:\d{2}:\d{2}, GigabitEthernet0\/1/);
});
run('OSPF: show ip ospf neighbor FULL', () => {
  const o = out(r1, 'sh ip ospf ne');
  assert.match(o, /Neighbor ID\s+Pri\s+State\s+Dead Time\s+Address\s+Interface/);
  assert.match(o, /FULL\/(DR|BDR)/);
  assert.match(o, /10\.0\.0\.2/);
});
run('OSPF: show ip ospf memuat Router ID', () => {
  const o = out(r1, 'sh ip ospf');
  assert.match(o, /Routing Process "ospf 1" with ID /);
  assert.match(o, /Reference bandwidth unit is 100 mbps/);
});
run('OSPF: ping PC-1 -> PC-2 sukses', () => {
  const o = out(pc1, 'ping 192.168.2.10');
  assert.match(o, /!!!!!/);
});
run('OSPF: router-id manual tampil di show ip ospf', () => {
  exec(r1, 'conf t');
  exec(r1, 'router ospf 1');
  exec(r1, 'router-id 1.1.1.1');
  exec(r1, 'end');
  const o = out(r1, 'show ip ospf');
  assert.match(o, /with ID 1\.1\.1\.1/);
});

run('EIGRP: ganti ke eigrp 100 (OSPF dihapus)', () => {
  exec(r1, 'conf t');
  exec(r1, 'no router ospf 1');
  exec(r1, 'router eigrp 100');
  assert.equal(r1.prompt, 'R1(config-router)# ');
  exec(r1, 'network 10.0.0.0');
  exec(r1, 'network 192.168.1.0');
  exec(r1, 'no auto-summary');
  exec(r1, 'end');
  exec(r2, 'conf t');
  exec(r2, 'no router ospf 1');
  exec(r2, 'router eigrp 100');
  // adjacency menyala saat statement subnet WAN cocok di kedua sisi
  exec(r2, 'network 192.168.2.0');
  const r2res = exec(r2, 'network 10.0.0.0');
  exec(r2, 'no auto-summary');
  exec(r2, 'end');
  assert.match(
    (r2res.syslog || []).join('\n'),
    /%DUAL-5-NBRCHANGE: IP-EIGRP\(0\) 100: Neighbor 10\.0\.0\.1 \(GigabitEthernet0\/0\) is up: new adjacency/
  );
});
run('EIGRP: metrik komposit D 192.168.2.0/24 [90/3072]', () => {
  const o = out(r1, 'show ip route');
  assert.match(o, /D\s+192\.168\.2\.0\/24 \[90\/3072\] via 10\.0\.0\.2, \d{2}:\d{2}:\d{2}, GigabitEthernet0\/1/);
});
run('EIGRP: show ip eigrp neighbors', () => {
  const o = out(r1, 'sh ip eigrp ne');
  assert.match(o, /IP-EIGRP neighbors for process 100/);
  assert.match(o, /10\.0\.0\.2/);
});
run('EIGRP: show ip eigrp topology FD/RD', () => {
  const o = out(r1, 'sh ip eigrp to');
  assert.match(o, /IP-EIGRP Topology Table for AS\(100\)/);
  // LAN langsung pada GigE: FD = 256 x (10 + 1) = 2816
  assert.match(o, /P 10\.0\.0\.0\/30, 1 successors, FD is 2816/);
  assert.match(o, /P 192\.168\.2\.0\/24, 1 successors, FD is 3072/);
  assert.match(o, /via 10\.0\.0\.2 \(3072\/2816\), GigabitEthernet0\/1/);
});
run('EIGRP: ping PC-1 -> PC-2 sukses', () => {
  const o = out(pc1, 'ping 192.168.2.10');
  assert.match(o, /!!!!!/);
});
run('EIGRP: passive-interface memutus adjacency + rute hilang', () => {
  const r = exec(r1, 'conf t');
  exec(r1, 'router eigrp 100');
  exec(r1, 'passive-interface g0/1');
  exec(r1, 'end');
  const o = out(r1, 'show ip route');
  assert.doesNotMatch(o, /D\s+192\.168\.2\.0\/24/);
  const o2 = out(pc1, 'ping 192.168.2.10');
  assert.match(o2, /Success rate is 0 percent/);
  // pulihkan
  exec(r1, 'conf t');
  exec(r1, 'router eigrp 100');
  exec(r1, 'no passive-interface g0/1');
  exec(r1, 'end');
  const o3 = out(pc1, 'ping 192.168.2.10');
  assert.match(o3, /!!!!!/);
});
run('no router eigrp menghapus konfigurasi & rute', () => {
  exec(r1, 'conf t');
  exec(r1, 'no router eigrp 100');
  exec(r1, 'end');
  exec(r2, 'conf t');
  exec(r2, 'no router eigrp 100');
  exec(r2, 'end');
  const o = out(r1, 'show ip protocols');
  assert.doesNotMatch(o, /eigrp 100/);
  const o2 = out(r1, 'show ip route');
  assert.doesNotMatch(o2, /D\s+192\.168\.2\.0\/24/);
});
run('show ip route tanpa protokol: hanya C/L', () => {
  const o = out(r1, 'show ip route');
  assert.match(o, /C\s+10\.0\.0\.0\/30 is directly connected/);
  assert.doesNotMatch(o, /\[120\/|\[110\/|\[90\//);
});
run('shutdown interface memicu log adjacency DOWN', () => {
  exec(r1, 'conf t');
  exec(r1, 'router eigrp 100');
  exec(r1, 'network 10.0.0.0');
  exec(r1, 'network 192.168.1.0');
  exec(r1, 'no auto-summary');
  exec(r1, 'end');
  exec(r2, 'conf t');
  exec(r2, 'router eigrp 100');
  exec(r2, 'network 10.0.0.0');
  exec(r2, 'network 192.168.2.0');
  exec(r2, 'end');
  // adjacency up sudah tercatat pada network terakhir r2; sekarang shutdown
  const r = exec(r1, 'conf t'); // event shutdown di bawah
  exec(r1, 'int g0/1');
  const res = exec(r1, 'shutdown');
  exec(r1, 'end');
  assert.match(
    (res.syslog || []).join('\n'),
    /%DUAL-5-NBRCHANGE: IP-EIGRP\(0\) 100: Neighbor 10\.0\.0\.2 \(GigabitEthernet0\/1\) is down/
  );
  // pulihkan
  exec(r1, 'conf t'); exec(r1, 'int g0/1'); exec(r1, 'no shut'); exec(r1, 'end');
  exec(r1, 'conf t'); exec(r1, 'no router eigrp 100'); exec(r1, 'end');
  exec(r2, 'conf t'); exec(r2, 'no router eigrp 100'); exec(r2, 'end');
});

console.log('\n== 11. VLAN & switchport (paritas NetSim) ==');
const sw1 = world.devices.get('sw1');
run('vlan 10 + name SALES masuk (config-vlan)#', () => {
  exec(sw1, 'enable');
  exec(sw1, 'conf t');
  exec(sw1, 'vlan 10');
  assert.equal(sw1.currentMode, 'vlan-config');
  assert.equal(sw1.prompt, 'SW-1(config-vlan)# ');
  exec(sw1, 'name SALES');
  exec(sw1, 'end');
  assert.equal(sw1.prompt, 'SW-1# ');
});
run('switchport access vlan 10 + show vlan brief dinamis', () => {
  exec(sw1, 'conf t');
  exec(sw1, 'int fa0/1');
  exec(sw1, 'switchport access vlan 10');
  exec(sw1, 'end');
  const o = out(sw1, 'show vlan brief');
  assert.match(o, /10\s+SALES\s+active/);
  assert.match(o, /Fa0\/1/);
});
run('VLAN isolasi: ping PC-1 -> gateway diblokir L2', () => {
  const r = parser.execute(pc1, 'ping 192.168.1.1', world);
  assert.equal(r.output.includes('Success rate is 0 percent'), true);
  assert.match(r.output, /VLAN/i);
});
run('kembali ke VLAN 1: ping normal lagi', () => {
  exec(sw1, 'conf t');
  exec(sw1, 'int fa0/1');
  exec(sw1, 'switchport access vlan 1');
  exec(sw1, 'end');
  const o = out(pc1, 'ping 192.168.1.1');
  assert.match(o, /!!!!!/);
});

console.log('\n== 12. DHCP DORA (paritas NetSim) ==');
run('ip dhcp pool di R1', () => {
  exec(r1, 'conf t');
  exec(r1, 'ip dhcp excluded-address 192.168.1.1 192.168.1.9');
  exec(r1, 'ip dhcp pool LAN1');
  assert.equal(r1.currentMode, 'dhcp-config');
  assert.equal(r1.prompt, 'R1(config-dhcp)# ');
  exec(r1, 'network 192.168.1.0 255.255.255.0');
  exec(r1, 'default-router 192.168.1.1');
  exec(r1, 'dns-server 8.8.8.8');
  exec(r1, 'end');
  const o = out(r1, 'show run');
  assert.match(o, /ip dhcp pool LAN1/);
});
run('ipconfig /renew di PC-1 melakukan DORA', () => {
  // kosongkan IP PC-1 dulu agar lease baru benar-benar diuji
  pc1.interfaces['FastEthernet0'].ip = null;
  pc1.interfaces['FastEthernet0'].mask = null;
  pc1.gw = null;
  const o = out(pc1, 'ipconfig /renew');
  assert.match(o, /DHCPDISCOVER sent/);
  assert.match(o, /DHCPOFFER from 192\.168\.1\.1 \(R1/);
  assert.match(o, /DHCPREQUEST -> 192\.168\.1\.1/);
  assert.match(o, /DHCPACK from 192\.168\.1\.1/);
  assert.match(o, /Lease obtained: 192\.168\.1\.10 \/ 255\.255\.255\.0, gateway 192\.168\.1\.1, DNS 8\.8\.8\.8/);
  assert.equal(pc1.interfaces['FastEthernet0'].ip, '192.168.1.10');
});
run('show ip dhcp binding di R1', () => {
  const o = out(r1, 'sh ip dhcp bi');
  assert.match(o, /192\.168\.1\.10/);
  assert.match(o, /Automatic/);
});

console.log('\n== 13. ACL standar (paritas NetSim) ==');
run('ACL 20 deny 192.168.2.0 di Gi0/1 R1 (in)', () => {
  exec(r1, 'conf t');
  exec(r1, 'access-list 20 deny 192.168.2.0 0.0.0.255');
  exec(r1, 'int g0/1');
  exec(r1, 'ip access-group 20 in');
  exec(r1, 'end');
  const o = out(r1, 'sh acc');
  assert.match(o, /Standard IP access list 20/);
  assert.match(o, /deny 192\.168\.2\.0 0\.0\.0\.255/);
});
run('ping PC-2 -> PC-1 diblokir ACL (src match)', () => {
  // R1 & R2 perlu rute statis agar paket sampai ke R1 (ACL memutus di sana)
  exec(r2, 'conf t'); exec(r2, 'ip route 192.168.1.0 255.255.255.0 10.0.0.1'); exec(r2, 'end');
  exec(r1, 'conf t'); exec(r1, 'ip route 192.168.2.0 255.255.255.0 10.0.0.2'); exec(r1, 'end');
  const o = out(pc2, 'ping 192.168.1.10');
  assert.match(o, /Success rate is 0 percent/);
  assert.match(o, /acl/i);
});
run('ping PC-1 -> PC-2 tetap jalan (src 192.168.1.10 tidak match ACL 20)', () => {
  const o = out(pc1, 'ping 192.168.2.10');
  assert.match(o, /!!!!!/);
});
run('bersihkan ACL', () => {
  exec(r1, 'conf t');
  exec(r1, 'no ip access-group 20');
  exec(r1, 'no access-list 20');
  exec(r1, 'end');
  const o = out(r1, 'sh acc');
  assert.doesNotMatch(o, /access list 20/);
});

console.log('\n== 14. NAT/PAT overload (paritas NetSim) ==');
run('konfigurasi NAT di R1 (inside/outside + rule)', () => {
  exec(r1, 'conf t');
  exec(r1, 'access-list 5 permit 192.168.1.0 0.0.0.255');
  exec(r1, 'int g0/0');
  exec(r1, 'ip nat inside');
  exec(r1, 'int g0/1');
  exec(r1, 'ip nat outside');
  exec(r1, 'end');
  exec(r1, 'conf t');
  exec(r1, 'ip nat inside source list 5 interface g0/1 overload');
  exec(r1, 'end');
  const o = out(r1, 'show run');
  assert.match(o, /ip nat inside source list 5 interface GigabitEthernet0\/1 overload/);
});
run('ping PC-1 -> PC-2 lewat NAT + tabel translasi', () => {
  const o = out(pc1, 'ping 192.168.2.10');
  assert.match(o, /!!!!!/);
  const t = out(r1, 'sh ip nat tr');
  assert.match(t, /icmp\s+10\.0\.0\.1:1\s+192\.168\.1\.10:1\s+192\.168\.2\.10:1/);
});
run('bersihkan NAT & rute statis', () => {
  exec(r1, 'conf t');
  exec(r1, 'no ip nat inside source');
  exec(r1, 'no access-list 5');
  exec(r1, 'no ip route 192.168.2.0 255.255.255.0 10.0.0.2');
  exec(r1, 'end');
  exec(r1, 'conf t');
  exec(r1, 'int g0/0'); exec(r1, 'no ip nat');
  exec(r1, 'int g0/1'); exec(r1, 'no ip nat');
  exec(r1, 'end');
  exec(r2, 'conf t');
  exec(r2, 'no ip route 192.168.1.0 255.255.255.0 10.0.0.1');
  exec(r2, 'end');
});

console.log('\n== 15. BGP eBGP (paritas NetSim) ==');
run('router bgp 65001/65002 + neighbor + ADJCHANGE', () => {
  exec(r1, 'conf t');
  exec(r1, 'router bgp 65001');
  assert.equal(r1.prompt, 'R1(config-router)# ');
  exec(r1, 'neighbor 10.0.0.2 remote-as 65002');
  exec(r1, 'network 192.168.1.0 mask 255.255.255.0');
  exec(r1, 'end');
  exec(r2, 'conf t');
  exec(r2, 'router bgp 65002');
  const r = exec(r2, 'neighbor 10.0.0.1 remote-as 65001'); // adjacency menyala di sini
  assert.match((r.syslog || []).join('\n'), /%BGP-5-ADJCHANGE: Neighbor 10\.0\.0\.1 Up/);
  exec(r2, 'network 192.168.2.0 mask 255.255.255.0');
  exec(r2, 'end');
});
run('show ip bgp summary: local AS 65001 + peer 65002', () => {
  const o = out(r1, 'sh ip bgp su');
  assert.match(o, /local AS number 65001/);
  assert.match(o, /10\.0\.0\.2\s+4\s+65002/);
});
run('show ip bgp: *> 192.168.2.0/24 via 10.0.0.2 path 65001 65002 i', () => {
  const o = out(r1, 'sh ip bgp');
  assert.match(o, /\*> 192\.168\.2\.0\/24\s+10\.0\.0\.2/);
  assert.match(o, /65001 65002 i/);
});
run('show ip route: B 192.168.2.0/24 [20/0] via 10.0.0.2', () => {
  const o = out(r1, 'show ip route');
  assert.match(o, /B\s+192\.168\.2\.0\/24 \[20\/0\] via 10\.0\.0\.2/);
});
run('ping PC-1 -> PC-2 via BGP + show capture berisi frame', () => {
  const o = out(pc1, 'ping 192.168.2.10');
  assert.match(o, /!!!!!/);
  const c = out(pc1, 'show capture');
  assert.match(c, /ICMP echo request/);
  assert.match(c, /ICMP echo reply/);
});
run('bersihkan BGP', () => {
  exec(r1, 'conf t'); exec(r1, 'no router bgp 65001'); exec(r1, 'end');
  exec(r2, 'conf t'); exec(r2, 'no router bgp 65002'); exec(r2, 'end');
  const o = out(r1, 'show ip route');
  assert.doesNotMatch(o, /B\s+192\.168\.2\.0/);
});

console.log('\n== 16. STP & pcap (paritas NetSim) ==');
run('spanning-tree priority 4096 di SW1 -> root', () => {
  exec(sw1, 'conf t');
  exec(sw1, 'spanning-tree priority 4096');
  exec(sw1, 'end');
  const o = out(sw1, 'sh span');
  assert.match(o, /Priority    4096/);
  assert.match(o, /This bridge is the root/);
});
run('SW2 tetap priority default 32768', () => {
  const sw2 = world.devices.get('sw2');
  const o = out(sw2, 'show spanning-tree');
  assert.match(o, /Priority    32768/);
});
run('pcapFromCapture menghasilkan file .pcap sah', async () => {
  const { pcapFromCapture } = await import('../src/simulator/pcap.js');
  const bytes = pcapFromCapture(pc1.captureLog);
  assert.ok(bytes.length > 24);
  // magic libpcap little-endian a1b2c3d4 -> d4 c3 b2 a1
  assert.deepEqual(bytes.slice(0, 4), [0xd4, 0xc3, 0xb2, 0xa1]);
  assert.equal(bytes[20] | (bytes[21] << 8), 1); // network = Ethernet
});

console.log('\n== 17. Port & kabel (variasi port ala NetCLI) ==');
const pcx = world.devices.get('pc1'); // pakai PC-1 utk variasi port
run('interface add serial0/1/0 + gigabitethernet0 di PC-1 (port ekspansi)', () => {
  const o = out(pcx, 'interface add serial0/1/0');
  assert.match(o, /Serial0\/1\/0/);
  assert.equal(pcx.interfaces['Serial0/1/0'].portType, 'Serial');
  exec(pcx, 'interface add gigabitethernet0');
  assert.equal(pcx.interfaces['GigabitEthernet0'].portType, 'GigabitEthernet');
  exec(pcx, 'end');
});
run('show interfaces menampilkan Port type + clock rate', () => {
  exec(pcx, 'int s0/1/0');
  exec(pcx, 'clock rate 128000');
  exec(pcx, 'end');
  const o = out(pcx, 'show interfaces Serial0/1/0');
  assert.match(o, /Port type: Serial, clock rate 128000 \(DCE\)/);
});
run('clock rate ditolak di port FastEthernet', () => {
  exec(pcx, 'int fa0');
  const o = out(pcx, 'clock rate 64000');
  assert.match(o, /Serial/);
  exec(pcx, 'end');
});
run('connect: kabel otomatis Serial DCE/DTE (PC-3 <-> R1)', () => {
  exec(r1, 'conf t');
  exec(r1, 'interface add serial0/0/0');
  exec(r1, 'end');
  const o = out(pcx, 'connect s0/1/0 r1 s0/0/0');
  assert.match(o, /Kabel terpasang: PC-1:Serial0\/1\/0 <-> R1:Serial0\/0\/0/);
  assert.match(o, /Serial DCE\/DTE/);
});
run('connect ethernet: PC-PC crossover, router-switch straight', () => {
  const sw1 = world.devices.get('sw1');
  assert.equal(cableTypeBetween(pcx, 'GigabitEthernet0', world.devices.get('r1'), 'GigabitEthernet0/0'), 'Copper Cross-Over');
  assert.equal(cableTypeBetween(world.devices.get('r1'), 'GigabitEthernet0/0', sw1, 'FastEthernet0/2'), 'Copper Straight-Through');
  assert.equal(cableTypeBetween(pcx, 'GigabitEthernet0', world.devices.get('r1'), 'Serial0/0/0'), null);
});
run('connect incompatible: ethernet vs serial ditolak', () => {
  const o = out(pcx, 'connect g0 r1 s0/0/0');
  assert.match(o, /tidak kompatibel/);
});
run('disconnect melepas kabel runtime', () => {
  const o = out(pcx, 'disconnect s0/1/0');
  assert.match(o, /Kabel dilepas/);
  assert.equal(world.links.filter((l) => l.runtime).length, 0);
});

console.log('\n== 18. PC -> Server & service ala Packet Tracer ==');
run('rute statis antar LAN dulu (agar ping antar PC jalan)', () => {
  exec(r1, 'conf t'); exec(r1, 'ip route 192.168.2.0 255.255.255.0 10.0.0.2'); exec(r1, 'end');
  exec(r2, 'conf t'); exec(r2, 'ip route 192.168.1.0 255.255.255.0 10.0.0.1'); exec(r2, 'end');
});
run('role server + service dns on + record', () => {
  exec(pc2, 'enable');
  exec(pc2, 'role server');
  assert.equal(pc2.role, 'server');
  const o = out(pc2, 'service dns on');
  assert.match(o, /DNS server aktif/);
  exec(pc2, 'service dns add web1 192.168.2.10');
  exec(pc2, 'service dns add gw1 192.168.2.1');
  const o2 = out(pc2, 'show services');
  assert.match(o2, /DNS\s+ON\s+2 record: web1, gw1/);
});
run('ping pakai DNS server (record web1 -> 192.168.2.10)', () => {
  const o = out(pc1, 'ping web1');
  assert.match(o, /!!!!!/);
});
run('nslookup via DNS server', () => {
  const o = out(pc1, 'nslookup gw1');
  assert.match(o, /Name:\s+gw1/);
  assert.match(o, /Address:\s+192\.168\.2\.1/);
});
run('service dhcp on di server (range + gateway + dns tampil)', () => {
  exec(pc2, 'service dhcp on');
  exec(pc2, 'service dhcp range 192.168.2.100 192.168.2.150');
  exec(pc2, 'service dhcp gateway 192.168.2.1');
  exec(pc2, 'service dhcp dns 192.168.2.10');
  const o = out(pc2, 'show services');
  assert.match(o, /DHCP\s+ON\s+range 192\.168\.2\.100/);
});
run('service http on + web browser dari PC-1', () => {
  exec(pc2, 'service http on');
  const o = out(pc1, 'web http://web1/index.html');
  assert.match(o, /HTTP\/1\.1 200 OK/);
  assert.match(o, /NetQuest/);
});
run('service tftp on + copy running-config tftp:// + balik lagi', () => {
  exec(pc2, 'service tftp on');
  exec(r1, 'conf t');
  exec(r1, 'hostname R1-JBOD');
  exec(r1, 'end');
  const o = out(r1, 'copy running-config tftp://192.168.2.10/r1-confg');
  assert.match(o, /\[OK - \d+ bytes\]/);
  exec(r1, 'hostname R1');
  const o2 = out(r1, 'copy tftp://192.168.2.10/r1-confg running-config');
  assert.match(o2, /diterapkan/);
  assert.equal(r1.hostname, 'R1-JBOD');
  exec(r1, 'conf t');
  exec(r1, 'hostname R1');
  exec(r1, 'end');
});
run('logging <ip> + syslog masuk di server', () => {
  exec(pc2, 'service syslog on');
  exec(r1, 'conf t');
  exec(r1, 'logging 192.168.2.10');
  exec(r1, 'hostname R1-SYSLOG');
  exec(r1, 'hostname R1');
  exec(r1, 'end');
  const o = out(pc2, 'show services');
  assert.match(o, /SYSLOG\s+ON.*\d+ pesan diterima/);
  assert.ok(pc2.services.syslog.log.some((e) => /hostname changed/.test(e.text)));
});
run('netstat menampilkan service listening', () => {
  const o = out(pc2, 'netstat');
  assert.match(o, /:80 \(HTTP\)/);
  assert.match(o, /:53 \(DNS\)/);
});
run('role pc kembali + DNS record tidak lagi dilayani', () => {
  exec(pc2, 'role pc');
  assert.equal(pc2.role, 'pc');
  const o = out(pc1, 'ping web1');
  assert.match(o, /Unrecognized host or address/);
  // bersihkan rute statis antar LAN
  exec(r1, 'conf t'); exec(r1, 'no ip route 192.168.2.0 255.255.255.0 10.0.0.2'); exec(r1, 'end');
  exec(r2, 'conf t'); exec(r2, 'no ip route 192.168.1.0 255.255.255.0 10.0.0.1'); exec(r2, 'end');
});

console.log('\n== 19. Telnet ala NetCLI ==');
run('telnet dari PC-1 ke R1: prompt pindah + exit kembali', () => {
  const o = out(pc1, 'telnet 192.168.1.1');
  assert.match(o, /Trying 192\.168\.1\.1 \.\.\. Open/);
  assert.equal(pc1.telnetSession, 'r1');
  // perintah dieksekusi DI R1 (route table punya C/L 192.168.1.x milik R1)
  const st = parser.execute(pc1, 'show ip route', world);
  assert.match(st.output, /C\s+192\.168\.1\.0\/24/);
  assert.equal(st.prompt, 'R1# ');
  // exit pertama: R1 masih privileged -> kembali ke user mode R1 (sesi lanjut)
  const o1 = parser.execute(pc1, 'exit', world);
  assert.equal(o1.prompt, 'R1> ');
  // exit kedua: user mode -> sesi ditutup
  const o2 = parser.execute(pc1, 'exit', world);
  assert.match(o2.output, /Connection to R1 closed/);
  assert.equal(pc1.telnetSession, null);
  assert.equal(o2.prompt, 'PC-1> ');
});
run('quit juga menutup sesi telnet', () => {
  exec(pc1, 'telnet 192.168.1.1');
  const o = parser.execute(pc1, 'quit', world);
  assert.match(o.output, /Connection to R1 closed/);
});
run('telnet ke host yang tidak ada: pesan IOS', () => {
  const o = out(pc1, 'telnet 9.9.9.9');
  assert.match(o, /tidak ada perangkat|timed out|Unrecognized/i);
});

console.log('\n== 20. SSH / FTP / NTP ==');
run('rute statis antar LAN (persiapan section 20-22)', () => {
  exec(r1, 'enable'); exec(r1, 'conf t'); exec(r1, 'ip route 192.168.2.0 255.255.255.0 10.0.0.2'); exec(r1, 'end');
  exec(r2, 'enable'); exec(r2, 'conf t'); exec(r2, 'ip route 192.168.1.0 255.255.255.0 10.0.0.1'); exec(r2, 'end');
});
run('ip domain name + crypto key generate rsa -> SSH aktif di R1', () => {
  exec(r1, 'enable');
  exec(r1, 'conf t');
  exec(r1, 'ip domain name netquest.local');
  const o = out(r1, 'crypto key generate rsa modulus 1024');
  assert.match(o, /modulus 1024/);
  assert.equal(r1.ssh.domain, 'netquest.local');
  assert.equal(r1.ssh.keyModulus, 1024);
  exec(r1, 'end');
});
run('show ip ssh menampilkan status', () => {
  const o = out(r1, 'show ip ssh');
  assert.match(o, /SSH Enabled/);
  assert.match(o, /netquest\.local/);
});
run('SSH dari PC-1 ke R1: banner SSH-2.0 + prompt pindah', () => {
  const o = out(pc1, 'ssh 192.168.1.1');
  assert.match(o, /SSH-2\.0-NetQuest/);
  assert.equal(pc1.telnetSession, 'r1');
  parser.execute(pc1, 'exit', world); // privileged -> user di R1
  const o2 = parser.execute(pc1, 'exit', world);
  assert.match(o2.output, /Connection to R1 closed/);
});
run('SSH ditolak jika crypto key belum ada', () => {
  r2.ssh.keyModulus = null;
  const o = out(pc1, 'ssh 10.0.0.2');
  assert.match(o, /crypto key generate rsa/);
});
run('PC-2 role server + service ftp on + sesi ftp ls/get/bye', () => {
  exec(pc2, 'role server');
  exec(pc2, 'service ftp on');
  assert.ok(pc2.services.ftp.on);
  const o = out(pc1, 'ftp 192.168.2.10');
  assert.match(o, /220 NetQuest FTP server ready/);
  assert.equal(pc1.ftpSession, 'pc2');
  const ls = parser.execute(pc1, 'ls', world);
  assert.match(ls.output, /readme\.txt/);
  assert.equal(ls.prompt, 'ftp> ');
  const get = parser.execute(pc1, 'get readme.txt', world);
  assert.match(get.output, /226 Transfer complete/);
  assert.match(get.output, /NetQuest FTP server siap/);
  const bye = parser.execute(pc1, 'bye', world);
  assert.match(bye.output, /221 Goodbye/);
  assert.equal(pc1.ftpSession, null);
});
run('get file yang tidak ada: 550', () => {
  exec(pc1, 'ftp 192.168.2.10');
  const o = parser.execute(pc1, 'get hantu.bin', world);
  assert.match(o.output, /550/);
  parser.execute(pc1, 'bye', world);
});
run('service ntp on + ntp server -> R1 & R2 sinkron', () => {
  exec(pc2, 'service ntp on');
  exec(r1, 'enable');
  exec(r1, 'conf t');
  exec(r1, 'ip route 192.168.2.0 255.255.255.0 10.0.0.2');
  exec(r1, 'ntp server 192.168.2.10');
  exec(r2, 'enable');
  exec(r2, 'conf t');
  exec(r2, 'ntp server 192.168.2.10');
  exec(r2, 'end');
  exec(r1, 'end');
  const o = out(r1, 'show ntp status');
  assert.match(o, /Clock is synchronized/);
  const o2 = out(r2, 'show ntp status');
  assert.match(o2, /synchronized/);
});
run('show services memuat FTP & NTP', () => {
  const o = out(pc2, 'show services');
  assert.match(o, /FTP\s+ON/);
  assert.match(o, /NTP\s+ON/);
});

console.log('\n== 21. Quest: 16 definisi + tipe objektif baru ==');
const defs16 = JSON.parse(readFileSync('src/quests/definitions.json', 'utf8')).quests;
run('16 quest terdefinisi, total XP 2825', () => {
  assert.equal(defs16.length, 16);
  assert.equal(defs16.reduce((a, q) => a + q.xp, 0), 2825);
});
const qm = new QuestManager(defs16, world);
const ck = (obj) => qm.checkObjective(null, obj);
run('objektif vlan + switchport (quest-14)', () => {
  const pre = ck({ type: 'vlan', device: 'sw1', vlan: 20, name: 'OFFICE' });
  assert.equal(pre, false);
  exec(sw1, 'enable');
  exec(sw1, 'conf t');
  exec(sw1, 'vlan 20');
  exec(sw1, 'name OFFICE');
  exec(sw1, 'end');
  exec(sw1, 'conf t');
  exec(sw1, 'int fa0/3');
  exec(sw1, 'switchport mode access');
  exec(sw1, 'switchport access vlan 20');
  exec(sw1, 'end');
  assert.equal(ck({ type: 'vlan', device: 'sw1', vlan: 20, name: 'OFFICE' }), true);
  assert.equal(ck({ type: 'switchport', device: 'sw1', interface: 'FastEthernet0/3', expect: { mode: 'access', accessVlan: 20 } }), true);
});
run('objektif protocol ospf/bgp (quest-5/15)', () => {
  const pre = ck({ type: 'protocol', device: 'r1', proto: 'ospf', pid: 1, network: '192.168.1.0', area: 0 });
  assert.equal(pre, false);
  exec(r1, 'enable');
  exec(r1, 'conf t');
  exec(r1, 'router ospf 1');
  exec(r1, 'network 192.168.1.0 0.0.0.255 area 0');
  exec(r1, 'end');
  assert.equal(ck({ type: 'protocol', device: 'r1', proto: 'ospf', pid: 1, network: '192.168.1.0', area: 0 }), true);
  assert.equal(ck({ type: 'protocol', device: 'r1', proto: 'bgp', as: 65001, network: '192.168.1.0', neighbor: { remoteAs: 65002 } }), false);
});
run('objektif role + service dns + ping hostname (quest-8)', () => {
  assert.equal(ck({ type: 'role', device: 'pc2', expect: 'server' }), true);
  assert.equal(ck({ type: 'service', device: 'pc2', service: 'dns', expect: { on: true, hasRecord: { name: 'web1', ip: '192.168.2.10' } } }), true);
  assert.equal(ck({ type: 'ping', from: 'pc1', to: 'web1' }), true);
});
run('objektif dhcp-lease (quest-7): release+renew PC-1', () => {
  exec(pc1, 'ipconfig /release');
  const pre = ck({ type: 'dhcp-lease', device: 'pc1', interface: 'FastEthernet0', expect: { gateway: '192.168.1.1' } });
  assert.equal(pre, false);
  exec(pc1, 'ipconfig /renew');
  const o = out(pc1, 'ipconfig');
  assert.match(o, /192\.168\.1\./);
  assert.equal(ck({ type: 'dhcp-lease', device: 'pc1', interface: 'FastEthernet0', expect: { gateway: '192.168.1.1' } }), true);
});
run('objektif ntp + ssh (quest-12/13)', () => {
  assert.equal(ck({ type: 'ssh', device: 'r1', expect: { domain: 'netquest.local' } }), true);
  assert.equal(ck({ type: 'ssh', device: 'r1', expect: { keyModulus: 1024 } }), true);
  assert.equal(ck({ type: 'ntp', device: 'r1', expect: { server: '192.168.2.10' } }), true);
  assert.equal(ck({ type: 'ntp', device: 'r2', expect: { server: '192.168.2.10' } }), true);
});
run('objektif route absent + interface aclIn (quest-16)', () => {
  // sabotase boot: rute hantu + ACL di Gi0/1 R1 (ACL di-section 8 sudah dibersihkan
  // oleh test ACL — pasang ulang utk verifikasi objektif)
  assert.ok(r2.routes.some((rt) => rt.network === '192.168.9.0'));
  r1.interfaces['GigabitEthernet0/1'].aclIn = 10;
  r1.acls['10'] = [ { action: 'deny', src: '192.168.1.99', wildcard: '0.0.0.0' }, { action: 'permit', src: 'any' } ];
  assert.equal(r1.interfaces['GigabitEthernet0/1'].aclIn, 10);
  assert.equal(ck({ type: 'route', device: 'r2', expect: { network: '192.168.9.0', mask: '255.255.255.0', nextHop: '192.168.2.2', absent: true } }), false);
  assert.equal(ck({ type: 'interface', device: 'r1', interface: 'GigabitEthernet0/1', expect: { aclIn: null } }), false);
});
run('verifyAll: quest yang tercapai otomatis selesai (RIP dst), quest-16 belum', () => {
  // RIP dikonfigurasi ulang (section OSPF membersihkan rip via 'no router rip')
  exec(r1, 'conf t');
  exec(r1, 'router rip');
  exec(r1, 'version 2');
  exec(r1, 'network 192.168.1.0');
  exec(r1, 'network 10.0.0.0');
  exec(r1, 'end');
  exec(r2, 'conf t');
  exec(r2, 'router rip');
  exec(r2, 'version 2');
  exec(r2, 'network 192.168.2.0');
  exec(r2, 'network 10.0.0.0');
  exec(r2, 'end');
  const q4 = defs16.find((x) => x.id === 'quest-4');
  const fails = q4.objectives.filter((o) => !qm.checkObjective(q4, o)).map((o) => o.id);
  assert.deepStrictEqual(fails, [], `quest-4 objektif belum tercapai: ${fails.join(', ')}`);
  const just = qm.verifyAll(world);
  assert.ok(qm.progress.completed.includes('quest-4'), 'quest-4 (RIP) harus selesai');
  assert.ok(qm.progress.xp >= 200);
  assert.ok(!qm.progress.completed.includes('quest-16'), 'quest-16 belum selesai (ACL masih menempel)');
  assert.ok(just.length >= 1);
});

console.log('\n== 22. Virtual Lab Pribadi ==');
const { executeLabCommand, createLabStore } = await import('../src/simulator/lab.js');
const labStore = createLabStore('/tmp/nq-labs-test');
const labState = { active: false, world: null, lastSpec: null, savedName: null, clientId: 'tester' };
const lab = (line) => executeLabCommand(labState, line, world, { store: labStore });
run('lab ? menampilkan bantuan', () => {
  const res = lab('lab ?');
  assert.match(res.output, /lab start/);
  assert.match(res.output, /lab connect/);
});
run('perintah lab tanpa mode lab ditolak', () => {
  const res = lab('lab add router R5');
  assert.match(res.error, /lab start/);
});
run('lab start: clone lab utama (6 perangkat, 5 kabel)', () => {
  const res = lab('lab start');
  assert.equal(res.labActive, true);
  assert.equal(labState.world.devices.size, 6);
  assert.equal(labState.world.links.length, 5);
  assert.match(res.output, /Mode lab pribadi aktif/);
});
run('lab status', () => {
  const res = lab('lab status');
  assert.match(res.output, /Perangkat: 6/);
});
run('lab add router R5 + connect ke R1 (kabel otomatis)', () => {
  const res = lab('lab add router R5');
  assert.match(res.output, /GigabitEthernet0\/0/);
  assert.equal(labState.world.devices.size, 7);
  // Gi0/2 belum ada pada R1 di lab — tambah dulu (variasi port ala NetCLI)
  const r1l = labState.world.devices.get('r1');
  parser.execute(r1l, 'enable', labState.world);
  parser.execute(r1l, 'conf t', labState.world);
  parser.execute(r1l, 'interface add gigabitethernet0/2', labState.world);
  parser.execute(r1l, 'end', labState.world);
  const res2 = lab('lab connect r5 g0/0 r1 g0/2');
  assert.match(res2.output, /Copper Cross-Over/);
  assert.equal(labState.world.links.length, 6);
});
run('konfigurasi & ping di lab world (terpisah dari lab utama)', () => {
  const r5 = labState.world.devices.get('r5');
  const r1l = labState.world.devices.get('r1');
  parser.execute(r5, 'enable', labState.world);
  parser.execute(r5, 'conf t', labState.world);
  parser.execute(r5, 'int g0/0', labState.world);
  parser.execute(r5, 'ip address 10.9.9.1 255.255.255.252', labState.world);
  parser.execute(r5, 'no shut', labState.world);
  parser.execute(r5, 'end', labState.world);
  parser.execute(r1l, 'enable', labState.world);
  parser.execute(r1l, 'conf t', labState.world);
  parser.execute(r1l, 'int g0/2', labState.world);
  parser.execute(r1l, 'ip address 10.9.9.2 255.255.255.252', labState.world);
  parser.execute(r1l, 'no shut', labState.world);
  parser.execute(r1l, 'end', labState.world);
  const st = parser.execute(r5, 'ping 10.9.9.2', labState.world);
  assert.match(st.output, /!!!!!/);
  // lab utama TIDAK berubah: r1 asli tidak punya Gi0/2 ber-IP
  assert.ok(!r1.interfaces['GigabitEthernet0/2']?.ip, 'Gi0/2 di lab utama harus tetap tanpa IP');
});
run('lab disconnect + remove', () => {
  let res = lab('lab disconnect r5 g0/0');
  assert.match(res.output, /Kabel dilepas/);
  assert.equal(labState.world.links.length, 5);
  res = lab('lab remove r5');
  assert.match(res.output, /dihapus/);
  assert.equal(labState.world.devices.size, 6);
});
run('lab save + list + load', () => {
  const res = lab('lab save lab-ujian');
  assert.match(res.output, /tersimpan/);
  const lst = lab('lab list');
  assert.match(lst.output, /lab-ujian/);
  lab('lab add pc PC9');
  assert.equal(labState.world.devices.size, 7);
  const res2 = lab('lab load lab-ujian');
  assert.equal(labState.world.devices.size, 6);
  assert.match(res2.output, /dimuat/);
});
run('lab reset kembali ke kondisi tersimpan', () => {
  lab('lab add pc PC9');
  const res = lab('lab reset');
  assert.equal(labState.world.devices.size, 6);
  assert.match(res.output, /dikembalikan/);
});
run('lab delete + exit; lab utama tidak terpengaruh', () => {
  const res = lab('lab delete lab-ujian');
  assert.match(res.output, /dihapus/);
  const res2 = lab('lab exit');
  assert.equal(res2.labActive, false);
  assert.equal(labState.world, null);
  assert.equal(world.devices.size, 6);
  assert.equal(world.links.length, 5);
  assert.equal(world.devices.get('pc2'), pc2);
});
run('lab start <nama> dari lab tersimpan (setelah save ulang)', () => {
  lab('lab start');
  lab('lab save lab-pribadi');
  lab('lab exit');
  const res = lab('lab start lab-pribadi');
  assert.match(res.output, /dimuat/);
  assert.equal(labState.world.devices.size, 6);
  lab('lab exit');
});

console.log(`\nSelesai: ${passed} assertions PASS. exitCode=${process.exitCode ?? 0}`);
