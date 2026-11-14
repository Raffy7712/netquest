/**
 * lab.js — Virtual Lab Pribadi: kanvas topologi milik pemain sendiri.
 *
 * Setiap koneksi WS bisa memasuki "mode lab" dengan `lab start`: dunia sesi
 * dibangun dari spesifikasi (clone topologi utama atau lab tersimpan), lalu
 * semua perintah CLI pemain dieksekusi di dunia sesi itu — tanpa mengganggu
 * lab utama & quest pemain lain. Lab tersimpan per clientId di data/labs/.
 *
 * executeLabCommand() adalah fungsi murni (tanpa IO) — dipakai ws.js maupun
 * test backend; IO penyimpanan diabstraksi via opts.store.
 */

import { CiscoDevice } from './CiscoDevice.js';
import { connectDevices, disconnectDevices, refreshOperStatus, linkStatuses } from './network.js';

/** Template interface default per tipe perangkat (variasi port ala NetCLI). */
function defaultInterfaces(type) {
  if (type === 'router') {
    return {
      'GigabitEthernet0/0': {}, 'GigabitEthernet0/1': {}, 'GigabitEthernet0/2': {}, 'GigabitEthernet0/3': {},
      'Serial0/0/0': {}, 'Serial0/1/0': {},
    };
  }
  if (type === 'switch') {
    const ifs = {};
    for (let i = 1; i <= 8; i++) ifs[`FastEthernet0/${i}`] = {};
    ifs['GigabitEthernet0/1'] = {};
    ifs['Vlan1'] = {};
    return ifs;
  }
  return { FastEthernet0: {}, GigabitEthernet0: {} };
}

/** Spesifikasi device baru untuk lab (id unik dari hostname). */
export function newDeviceSpec(type, hostname, x = 0, y = 0) {
  const id = hostname.toLowerCase();
  return {
    id,
    type,
    hostname,
    role: type === 'pc' ? 'pc' : undefined,
    info: { model: `Lab-${type}`, ios: '15.2' },
    interfaces: defaultInterfaces(type),
    node: { id, type, label: hostname, x, y },
  };
}

/**
 * Serialisasi world -> spesifikasi lab (JSON aman simpan).
 * Menyimpan konfigurasi penting: interface (ip/mask/up/desc/portType/clock),
 * rute, VLAN, ACL, service server, DHCP pool, role PC, logging host.
 */
export function serializeWorld(world) {
  const devices = [];
  for (const dev of world.devices.values()) {
    devices.push({
      id: dev.id,
      type: dev.type,
      hostname: dev.hostname,
      role: dev.role,
      info: dev.info,
      gw: dev.gw,
      interfaces: Object.fromEntries(
        Object.entries(dev.interfaces).map(([n, i]) => [n, {
          ip: i.ip, mask: i.mask, adminUp: i.adminUp, description: i.description,
          portType: i.portType, clockRate: i.clockRate ?? undefined,
        }])
      ),
      routes: dev.routes.map((r) => ({ ...r })),
      vlans: (dev.vlans || []).map((v) => ({ ...v })),
      acls: JSON.parse(JSON.stringify(dev.acls || {})),
      services: JSON.parse(JSON.stringify(dev.services || {})),
      dhcpPools: (dev.dhcpPools || []).map((p) => ({ ...p })),
      dhcpExcluded: (dev.dhcpExcluded || []).map((e) => ({ ...e })),
      vlanPriorities: { ...(dev.vlanPriorities || {}) },
      loggingHost: dev.loggingHost ?? undefined,
      ssh: { domain: dev.ssh?.domain ?? undefined, keyModulus: dev.ssh?.keyModulus ?? undefined },
      ntpServer: dev.ntpServer ?? undefined,
    });
  }
  return {
    version: 1,
    devices,
    links: world.links.map((l) => ({
      a: { device: l.a.device, interface: l.a.interface },
      b: { device: l.b.device, interface: l.b.interface },
    })),
    nodes: nodeMetaList(world).map((n) => ({ id: n.id, type: n.type, label: n.label, x: n.x, y: n.y })),
    meta: { name: world.meta?.name ?? 'Lab Pribadi', canvas: world.meta?.canvas },
  };
}

/**
 * Bangun world sesi dari spesifikasi. Struktur identik dengan buildWorld()
 * sehingga parser, ping, VLAN, DHCP, dsb. bekerja tanpa perubahan.
 */
