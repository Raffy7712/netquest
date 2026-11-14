/**
 * l2-services.js — layanan Layer-2 & edge yang diterjemahkan dari referensi
 * NetSim (joxorsayan/netsim): domain VLAN (access/trunk), DHCP DORA,
 * pemilihan root spanning-tree, dan evaluasi ACL standar.
 */

import { ipToInt, intToIp, networkOf, inSubnet, isValidIp } from './ip.js';

/* ---------------- VLAN / switchport ---------------- */

/** Konfigurasi switchport default sebuah interface switch. */
export function defaultSwitchport() {
  return { mode: 'access', accessVlan: 1, trunkNative: 1, trunkAllowed: 'all' };
}

/** Ambil config switchport (buat default bila belum ada; null utk non-switch). */
export function switchportOf(dev, ifName) {
  const ifc = dev.interfaces[ifName];
  if (!ifc || dev.type !== 'switch') return null;
  if (!ifc.sw) ifc.sw = defaultSwitchport();
  return ifc.sw;
}

/** VLAN yang dilayani sebuah port switch: access -> {accessVlan}, trunk -> set. */
function vlansCarried(sw) {
  if (!sw) return null; // bukan port switch (router/PC)
  if (sw.mode === 'trunk') {
    if (sw.trunkAllowed === 'all') return new Set([sw.trunkNative, ...Array.from({ length: 40 }, (_, i) => i + 1)]);
    return new Set([sw.trunkNative, ...sw.trunkAllowed]);
  }
  return new Set([sw.accessVlan]);
}

/**
 * Apakah dua endpoint (device, interface) berada dalam satu broadcast domain?
 * BFS melewati switch dengan aturan access/trunk (802.1Q disederhanakan).
 */
export function vlanReachable(world, srcDev, srcIf, dstDev, dstIf) {
  if (srcDev.id === dstDev.id) return true;
  const start = `${srcDev.id}|${srcIf}`;
  const goal = `${dstDev.id}|${dstIf}`;
  const visited = new Set([start]);
  const queue = [{ devId: srcDev.id, ifName: srcIf, vlan: null }];

  while (queue.length) {
    const cur = queue.shift();
    const dev = world.devices.get(cur.devId);
    if (!dev) continue;

    for (const link of world.links) {
      const mySide = link.a.device === dev.id ? 'a' : link.b.device === dev.id ? 'b' : null;
      if (!mySide || link[mySide].interface !== cur.ifName) continue;
      const otherSide = mySide === 'a' ? 'b' : 'a';
      const other = world.devices.get(link[otherSide].device);
      const myIfc = dev.interfaces[cur.ifName];
      const otherIfName = link[otherSide].interface;
      const otherIfc = other?.interfaces[otherIfName];
      if (!other || !myIfc?.adminUp || !otherIfc?.adminUp) continue;

      const key = `${other.id}|${otherIfName}`;
      if (visited.has(key)) continue;

      if (other.type === 'switch') {
        // Masuk ke switch: port ingress menentukan VLAN frame (access retag).
        const sw = switchportOf(other, otherIfName);
        const ingress = vlansCarried(sw);
        if (cur.vlan !== null && !ingress.has(cur.vlan)) continue;
        const vlan = cur.vlan === null ? [...ingress][0] : cur.vlan;
        visited.add(key);
        // Keluar dari switch lewat semua port lain yang membawa VLAN tsb.
        for (const [portName, port] of Object.entries(other.interfaces)) {
          if (portName === otherIfName || !port.adminUp) continue;
          const psw = switchportOf(other, portName);
          const carried = vlansCarried(psw);
          if (!carried?.has(vlan)) continue;
          const pk = `${other.id}|${portName}`;
          if (!visited.has(pk)) {
            visited.add(pk);
            queue.push({ devId: other.id, ifName: portName, vlan });
          }
        }
        continue;
      }
      // Endpoint non-switch (router/PC): harus masuk lewat VLAN yang cocok.
      const sw = switchportOf(other, otherIfName);
      if (sw) {
        const ingress = vlansCarried(sw);
        if (cur.vlan !== null && !ingress.has(cur.vlan)) continue;
        if (key === goal) return true;
        visited.add(key);
        queue.push({ devId: other.id, ifName: otherIfName, vlan: cur.vlan ?? [...ingress][0] });
      } else {
        // Link langsung router-router: tanpa tagging VLAN.
        if (key === goal) return true;
        visited.add(key);
        queue.push({ devId: other.id, ifName: otherIfName, vlan: cur.vlan });
      }
    }
  }
  return false;
}

