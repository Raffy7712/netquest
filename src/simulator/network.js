/**
 * network.js — "dunia" simulasi: kumpulan device + link topologi,
 * status link, tabel routing dinamis, dan mesin ping end-to-end.
 *
 * Ping benar-benar mengikuti aturan routing: connected -> static (longest
 * prefix match) -> gateway, termasuk mengecek RUTE BALIK dari target
 * (penyebab paling umum ping gagal di lab CCNA).
 */

import { CiscoDevice, portTypeOf } from './CiscoDevice.js';
import { ipToInt, intToIp, networkOf, inSubnet, maskToPrefix, isValidIp } from './ip.js';
import { computeDynamicRoutes, AD } from './routing-protocols.js';
import { vlanReachable, switchportOf, aclPermits } from './l2-services.js';

export const ipHelpers = { ipToInt, intToIp, networkOf, inSubnet, maskToPrefix, isValidIp };

/**
 * Bangun world dari devices.json + topology.json.
 * world = { devices: Map<id, CiscoDevice>, links: [{a, b}], nodeMeta, linkMeta }
 */
export function buildWorld(devicesJson, topologyJson) {
  const devices = new Map();
  for (const d of devicesJson.devices) {
    const dev = new CiscoDevice(d);
    devices.set(d.id, dev);
  }

  const links = topologyJson.links.map((l) => ({
    a: { device: l.a.device, interface: l.a.interface },
    b: { device: l.b.device, interface: l.b.interface },
  }));

  const world = {
    devices, links, nodeMeta: topologyJson.nodes,
    meta: topologyJson.meta || {},
    bootTime: Date.now(), // dipakai utk uptime rute dinamis di `show ip route`
  };
  // Snapshot kondisi pabrik per device — dipakai reset/reload tanpa startup.
  for (const dev of devices.values()) dev.captureFactoryState();
  refreshOperStatus(world);
  return world;
}

/**
 * Bangun ulang seluruh world dari data mentah (tombol "Reset" di UI):
 * kondisi quest awal disuntikkan ulang, XP/startup-config di-nol-kan.
 */
export function resetWorld(devicesJson, topologyJson, questsJson) {
  const world = buildWorld(devicesJson, topologyJson);
  applyInitialConditions(world, questsJson.quests);
  // factoryConfig harus mencerminkan kondisi SETELAH injeksi quest awal.
  for (const dev of world.devices.values()) dev.captureFactoryState();
  refreshOperStatus(world);
  return world;
}

/** Terapkan kondisi awal quest (kondisi_awal) ke world. Idempoten. */
export function applyInitialConditions(world, quests) {
  for (const q of quests) {
    for (const init of q.initial || []) {
      const dev = world.devices.get(init.device);
      if (!dev) continue;
      if (init.interface) {
        const { name, ...patch } = init.interface;
        const ifc = dev.ensureInterface(dev.normalizeInterfaceName(name) || name);
        if ('adminUp' in patch) ifc.adminUp = !!patch.adminUp;
        if ('ip' in patch) ifc.ip = patch.ip;
        if ('mask' in patch) ifc.mask = patch.mask;
        if ('description' in patch) ifc.description = patch.description;
      }
      // Sabotase troubleshooting: rute statis salah yang harus dihapus pemain.
      if (init.route) dev.routes.push({ ...init.route });
      // Sabotase troubleshooting: ACL yang memblokir lalu lintas tertentu.
      if (init.acl) {
        dev.acls[init.acl.number] = (init.acl.rules || []).map((r) => ({ ...r }));
        if (init.acl.interface) {
          const ifc = dev.ensureInterface(dev.normalizeInterfaceName(init.acl.interface) || init.acl.interface);
          if (init.acl.direction === 'out') ifc.aclOut = init.acl.number;
          else ifc.aclIn = init.acl.number;
        }
      }
    }
  }
  refreshOperStatus(world);
}

/**
 * Jenis kabel otomatis untuk dua port (ala Packet Tracer):
 * - Serial <-> Serial        : 'Serial DCE/DTE' (sisi a dianggap DCE)
 * - Ethernet beda kelas      : 'Copper Straight-Through' (PC/router <-> switch)
 * - Ethernet satu kelas      : 'Copper Cross-Over' (router<->router, pc<->pc, sw<->sw)
 * Return null bila tidak kompatibel (ethernet <-> serial, dst).
 */