export function buildLabWorld(spec) {
  const devices = new Map();
  for (const d of spec.devices) {
    const dev = new CiscoDevice(d);
    for (const [name, cfg] of Object.entries(d.interfaces || {})) {
      const ifc = dev.ensureInterface(name);
      if ('ip' in cfg) ifc.ip = cfg.ip;
      if ('mask' in cfg) ifc.mask = cfg.mask;
      if ('adminUp' in cfg) ifc.adminUp = cfg.adminUp !== false;
      if ('description' in cfg) ifc.description = cfg.description;
      if (cfg.portType) ifc.portType = cfg.portType;
      if (cfg.clockRate) ifc.clockRate = cfg.clockRate;
    }
    dev.routes = (d.routes || []).map((r) => ({ ...r }));
    dev.vlans = (d.vlans || []).map((v) => ({ ...v }));
    dev.acls = JSON.parse(JSON.stringify(d.acls || {}));
    if (d.services) {
      for (const [k, v] of Object.entries(d.services)) {
        if (dev.services[k]) dev.services[k] = { ...dev.services[k], ...JSON.parse(JSON.stringify(v)) };
      }
    }
    dev.dhcpPools = (d.dhcpPools || []).map((p) => ({ ...p }));
    dev.dhcpExcluded = (d.dhcpExcluded || []).map((e) => ({ ...e }));
    dev.vlanPriorities = { ...(d.vlanPriorities || {}) };
    dev.loggingHost = d.loggingHost ?? null;
    if (d.ssh) dev.ssh = { ...dev.ssh, ...d.ssh };
    dev.ntpServer = d.ntpServer ?? null;
    devices.set(dev.id, dev);
  }
  const nodeMeta = new Map();
  for (const n of spec.nodes || []) nodeMeta.set(n.id, { ...n });
  const world = {
    devices,
    links: (spec.links || []).map((l) => ({
      a: { device: l.a.device, interface: l.a.interface },
      b: { device: l.b.device, interface: l.b.interface },
    })),
    nodeMeta,
    meta: spec.meta || { name: 'Lab Pribadi' },
    bootTime: Date.now(),
  };
  refreshOperStatus(world);
  return world;
}

/** Topologi (nodes+links+devices) untuk dikirim ke frontend saat lab berubah. */
function nodeMetaList(world) {
  const nm = world.nodeMeta;
  return Array.isArray(nm) ? nm : [...nm.values()];
}

export function labTopologyPayload(world, active) {
  return {
    active,
    meta: { name: world.meta?.name ?? 'Lab Pribadi', canvas: world.meta?.canvas },
    nodes: nodeMetaList(world),
    links: world.links.map((l) => ({
      a: { device: l.a.device, interface: l.a.interface },
      b: { device: l.b.device, interface: l.b.interface },
    })),
    devices: [...world.devices.values()].map((d) => d.toSummary()),
    linkStatuses: linkStatuses(world),
  };
}

/* ---------------- penyimpanan lab (data/labs/<clientId>.json) ---------------- */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export function createLabStore(labsDir) {
  mkdirSync(labsDir, { recursive: true });
  const fileFor = (clientId) => path.join(labsDir, `${String(clientId).replace(/[^a-z0-9_-]/gi, '_')}.json`);
  const readAll = (clientId) => {
    const f = fileFor(clientId);
    if (!existsSync(f)) return {};
    try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return {}; }
  };
  return {
    save(clientId, name, spec) {
      const all = readAll(clientId);
      all[name] = spec;
      writeFileSync(fileFor(clientId), JSON.stringify(all, null, 2));
    },
    load(clientId, name) {
      return readAll(clientId)[name] ?? null;
    },
    list(clientId) {
      const all = readAll(clientId);
      return Object.entries(all).map(([name, spec]) => ({
        name,
        devices: spec.devices?.length ?? 0,
        links: spec.links?.length ?? 0,
      }));
    },
    delete(clientId, name) {
      const all = readAll(clientId);
      if (!(name in all)) return false;
      delete all[name];
      writeFileSync(fileFor(clientId), JSON.stringify(all, null, 2));
      return true;
    },
  };
}

/* ---------------- perintah `lab ...` ---------------- */

const LAB_HELP = [
  'Perintah Virtual Lab Pribadi (kanvas milikmu — lab utama & quest tidak terganggu):',
  '',
  '  lab start            Masuk mode lab (clone topologi utama, kondisi bersih)',
  '  lab start <nama>     Masuk mode lab dari lab tersimpan',
  '  lab add <router|switch|pc> <nama>   Tambah perangkat baru',
  '  lab remove <nama>    Hapus perangkat (+ semua kabelnya)',
  '  lab connect <dev1> <if1> <dev2> <if2>   Sambungkan port (kabel otomatis)',
  '  lab disconnect <dev1> <if1>   Lepas kabel',
  '  lab save <nama>      Simpan lab pribadi (per browser-mu)',
  '  lab list             Daftar lab tersimpan',
  '  lab load <nama>      Muat lab tersimpan ke kanvas',
  '  lab delete <nama>    Hapus lab tersimpan',
  '  lab reset            Kembalikan kanvas ke kondisi terakhir disimpan/masuk',
  '  lab exit             Keluar ke lab utama (quest kembali aktif)',
  '  lab status           Info kanvas aktif',
];