/* ---------------- ACL standar (numbered 1-99) ---------------- */

/**
 * Evaluasi ACL standar: match sumber, aturan pertama menang,
 * tanpa match -> implicit deny (perilaku IOS).
 * Wildcard dikonversi ke netmask: mask = ~wildcard (0.0.0.255 -> 255.255.255.0).
 */
export function aclPermits(entries, srcIp) {
  if (!entries || entries.length === 0) return true;
  for (const e of entries) {
    if (e.src === 'any') return e.action === 'permit';
    const w = ipToInt(e.wildcard ?? '0.0.0.0') ?? 0;
    const mask = intToIp((~w >>> 0) >>> 0);
    if (inSubnet(srcIp, e.src, mask)) return e.action === 'permit';
  }
  return false;
}

/* ---------------- DHCP DORA ---------------- */

/**
 * PC melakukan ipconfig /renew -> DHCPDISCOVER broadcast di domain L2.
 * Server kandidat: router yang punya pool DAN terjangkau dari PC (broadcast).
 * Return {ok, lines[], server?, binding?} — lines ala log DHCP PT.
 */
export function dhcpDiscover(world, pc) {
  const lines = [];
  const ifName = Object.keys(pc.interfaces)[0];
  const ifc = pc.interfaces[ifName];
  if (!ifc?.adminUp || !ifc.operUp) {
    return { ok: false, lines: ['DHCPDISCOVER: interface down atau tidak terhubung.'] };
  }

  // Kumpulkan server DHCP di satu broadcast domain dengan PC:
  // - router dengan ip dhcp pool
  // - device role server dengan service dhcp on (range start..end)
  const servers = [];
  for (const dev of world.devices.values()) {
    const isRouterDhcp = dev.isRouter && dev.dhcpPools?.length;
    const isServerDhcp = dev.type === 'pc' && dev.role === 'server' && dev.services?.dhcp?.on;
    if (!isRouterDhcp && !isServerDhcp) continue;
    for (const [rIf, rIfc] of Object.entries(dev.interfaces)) {
      if (!rIfc.adminUp || !rIfc.operUp) continue;
      if (vlanReachable(world, pc, ifName, dev, rIf)) {
        if (isRouterDhcp) {
          for (const pool of dev.dhcpPools) servers.push({ dev, rIf, pool });
        } else {
          servers.push({ dev, rIf, range: dev.services.dhcp });
        }
        break;
      }
    }
  }
  if (!servers.length) {
    lines.push('DHCPDISCOVER sent on ' + ifName);
    lines.push('% DHCP: tidak ada DHCP server yang merespons (cek ip dhcp pool di router / service dhcp di server).');
    return { ok: false, lines };
  }

  const cand = servers[0];
  const server = cand.dev;
  const serverIp = server.interfaces[cand.rIf].ip;
  lines.push(`DHCPDISCOVER sent on ${ifName}`);
  const scopeDesc = cand.pool
    ? `pool "${cand.pool.name}", ${cand.pool.network}/${cand.pool.mask}`
    : `range ${cand.range.start} - ${cand.range.end} (service dhcp)`;
  lines.push(`DHCPOFFER from ${serverIp} (${server.hostname}, ${scopeDesc})`);
  lines.push(`DHCPREQUEST -> ${serverIp}`);

  // Alokasi IP:
  // - pool router: dari network+1, lewati excluded, IP terikat, dan IP server sendiri.
  // - server range: dari start..end, lewati IP terpakai/terikat.
  const bound = new Set(server.dhcpBindings.map((b) => b.ip));
  const taken = new Set();
  for (const d of world.devices.values()) {
    for (const i of Object.values(d.interfaces)) if (i.ip) taken.add(i.ip);
  }
  let allocated = null;
  let gatewayHint = null;
  let dnsHint = null;
  if (cand.pool) {
    const base = ipToInt(cand.pool.network);
    const maskInt = ipToInt(cand.pool.mask);
    const size = (~maskInt >>> 0) + 1;
    for (let off = 1; off < size - 1 && off <= 500; off++) {
      const ip = intToIp((base + off) >>> 0);
      if (server.dhcpExcluded?.some((e) => inRange(ip, e))) continue;
      if (taken.has(ip) || bound.has(ip)) continue;
      allocated = ip;
      break;
    }
    gatewayHint = cand.pool.defaultRouter || serverIp;
    dnsHint = cand.pool.dnsServer;
  } else {
    const s = ipToInt(cand.range.start);
    const e = ipToInt(cand.range.end);
    if (s !== null && e !== null) {
      for (let v = s; v <= e; v++) {
        const ip = intToIp(v >>> 0);
        if (taken.has(ip) || bound.has(ip)) continue;
        allocated = ip;
        break;
      }
    }
    gatewayHint = cand.range.gateway || serverIp;
    dnsHint = cand.range.dns;
  }
  if (!allocated) {
    lines.push('% DHCP: pool/range habis (semua IP sudah terpakai).');
    return { ok: false, lines };
  }

  const binding = { ip: allocated, mac: ifc.mac, device: pc.id, since: new Date().toISOString() };
  server.dhcpBindings.push(binding);
  ifc.ip = allocated;
  ifc.mask = cand.pool
    ? cand.pool.mask
    : (Object.values(server.interfaces).find((i) => i.mask && i.ip && inSubnet(allocated, networkOf(i.ip, i.mask), i.mask))?.mask ?? '255.255.255.0');
  pc.gw = gatewayHint;
  lines.push(`DHCPACK from ${serverIp}`);
  lines.push(
    `Lease obtained: ${allocated} / ${ifc.mask}` +
    (gatewayHint ? `, gateway ${gatewayHint}` : '') +
    (dnsHint ? `, DNS ${dnsHint}` : '')
  );
  return { ok: true, lines, server, binding };
}