export function cableTypeBetween(devA, ifNameA, devB, ifNameB) {
  const ia = devA.interfaces[ifNameA];
  const ib = devB.interfaces[ifNameB];
  if (!ia || !ib) return null;
  const family = (p) => (p === 'Serial' ? 'serial' : p === 'Vlan (SVI)' ? 'svi' : 'ethernet');
  const fa = family(ia.portType || portTypeOf(ifNameA));
  const fb = family(ib.portType || portTypeOf(ifNameB));
  if (fa !== fb) return null; // ethernet vs serial tidak bisa tersambung
  if (fa === 'serial') return 'Serial DCE/DTE';
  if (fa === 'svi') return null; // SVI bukan port fisik
  const clsA = devA.type === 'switch' ? 'switch' : 'host';
  const clsB = devB.type === 'switch' ? 'switch' : 'host';
  return clsA === clsB ? 'Copper Cross-Over' : 'Copper Straight-Through';
}

/** Kompabilitas port utk connect: tipe sama & kabel bisa ditentukan. */
export function portsCompatible(devA, ifNameA, devB, ifNameB) {
  return cableTypeBetween(devA, ifNameA, devB, ifNameB) !== null;
}

/**
 * Hubungkan dua port saat runtime (perintah `connect` di privileged EXEC).
 * Validasi: port ada & adminUp, belum ter-link, dan kompatibel (kabel otomatis).
 * Link runtime hilang saat reset lab (topologi dasar kembali).
 */
export function connectDevices(world, devA, ifNameA, devB, ifNameB) {
  const ia = devA?.interfaces[ifNameA];
  const ib = devB?.interfaces[ifNameB];
  if (!devA || !devB) return { ok: false, error: 'perangkat tidak ditemukan' };
  if (!ia) return { ok: false, error: `port ${ifNameA} tidak ada di ${devA.hostname} (tambah dulu: interface add)` };
  if (!ib) return { ok: false, error: `port ${ifNameB} tidak ada di ${devB.hostname} (tambah dulu: interface add)` };
  if (!ia.adminUp || !ib.adminUp) return { ok: false, error: 'kedua port harus tidak shutdown' };
  // Kompatibilitas port lebih dulu (pesan kabel lebih jelas daripada 'busy').
  const cable = cableTypeBetween(devA, ifNameA, devB, ifNameB);
  if (!cable) return { ok: false, error: `kabel tidak kompatibel: ${ia.portType} <-> ${ib.portType}` };
  const busy = world.links.find(
    (l) => (l.a.device === devA.id && l.a.interface === ifNameA) ||
           (l.b.device === devA.id && l.b.interface === ifNameA) ||
           (l.a.device === devB.id && l.b.interface === ifNameB) ||
           (l.b.device === devB.id && l.b.interface === ifNameB)
  );
  if (busy) return { ok: false, error: 'salah satu port sudah terpakai di link lain' };
  world.links.push({ a: { device: devA.id, interface: ifNameA }, b: { device: devB.id, interface: ifNameB }, runtime: true });
  refreshOperStatus(world);
  return { ok: true, cable };
}

/** Lepas link yang menempel pada (device, interface). */
export function disconnectDevices(world, dev, ifName) {
  const before = world.links.length;
  world.links = world.links.filter(
    (l) => !((l.a.device === dev.id && l.a.interface === ifName) || (l.b.device === dev.id && l.b.interface === ifName))
  );
  if (world.links.length !== before) refreshOperStatus(world);
  return before - world.links.length;
}

/**
 * Resolusi hostname -> IP:
 * 1) DNS statis di world.meta.dns {name: ip}
 * 2) record dinamis di device role server dg service DNS on
 * Return ip | null.
 */
export function resolveHostname(world, name) {
  const lower = String(name || '').toLowerCase();
  const staticDns = world.meta?.dns || {};
  for (const [k, v] of Object.entries(staticDns)) {
    if (k.toLowerCase() === lower || `${k}.local`.toLowerCase() === lower) return v;
  }
  for (const dev of world.devices.values()) {
    if (dev.type !== 'pc' || dev.role !== 'server') continue;
    if (!dev.services?.dns?.on) continue;
    for (const rec of dev.services.dns.records) {
      if (rec.name.toLowerCase() === lower || `${rec.name}.local`.toLowerCase() === lower) return rec.ip;
    }
  }
  return null;
}

/**
 * Terbitkan pesan syslog ala IOS: tersimpan di buffer lokal device
 * (`show logging`) dan diteruskan ke loggingHost (server dg service syslog on).
 */