/**
 * Jalankan satu perintah `lab ...`.
 * state: {active, world (lab aktif atau null), lastSpec, clientId}
 * masterWorld: world utama (untuk `lab start` clone).
 * opts: {store, onTopology?} — store wajib utk save/list/load/delete.
 * Return {output, worldChanged?, labActive?, error?, topology?}
 */
export function executeLabCommand(state, line, masterWorld, opts = {}) {
  const parts = line.trim().split(/\s+/);
  const sub = (parts[1] || 'status').toLowerCase();
  const rest = parts.slice(2);
  const store = opts.store;

  if (sub === 'help' || sub === '?') return { output: LAB_HELP.join('\n') };

  if (sub === 'status') {
    if (!state.active) return { output: 'Mode lab aktif: TIDAK (lab utama). Masuk dengan `lab start`.' };
    const d = state.world.devices.size;
    return {
      output: [
        `Mode lab aktif: YA — "${state.world.meta?.name ?? 'Lab Pribadi'}"`,
        `Perangkat: ${d} | Kabel: ${state.world.links.length}`,
        ...(state.savedName ? [`Muatan dari lab tersimpan: ${state.savedName}`] : []),
      ].join('\n'),
    };
  }

  if (sub === 'start') {
    const name = rest[0];
    let spec;
    if (name) {
      if (!store) return { error: 'Penyimpanan lab tidak tersedia.' };
      spec = store.load(state.clientId, name);
      if (!spec) return { error: `Lab '${name}' tidak ada di daftar lab-mu (lihat: lab list).` };
    } else {
      spec = serializeWorld(masterWorld);
      // Clone kondisi BERSIH: konfigurasi interface/kabel dari topologi utama
      // dipertahankan, kerusakan quest & konfigurasi runtime pemain tidak ikut
      // (masterWorld world utama sudah berisi perubahan pemain — acceptable:
      // pemain melanjutkan dari kondisi lab utama saat itu).
    }
    state.world = buildLabWorld(spec);
    state.active = true;
    state.savedName = name ?? null;
    state.lastSpec = spec;
    return {
      output: name
        ? `Lab '${name}' dimuat. Kanvas pribadi aktif — quest utama dijeda selama mode lab (ketik 'lab exit' untuk kembali).`
        : `Mode lab pribadi aktif (clone lab utama). Tambah perangkat: 'lab add router R5'. Ketik 'lab ?' untuk bantuan.`,
      worldChanged: true,
      labActive: true,
      topology: labTopologyPayload(state.world, true),
    };
  }

  if (!state.active) {
    return { error: `Perintah 'lab ${sub}' butuh mode lab. Masuk dulu dengan 'lab start'.` };
  }

  if (sub === 'add') {
    const type = (rest[0] || '').toLowerCase();
    const hostname = rest[1];
    if (!['router', 'switch', 'pc'].includes(type) || !hostname) {
      return { error: "Pakai: lab add <router|switch|pc> <nama> (contoh: lab add router R5)" };
    }
    const id = hostname.toLowerCase();
    if (state.world.devices.has(id)) return { error: `Perangkat '${hostname}' sudah ada di kanvas.` };
    const existing = state.world.nodeMeta.size;
    const x = -420 + (existing % 4) * 280;
    const y = existing < 4 ? 180 : 320;
    const spec = newDeviceSpec(type, hostname, x, y);
    const dev = new CiscoDevice(spec);
    state.world.devices.set(dev.id, dev);
    state.world.nodeMeta.set(id, spec.node);
    refreshOperStatus(state.world);
    return {
      output: `Perangkat ${hostname} (${type}) ditambahkan. Port bawaan: ${Object.keys(dev.interfaces).join(', ')}\nSambungkan dengan: lab connect ${hostname.toLowerCase()} <if> <dev2> <if2>`,
      worldChanged: true,
      topology: labTopologyPayload(state.world, true),
    };
  }

  if (sub === 'remove') {
    const id = (rest[0] || '').toLowerCase();
    const dev = state.world.devices.get(id);
    if (!dev) return { error: `Perangkat '${rest[0]}' tidak ada di kanvas.` };
    const before = state.world.links.length;
    state.world.links = state.world.links.filter((l) => l.a.device !== id && l.b.device !== id);
    const cablesRemoved = before - state.world.links.length;
    state.world.devices.delete(id);
    state.world.nodeMeta.delete(id);
    refreshOperStatus(state.world);
    return {
      output: `Perangkat ${dev.hostname} dihapus${cablesRemoved ? ` (+${cablesRemoved} kabel dilepas)` : ''}.`,
      worldChanged: true,
      topology: labTopologyPayload(state.world, true),
    };
  }

  if (sub === 'connect' || sub === 'disconnect') {
    const a = (rest[0] || '').toLowerCase();
    const ifA = rest[1];
    if (sub === 'disconnect') {
      const dev = state.world.devices.get(a);
      if (!dev) return { error: `Perangkat '${rest[0]}' tidak ada di kanvas.` };
      const ifName = dev.normalizeInterfaceName(ifA) || ifA;
      const removed = disconnectDevices(state.world, dev, ifName);
      if (!removed) return { error: `Tidak ada kabel di ${dev.hostname}:${ifName}.` };
      return {
        output: `Kabel dilepas dari ${dev.hostname}:${ifName}.`,
        worldChanged: true,
        topology: labTopologyPayload(state.world, true),
      };
    }
    const ifNameA = state.world.devices.get(a)?.normalizeInterfaceName(ifA) || ifA;
    const bId = (rest[2] || '').toLowerCase();
    const ifB = rest[3];
    const devA = state.world.devices.get(a);
    const devB = state.world.devices.get(bId);
    if (!devA || !devB) return { error: 'Perangkat tidak ditemukan di kanvas (cek: lab status).' };
    const ifNameB = devB.normalizeInterfaceName(ifB) || ifB;
    const res = connectDevices(state.world, devA, ifNameA, devB, ifNameB);
    if (!res.ok) return { error: `% Kabel gagal: ${res.error}` };
    return {
      output: `Kabel terpasang: ${devA.hostname}:${ifNameA} <-> ${devB.hostname}:${ifNameB}\nJenis kabel (otomatis): ${res.cable}`,
      worldChanged: true,
      topology: labTopologyPayload(state.world, true),
    };
  }

  if (sub === 'save') {
    const name = rest[0];
    if (!name) return { error: 'Pakai: lab save <nama>' };
    if (!store) return { error: 'Penyimpanan lab tidak tersedia.' };
    store.save(state.clientId, name, serializeWorld(state.world));
    state.savedName = name;
    state.lastSpec = serializeWorld(state.world);
    return { output: `Lab tersimpan sebagai '${name}' (milik sesi browser-mu).` };
  }

  if (sub === 'list') {
    if (!store) return { error: 'Penyimpanan lab tidak tersedia.' };
    const labs = store.list(state.clientId);
    if (!labs.length) return { output: 'Belum ada lab tersimpan. Simpan dengan: lab save <nama>' };
    return { output: ['Lab tersimpan (milikmu):', ...labs.map((l) => `  ${l.name.padEnd(20)} ${l.devices} perangkat, ${l.links} kabel`)].join('\n') };
  }

  if (sub === 'load' || sub === 'delete') {
    const name = rest[0];
    if (!name) return { error: `Pakai: lab ${sub} <nama>` };
    if (!store) return { error: 'Penyimpanan lab tidak tersedia.' };
    if (sub === 'delete') {
      const ok = store.delete(state.clientId, name);
      return ok ? { output: `Lab '${name}' dihapus.` } : { error: `Lab '${name}' tidak ada.` };
    }
    const spec = store.load(state.clientId, name);
    if (!spec) return { error: `Lab '${name}' tidak ada (lihat: lab list).` };
    state.world = buildLabWorld(spec);
    state.savedName = name;
    state.lastSpec = spec;
    return {
      output: `Lab '${name}' dimuat ke kanvas (${spec.devices.length} perangkat, ${spec.links.length} kabel).`,
      worldChanged: true,
      labActive: true,
      topology: labTopologyPayload(state.world, true),
    };
  }

  if (sub === 'reset') {
    if (!state.lastSpec) return { error: 'Tidak ada kondisi tersimpan untuk reset (pakai lab save dulu).' };
    state.world = buildLabWorld(state.lastSpec);
    return {
      output: 'Kanvas dikembalikan ke kondisi terakhir yang disimpan/muat.',
      worldChanged: true,
      topology: labTopologyPayload(state.world, true),
    };
  }

  if (sub === 'exit') {
    state.active = false;
    state.world = null;
    state.savedName = null;
    return {
      output: 'Kembali ke lab utama. Quest & XP aktif kembali.',
      worldChanged: true,
      labActive: false,
      exitLab: true,
    };
  }

  return { error: `Perintah lab '${sub}' tidak dikenal. Ketik 'lab ?' untuk bantuan.` };
}