function inRange(ip, excl) {
  const v = ipToInt(ip);
  const s = ipToInt(excl.start ?? excl);
  const e = ipToInt(excl.end ?? excl.start ?? excl);
  if (v === null || s === null) return false;
  return e !== null ? v >= s && v <= e : v === s;
}

/* ---------------- Spanning Tree (pemilihan root) ---------------- */

/**
 * Pemilihan root bridge per pulau L2 (switch yang terhubung langsung antar switch).
 * Root = priority terendah; tie -> MAC terendah. Return Map<switchId, {rootId, rootMac, rootPriority, island}>
 */
export function stpTopology(world) {
  const switches = [...world.devices.values()].filter((d) => d.isSwitch);
  const islands = []; // array of switch ids
  const seen = new Set();
  for (const sw of switches) {
    if (seen.has(sw.id)) continue;
    const island = [];
    const queue = [sw.id];
    seen.add(sw.id);
    while (queue.length) {
      const id = queue.shift();
      island.push(id);
      for (const link of world.links) {
        const mySide = link.a.device === id ? 'a' : link.b.device === id ? 'b' : null;
        if (!mySide) continue;
        const other = link[mySide === 'a' ? 'b' : 'a'];
        const otherDev = world.devices.get(other.device);
        if (otherDev?.isSwitch && !seen.has(other.device)) {
          seen.add(other.device);
          queue.push(other.device);
        }
      }
    }
    islands.push(island);
  }

  const result = new Map();
  for (const island of islands) {
    const prio = (id) => world.devices.get(id).vlanPriorities?.[1] ?? 32768;
    const root = island.sort((a, b) => {
      const pa = prio(a), pb = prio(b);
      if (pa !== pb) return pa - pb;
      const ma = world.devices.get(a).interfaces[Object.keys(world.devices.get(a).interfaces)[0]].mac;
      const mb = world.devices.get(b).interfaces[Object.keys(world.devices.get(b).interfaces)[0]].mac;
      return ma.localeCompare(mb);
    })[0];
    for (const id of island) {
      result.set(id, {
        rootId: root,
        rootMac: world.devices.get(root).interfaces[Object.keys(world.devices.get(root).interfaces)[0]].mac,
        rootPriority: prio(root),
        isRoot: id === root,
      });
    }
  }
  return result;
}