export function pushSyslog(world, dev, text) {
  if (!dev.loggingBuffer) dev.loggingBuffer = [];
  const entry = { since: new Date().toISOString(), text: `%SYS-5-CONFIG: ${text}` };
  dev.loggingBuffer.push(entry);
  if (dev.loggingBuffer.length > 100) dev.loggingBuffer.shift();
  const serverIp = dev.loggingHost;
  if (!serverIp) return;
  const server = findDeviceByIp(world, serverIp)?.device;
  if (!server || server.type !== 'pc' || server.role !== 'server' || !server.services?.syslog?.on) return;
  server.services.syslog.log.push({ since: entry.since, host: dev.hostname, text: entry.text });
  if (server.services.syslog.log.length > 200) server.services.syslog.log.shift();
}

/**
 * operUp (layer 1/2): interface up jika administratively up DAN punya link
 * ke perangkat lain yang ujungnya juga administratively up.
 * Di-refresh setiap kali ada command yang mengubah state.
 */
export function refreshOperStatus(world) {
  for (const dev of world.devices.values()) {
    for (const ifc of Object.values(dev.interfaces)) ifc.operUp = false;
  }
  for (const link of world.links) {
    const da = world.devices.get(link.a.device);
    const db = world.devices.get(link.b.device);
    if (!da || !db) continue;
    const ia = da.interfaces[link.a.interface];
    const ib = db.interfaces[link.b.interface];
    if (!ia || !ib) continue;
    if (ia.adminUp && ib.adminUp) {
      ia.operUp = true;
      ib.operUp = true;
    }
  }
}

/** Cari perangkat + interface yang memakai IP tertentu (semua tipe device). */
export function findDeviceByIp(world, ip) {
  for (const dev of world.devices.values()) {
    for (const [name, ifc] of Object.entries(dev.interfaces)) {
      if (ifc.ip && ifc.ip === ip) return { device: dev, interface: name };
    }
  }
  return null;
}

/** Perangkat tetangga lewat sebuah interface (berdasarkan link topologi). */
export function neighborOf(world, deviceId, ifName) {
  for (const link of world.links) {
    if (link.a.device === deviceId && link.a.interface === ifName)
      return { device: world.devices.get(link.b.device), interface: link.b.interface };
    if (link.b.device === deviceId && link.b.interface === ifName)
      return { device: world.devices.get(link.a.device), interface: link.a.interface };
  }
  return null;
}

/** Status link untuk pewarnaan topologi di frontend. */
export function linkStatuses(world) {
  return world.links.map((l, idx) => {
    const da = world.devices.get(l.a.device);
    const db = world.devices.get(l.b.device);
    const ia = da?.interfaces[l.a.interface];
    const ib = db?.interfaces[l.b.interface];
    const cable = da && db ? cableTypeBetween(da, l.a.interface, db, l.b.interface) : null;
    return {
      id: idx,
      a: `${l.a.device}:${l.a.interface}`,
      b: `${l.b.device}:${l.b.interface}`,
      up: !!(ia?.adminUp && ib?.adminUp),
      cable,
      runtime: !!l.runtime,
    };
  });
}

/**
 * Tabel routing DINAMIS sebuah router: C (connected) + L (local) dari
 * interface yang up ber-IP, S (static) dari device.routes, plus rute
 * dinamis R (RIP) / O (OSPF) / D (EIGRP) dari engine protokol.
 * Kompetisi antar sumber per prefix: AD terendah menang
 * (static 1 < EIGRP 90 < OSPF 110 < RIP 120).
 */
export function routingTable(world, device) {
  const rows = [];
  if (!device.isRouter) return rows;
  for (const [name, ifc] of Object.entries(device.interfaces)) {
    if (ifc.ip && ifc.mask && ifc.operUp) {
      rows.push({
        type: 'C',
        network: networkOf(ifc.ip, ifc.mask),
        mask: ifc.mask,
        prefix: maskToPrefix(ifc.mask),
        interface: name,
        via: null,
        distance: 0,
      });
      rows.push({
        type: 'L',
        network: ifc.ip,
        mask: '255.255.255.255',
        prefix: 32,
        interface: name,
        via: null,
        distance: 0,
      });
    }
  }
  for (const r of device.routes) {
    rows.push({
      type: 'S',
      network: r.network,
      mask: r.mask,
      prefix: maskToPrefix(r.mask),
      interface: null,
      via: r.nextHop,
      distance: AD.static,
      metric: 0,
    });
  }
  // Rute dinamis dari engine protokol (RIP/OSPF/EIGRP/BGP), on-demand & selalu segar.
  for (const dyn of computeDynamicRoutes(world).get(device.id) || []) {
    const key = `${dyn.network}|${dyn.mask}`;
    // Rute statis / connected untuk prefix yang sama menang (AD lebih rendah).
    const covered = rows.some(
      (r) => (r.type === 'C' || r.type === 'S') && r.network === dyn.network && r.mask === dyn.mask
    );
    if (covered) continue;
    const letter = { rip: 'R', ospf: 'O', eigrp: 'D', bgp: 'B' }[dyn.protocol] ?? '?';
    rows.push({
      type: letter,
      network: dyn.network,
      mask: dyn.mask,
      prefix: dyn.prefix,
      interface: dyn.interface,
      via: dyn.via,
      distance: dyn.distance,
      metric: dyn.metric,
      rd: dyn.rd ?? null,
      procLabel: dyn.procLabel,
      from: dyn.from ?? null,
      asPath: dyn.asPath ?? null,
    });
  }
  rows.sort((x, y) => ipToInt(networkOf(x.network, x.mask)) - ipToInt(networkOf(y.network, y.mask)));
  return rows;
}

/**
 * Resolusi satu lompatan routing dari `device` menuju `dstIp`.
 * Return {kind: 'connected'|'static'|'gateway'|'none', interface, nextHopIp?}
 * - connected: tujuan ada di subnet interface yang up.
 * - static: longest-prefix match rute statis (next-hop harus reachable).
 * - gateway: hanya PC — kirim ke default gateway (perilaku end host).
 */
function resolveHop(world, device, dstIp) {
  // 1. Tujuan ada di subnet interface yang up -> connected.
  for (const [name, ifc] of Object.entries(device.interfaces)) {
    if (ifc.ip && ifc.mask && ifc.operUp && inSubnet(dstIp, networkOf(ifc.ip, ifc.mask), ifc.mask)) {
      return { kind: 'connected', interface: name, nextHopIp: dstIp };
    }
  }
  if (!device.isRouter) {
    // PC/switch tidak melakukan routing; PC meneruskan ke default gateway.
    if (device.isPc && device.gw) {
      for (const [name, ifc] of Object.entries(device.interfaces)) {
        if (ifc.ip && ifc.mask && ifc.operUp && inSubnet(device.gw, networkOf(ifc.ip, ifc.mask), ifc.mask)) {
          return { kind: 'gateway', interface: name, nextHopIp: device.gw };
        }
      }
    }
    return { kind: 'none' };
  }

  // 2. Longest-prefix match pada rute statis + dinamis (RIP/OSPF/EIGRP).
  //    Tie panjang prefix -> AD terendah menang (static 1 < EIGRP < OSPF < RIP).
  const staticRoutes = device.routes.map((r) => ({ network: r.network, mask: r.mask, nextHop: r.nextHop, distance: AD.static }));
  const dynRoutes = (computeDynamicRoutes(world).get(device.id) || [])
    .map((r) => ({ network: r.network, mask: r.mask, nextHop: r.via, distance: r.distance }));
  let best = null;
  for (const r of [...staticRoutes, ...dynRoutes]) {
    if (!inSubnet(dstIp, r.network, r.mask)) continue;
    const p = maskToPrefix(r.mask);
    if (!best || p > best.prefixLen || (p === best.prefixLen && r.distance < best.distance)) {
      best = { ...r, prefixLen: p };
    }
  }
  if (best) {
    // next-hop harus bisa dicapai lewat interface connected yang up.
    for (const [name, ifc] of Object.entries(device.interfaces)) {
      if (ifc.ip && ifc.mask && ifc.operUp && inSubnet(best.nextHop, networkOf(ifc.ip, ifc.mask), ifc.mask)) {
        return { kind: 'static', interface: name, nextHopIp: best.nextHop };
      }
    }
    return { kind: 'none' }; // rute menunjuk next-hop yang tidak terhubung
  }
  return { kind: 'none' };
}

/** Catat frame ke captureLog device (utk `show capture` & export .pcap). */
function capture(device, entry) {
  if (!device.captureLog) device.captureLog = [];
  device.captureLog.push(entry);
  if (device.captureLog.length > 300) device.captureLog.splice(0, device.captureLog.length - 300);
}

/** Upser entri translasi NAT di router (utk `show ip nat translations`). */
function upsertNatTranslation(router, t) {
  if (!router.natTranslations) router.natTranslations = [];
  const found = router.natTranslations.find(
    (x) => x.insideLocal === t.insideLocal && x.outsideLocal === t.outsideLocal && x.insideGlobal === t.insideGlobal
  );
  if (found) found.since = new Date().toISOString();
  else {
    router.natTranslations.push({ ...t, since: new Date().toISOString() });
    if (router.natTranslations.length > 50) router.natTranslations.shift();
  }
}

/**
 * Mesin ping end-to-end. Mengembalikan:
 * {ok, reason, srcIp, hops:[{from, via, kind}]} — reason untuk pesan diagnostik.
 *
 * Algoritma: telusuri hop-by-hop (maks 8 lompatan) sampai mencapai device
 * pemilik IP tujuan, lalu pastikan target punya rute balik ke IP sumber
 * (penyebab klasik ping gagal di lab CCNA walau rute ke depan sudah benar).
 * Hooks ala NetSim: domain VLAN (L2), ACL standar di interface router,
 * NAT/PAT overload (rewriting sumber), dan pencatatan frame utk `show capture`.
 */
export function pingFrom(world, srcDevice, targetIp, _srcIpOverride = null) {
  const result = { ok: false, reason: null, srcIp: null, hops: [] };

  if (!isValidIp(targetIp)) {
    result.reason = 'invalid-address';
    return result;
  }

  let current = srcDevice;
  let arrivedOn = null;   // interface pada `current` tempat paket masuk (null utk asal)
  let origSrcIp = null;   // IP sumber asli (sebelum NAT)
  const visited = new Set([srcDevice.id]);

  for (let hop = 0; hop < 8; hop++) {
    // Sampai tujuan? Device saat ini memegang IP target di salah satu interfacenya.
    const ownEntry = Object.entries(current.interfaces).find(([, i]) => i.ip === targetIp);
    if (ownEntry) {
      const [, ifc] = ownEntry;
      if (!ifc.adminUp) { result.reason = 'dest-interface-down'; return result; }
      // ACL ingress di device tujuan (bila router).
      if (current.isRouter && arrivedOn) {
        const aclNum = current.interfaces[arrivedOn]?.aclIn;
        if (aclNum != null && result.srcIp && !aclPermits(current.acls?.[aclNum], result.srcIp)) {
          result.reason = 'acl-denied';
          return result;
        }
      }
      // Ping ke diri sendiri: tidak perlu cek rute balik.
      if (result.srcIp && current.id !== srcDevice.id) {
        const reverse = resolveHop(world, current, result.srcIp);
        if (reverse.kind === 'none') { result.reason = 'no-return-route'; return result; }
      }
      result.ok = true;
      recordReply(world, srcDevice, current, targetIp, result.srcIp, result.hops, origSrcIp ?? result.srcIp);
      return result;
    }

    // Belum sampai: resolve rute dari device saat ini.
    const route = resolveHop(world, current, targetIp);
    if (route.kind === 'none') {
      result.reason = visited.size === 1 ? 'no-route' : 'unreachable';
      return result;
    }
    const ifc = current.interfaces[route.interface];
    if (!ifc?.operUp) { result.reason = 'link-down'; return result; }

    // IP sumber = IP interface keluar di perangkat asal (source selection IOS).
    if (!result.srcIp) {
      result.srcIp = ifc.ip;
      if (!result.srcIp) { result.reason = 'no-source-address'; return result; }
      origSrcIp = result.srcIp;
    }

    // Perangkat berikutnya = pemilik IP next-hop (connected: tujuan; gateway/static: router).
    const nextEntry = findDeviceByIp(world, route.nextHopIp);
    if (!nextEntry) { result.reason = 'unreachable'; return result; }
    const nextDevice = nextEntry.device;
    if (visited.has(nextDevice.id)) { result.reason = 'unreachable'; return result; }

    // Domain VLAN: L2 path harus membawa VLAN yang sama (access/trunk).
    if (
      (current.type === 'switch' || nextDevice.type === 'switch' || srcDevice.type === 'pc') &&
      !vlanReachable(world, current, route.interface, nextDevice, nextEntry.interface)
    ) {
      result.reason = 'vlan-blocked';
      return result;
    }

    // Router hop: ACL ingress (interface masuk) & egress (interface keluar).
    if (current.isRouter) {
      const aclIn = arrivedOn ? current.interfaces[arrivedOn]?.aclIn : null;
      const aclOut = current.interfaces[route.interface]?.aclOut;
      if ((aclIn != null && !aclPermits(current.acls?.[aclIn], result.srcIp)) ||
          (aclOut != null && !aclPermits(current.acls?.[aclOut], result.srcIp))) {
        result.reason = 'acl-denied';
        return result;
      }

      // NAT/PAT overload: masuk dari interface inside, keluar di outside,
      // sumber cocok dengan ACL rule -> sumber ditulis ulang jadi IP outside.
      for (const rule of current.natRules || []) {
        const outsideIfc = current.interfaces[rule.outsideIf];
        if (!outsideIfc?.ip || !outsideIfc?.operUp) continue;
        const isInsideIn = arrivedOn ? current.interfaces[arrivedOn]?.nat === 'inside' : false;
        const isOutsideOut = current.interfaces[rule.outsideIf]?.nat === 'outside' && route.interface === rule.outsideIf;
        if (isInsideIn && isOutsideOut && aclPermits(current.acls?.[rule.acl], result.srcIp)) {
          const translated = outsideIfc.ip;
          if (translated !== result.srcIp) {
            upsertNatTranslation(current, { insideLocal: origSrcIp, insideGlobal: translated, outsideLocal: targetIp });
            result.srcIp = translated;
          }
          break;
        }
      }
    }

    visited.add(nextDevice.id);
    result.hops.push({ from: current.id, via: route.nextHopIp, kind: route.kind });
    // Frame request keluar dari `current` (utk capture/pcap).
    capture(current, {
      ts: Date.now(),
      summary: 'ICMP echo request',
      srcIp: result.srcIp, dstIp: targetIp,
      srcMac: ifc.mac,
      dstMac: nextDevice.interfaces[nextEntry.interface]?.mac ?? 'ff:ff:ff:ff:ff:ff',
      bytes: 98, reply: false,
    });
    current = nextDevice;
    arrivedOn = nextEntry.interface;
  }
  result.reason = 'ttl-exceeded';
  return result;
}

/** Catat frame ICMP echo reply di jalur balik (terjadi hanya saat ping sukses). */
function recordReply(world, srcDevice, dstDevice, targetIp, translatedSrc, hops, origSrc) {
  // Jalur balik = kebalikan hops: dstDevice -> ... -> srcDevice.
  const path = [{ device: dstDevice, via: null }, ...hops.slice().reverse().map((h) => ({ device: world.devices.get(h.from), via: h.via }))];
  for (let i = 0; i < path.length - 1; i++) {
    const cur = path[i].device;
    const nxt = path[i + 1].device;
    if (!cur || !nxt) continue;
    // Interface keluar di device cur: sisi menuju nxt (cari via IP next-hop).
    let outIf = null;
    const viaIp = path[i + 1].via;
    if (viaIp) {
      const entry = Object.entries(cur.interfaces).find(([, ic]) => ic.ip && inSubnet(viaIp, networkOf(ic.ip, ic.mask), ic.mask));
      outIf = entry?.[0] ?? null;
    }
    const replySrc = i === 0 ? targetIp : translatedSrc;
    const replyDst = i === path.length - 2 ? origSrc : translatedSrc;
    capture(cur, {
      ts: Date.now(),
      summary: 'ICMP echo reply',
      srcIp: replySrc, dstIp: replyDst,
      srcMac: outIf ? cur.interfaces[outIf].mac : 'ff:ff:ff:ff:ff:ff',
      dstMac: nxt.interfaces[Object.keys(nxt.interfaces)[0]]?.mac ?? 'ff:ff:ff:ff:ff:ff',
      bytes: 98, reply: true,
    });
  }
}

/** Catat ARP dua arah setelah ping sukses (agar `show arp` berisi data nyata). */
export function learnArp(world, srcDevice, srcIp, targetIp) {
  const target = findDeviceByIp(world, targetIp);
  if (!target) return;
  const tIf = target.device.interfaces[target.interface];
  const sIfEntry = Object.entries(srcDevice.interfaces).find(([, i]) => i.ip === srcIp);
  if (!sIfEntry) return;
  const [, sIf] = sIfEntry;
  const now = Math.floor((Date.now() - srcDevice.bootTime) / 60000);
  upsertArp(srcDevice, targetIp, tIf.mac, sIfEntry[0], now);
  upsertArp(target.device, srcIp, sIf.mac, target.interface, now);
}

function upsertArp(device, ip, mac, interfaceName, age) {
  const row = device.arpTable.find((e) => e.ip === ip);
  if (row) {
    row.mac = mac;
    row.interface = interfaceName;
    row.age = age;
  } else {
    device.arpTable.push({ ip, mac, interface: interfaceName, age });
  }
}
