/**
 * routing-protocols.js — engine routing dinamis: RIP v2, OSPF (single area),
 * EIGRP. Semua perhitungan DETERMINISTIK dan dihitung on-demand dari state
 * (topologi + interface + konfigurasi protokol) — rekonvergensi instan saat
 * konfigurasi berubah, seperti "Simulation Mode" Packet Tracer.
 *
 * Metrik dihitung dari profil interface (bandwidth/delay default IOS):
 *   GigabitEthernet : BW 1.000.000 kbps, delay 10 usec  -> OSPF cost 1, EIGRP 2816
 *   FastEthernet    : BW   100.000 kbps, delay 100 usec -> OSPF cost 1, EIGRP 28160
 *   Serial (T1)     : BW     1.544 kbps, delay 20000 usec -> OSPF cost 64, EIGRP 2169856
 *
 * RIP  : metrik = hop count (BFS), AD 120, max 15 hop.
 * OSPF : metrik = jumlah cost interface keluar sepanjang jalur (Dijkstra), AD 110.
 * EIGRP: metrik = 256 x (10^7/minBW + total delay), AD 90, RD/FD utk topology table.
 */

import { ipToInt, networkOf, inSubnet, maskToPrefix } from './ip.js';

const ANSI = { CYAN: '\x1b[36m', RESET: '\x1b[0m' };
const color = (t, c) => `${c}${t}${ANSI.RESET}`;

export const AD = { static: 1, eigrp: 90, ospf: 110, rip: 120 };

/* ---------------- profil interface ---------------- */

export function ifProfile(ifName) {
  if (String(ifName).startsWith('GigabitEthernet')) return { bwKbps: 1000000, delayUsec: 10 };
  if (String(ifName).startsWith('Serial')) return { bwKbps: 1544, delayUsec: 20000 };
  return { bwKbps: 100000, delayUsec: 100 }; // FastEthernet / Vlan / lainnya
}

/** OSPF cost = 10^8 / BW(bps), dibulatkan ke bawah, minimal 1. */
export function ospfCost(ifName) {
  return Math.max(1, Math.floor(100000000 / (ifProfile(ifName).bwKbps * 1000)));
}

/** Komponen bandwidth EIGRP = 10^7 / BW(kbps) (integer division). */
export function eigrpBwTerm(ifName) {
  return Math.floor(10000000 / ifProfile(ifName).bwKbps);
}

/** Komponen delay EIGRP = total delay dalam puluhan microsecond. */
export function eigrpDelayTerm(ifName) {
  return ifProfile(ifName).delayUsec / 10;
}

/** Metrik komposit EIGRP atas rangkaian interface keluar. */
export function eigrpMetric(ifNames) {
  if (!ifNames.length) return null;
  const bw = Math.min(...ifNames.map(eigrpBwTerm));
  const delay = ifNames.reduce((s, n) => s + eigrpDelayTerm(n), 0);
  return 256 * (bw + delay);
}

/* ---------------- classful & wildcard ---------------- */

/** Jaringan classful dari sebuah IP (dipakai `network` RIP/EIGRP). */
export function classfulOf(ip) {
  const o = ipToInt(ip);
  if (o === null) return null;
  const a = (o >>> 24) & 255;
  const b = (o >>> 16) & 255;
  const c = (o >>> 8) & 255;
  if (a < 128) return { network: `${a}.0.0.0`, mask: '255.0.0.0', prefix: 8 };
  if (a < 192) return { network: `${a}.${b}.0.0`, mask: '255.255.0.0', prefix: 16 };
  return { network: `${a}.${b}.${c}.0`, mask: '255.255.255.0', prefix: 24 };
}

/** Wildcard match ala OSPF/EIGRP: (ip ^ network) & ~wildcard === 0. */
export function wildcardMatch(ip, network, wildcard) {
  const a = ipToInt(ip);
  const n = ipToInt(network);
  const w = ipToInt(wildcard);
  if (a === null || n === null || w === null) return false;
  return (((a ^ n) >>> 0) & (~w >>> 0)) === 0;
}

/** "GigabitEthernet0/1" -> "Gi0/1" (utk tabel EIGRP neighbors). */
export function shortIf(name) {
  return String(name)
    .replace('GigabitEthernet', 'Gi')
    .replace('FastEthernet', 'Fa')
    .replace('Ethernet', 'Et');
}

/* ---------------- graf router ---------------- */

/**
 * Graf antar-router: edge = dua interface router up/up ber-IP di subnet sama.
 * Switch transparan (L2). Return { routers, edges }.
 * edge = {aId, bId, aIf, bIf, subnet, mask, aIp, bIp}
 */
export function routerGraph(world) {
  const routers = [...world.devices.values()].filter((d) => d.isRouter);
  const edges = [];
  for (let i = 0; i < routers.length; i++) {
    for (let j = i + 1; j < routers.length; j++) {
      const A = routers[i];
      const B = routers[j];
      for (const [aIf, a] of Object.entries(A.interfaces)) {
        if (!(a.ip && a.mask && a.operUp)) continue;
        for (const [bIf, b] of Object.entries(B.interfaces)) {
          if (!(b.ip && b.mask && b.operUp)) continue;
          if (a.mask !== b.mask) continue;
          if (networkOf(a.ip, a.mask) === networkOf(b.ip, b.mask)) {
            edges.push({
              aId: A.id, bId: B.id, aIf, bIf,
              subnet: networkOf(a.ip, a.mask), mask: a.mask, aIp: a.ip, bIp: b.ip,
            });
          }
        }
      }
    }
  }
  return { routers, edges };
}

function edgeSide(edge, deviceId) {
  return edge.aId === deviceId ? 'a' : edge.bId === deviceId ? 'b' : null;
}

/** Interface & IP sisi `deviceId` pada sebuah edge. */
function sideIf(edge, deviceId) {
  const s = edgeSide(edge, deviceId);
  return s ? { ifName: edge[`${s}If`], ip: edge[`${s}Ip`], otherIp: edge[s === 'a' ? 'bIp' : 'aIp'] } : null;
}

/* ---------------- kecocokan network statement ---------------- */

/**
 * Apakah interface ifc (ber-IP) dicakup oleh konfigurasi protokol `device`?
 * Return { matched, area? } atau null bila protokol tidak aktif.
 * passive TIDAK dianggap di sini (subnet tetap diiklankan walau passive).
 */
function protoMatch(device, proto, procId, ifc) {
  const routing = device.routing || {};
  if (proto === 'rip') {
    const r = routing.rip;
    if (!r || !r.networks?.length) return null;
    const cf = classfulOf(ifc.ip);
    return cf && r.networks.includes(cf.network) ? { matched: true } : { matched: false };
  }
  if (proto === 'ospf') {
    const p = routing.ospf?.[procId];
    if (!p) return null;
    for (const n of p.networks) {
      if (wildcardMatch(ifc.ip, n.network, n.wildcard)) return { matched: true, area: n.area };
    }
    return { matched: false };
  }
  if (proto === 'eigrp') {
    const p = routing.eigrp?.[procId];
    if (!p) return null;
    for (const n of p.networks) {
      if (n.wildcard ? wildcardMatch(ifc.ip, n.network, n.wildcard) : classfulOf(ifc.ip)?.network === n.network) {
        return { matched: true };
      }
    }
    return { matched: false };
  }
  return null;
}

function isPassive(device, proto, procId, ifName) {
  const routing = device.routing || {};
  if (proto === 'rip') return routing.rip?.passive?.includes(ifName) ?? false;
  if (proto === 'ospf') return routing.ospf?.[procId]?.passive?.includes(ifName) ?? false;
  return routing.eigrp?.[procId]?.passive?.includes(ifName) ?? false;
}

/** Protokol apa saja yang aktif di device: [{proto, procId, label, config}] */
export function activeProtocols(device) {
  const out = [];
  const r = device.routing || {};
  if (r.rip) out.push({ proto: 'rip', procId: null, label: 'rip', config: r.rip });
  for (const [pid, cfg] of Object.entries(r.ospf || {})) {
    out.push({ proto: 'ospf', procId: Number(pid), label: `ospf ${pid}`, config: cfg });
  }
  for (const [as, cfg] of Object.entries(r.eigrp || {})) {
    out.push({ proto: 'eigrp', procId: Number(as), label: `eigrp ${as}`, config: cfg });
  }
  for (const [as, cfg] of Object.entries(r.bgp || {})) {
    out.push({ proto: 'bgp', procId: Number(as), label: `bgp ${as}`, config: cfg });
  }
  return out;
}

/** Adjacency BGP pada sebuah edge: kedua sisi saling memasang neighbor.
 *  eBGP: nomor AS kedua sisi BERBEDA — remoteAs di sisi A harus = AS proses di B. */
export function bgpEdgeAllows(edge, asNum, world) {
  const A = world.devices.get(edge.aId);
  const B = world.devices.get(edge.bId);
  const ca = A?.routing?.bgp?.[asNum];
  if (!ca) return false;
  const remoteAs = ca.neighbors?.[edge.bIp]?.remoteAs;
  if (!remoteAs) return false;
  const cb = B?.routing?.bgp?.[remoteAs];
  return cb?.neighbors?.[edge.aIp]?.remoteAs === asNum;
}

/** Peer BGP milik router R (proses asNum): [{peerId, peerIp, myIf, peerAs, ebgp}] */
function bgpPeers(world, graph, router, asNum) {
  const peers = [];
  for (const edge of graph.edges) {
    if (!bgpEdgeAllows(edge, asNum, world)) continue;
    const side = sideIf(edge, router.id);
    if (!side) continue;
    const otherId = edge.aId === router.id ? edge.bId : edge.aId;
    const other = world.devices.get(otherId);
    const otherAs = Object.keys(other.routing?.bgp || {})
      .map(Number)
      .find((k) => other.routing.bgp[k].neighbors?.[side.ip]?.remoteAs === asNum);
    peers.push({ peerId: otherId, peerIp: side.otherIp, myIf: side.ifName, peerAs: otherAs, ebgp: asNum !== otherAs });
  }
  return peers;
}

/** Jaringan sendiri yang diiklankan BGP (network statement + subnet connected up). */
function bgpOwnNetworks(router, cfg) {
  const out = [];
  for (const n of cfg.networks || []) {
    const connected = Object.values(router.interfaces).some(
      (ifc) => ifc.ip && ifc.mask && ifc.operUp && networkOf(ifc.ip, ifc.mask) === networkOf(n.network, n.mask)
    );
    if (connected) out.push({ network: networkOf(n.network, n.mask), mask: n.mask });
  }
  return out;
}

/* ---------------- BGP (eBGP sederhana, propagasi BFS) ---------------- */

function computeBgp(world, graph, router, asNum, config) {
  const rows = [];
  const peers = bgpPeers(world, graph, router, asNum).filter((p) => p.ebgp);
  if (!peers.length) return rows;

  // BFS melewati graf peer: setiap peer mengiklankan jaringan sendiri +
  // yang dipelajarinya (loop prevention sederhana: router dikunjungi sekali).
  const visited = new Set([router.id]);
  const queue = peers.map((p) => ({ peer: p, asPath: [asNum], viaIp: p.peerIp, viaIf: p.myIf }));
  const learned = new Map();

  while (queue.length) {
    const cur = queue.shift();
    const X = world.devices.get(cur.peer.peerId);
    if (!X || visited.has(X.id)) continue;
    visited.add(X.id);
    const xAs = cur.peer.peerAs;
    const xCfg = X.routing?.bgp?.[xAs];
    if (!xCfg) continue;
    const asPath = [...cur.asPath, xAs];

    for (const n of bgpOwnNetworks(X, xCfg)) {
      const key = `${n.network}|${n.mask}`;
      if (learned.has(key)) continue;
      learned.set(key, {
        protocol: 'bgp', procLabel: `bgp ${asNum}`,
        network: n.network, mask: n.mask, prefix: maskToPrefix(n.mask),
        via: cur.viaIp, interface: cur.viaIf,
        metric: 0, distance: 20, asPath,
      });
    }
    // Teruskan ke peer-peer X (kecuali yang sudah dikunjungi).
    for (const p2 of bgpPeers(world, graph, X, xAs).filter((p) => p.ebgp)) {
      if (!visited.has(p2.peerId)) {
        queue.push({ peer: p2, asPath, viaIp: cur.viaIp, viaIf: cur.viaIf });
      }
    }
  }
  rows.push(...learned.values());
  return rows;
}

/** Edge boleh dilewati protokol ini (adjacency terbentuk di kedua sisi)? */
function edgeAllows(edge, proto, procId, world) {
  const A = world.devices.get(edge.aId);
  const B = world.devices.get(edge.bId);
  if (!A || !B) return false;
  const ma = protoMatch(A, proto, procId, A.interfaces[edge.aIf]);
  const mb = protoMatch(B, proto, procId, B.interfaces[edge.bIf]);
  if (!ma?.matched || !mb?.matched) return false;
  if (proto === 'ospf' && ma.area !== mb.area) return false;
  if (isPassive(A, proto, procId, edge.aIf) || isPassive(B, proto, procId, edge.bIf)) return false;
  return true;
}

/* ---------------- RIP (BFS hop count) ---------------- */

function computeRip(world, graph, router, proto, config) {
  const rows = [];
  // Antrian BFS: {routerId, hops, viaIp, viaIf}
  const visited = new Map([[router.id, 0]]);
  const queue = [{ routerId: router.id, hops: 0, viaIp: null, viaIf: null }];
  const learned = new Map(); // subnet -> row

  while (queue.length) {
    const cur = queue.shift();
    for (const edge of graph.edges) {
      const side = sideIf(edge, cur.routerId);
      if (!side) continue;
      const otherId = cur.routerId === edge.aId ? edge.bId : edge.aId;
      if (visited.has(otherId)) continue;
      if (!edgeAllows(edge, 'rip', null, world)) continue;

      visited.set(otherId, cur.hops + 1);
      const hopInfo = cur.viaIp === null
        ? { viaIp: side.otherIp, viaIf: side.ifName } // first hop dari router asal
        : { viaIp: cur.viaIp, viaIf: cur.viaIf };
      queue.push({ routerId: otherId, hops: cur.hops + 1, ...hopInfo });

      // Subnet lain milik tetangga ini yang diiklankan RIP = rute baru.
      const nbr = world.devices.get(otherId);
      for (const [ifName, ifc] of Object.entries(nbr.interfaces)) {
        if (ifName === edge[otherId === edge.aId ? 'aIf' : 'bIf']) continue; // subnet edge sendiri
        if (!(ifc.ip && ifc.mask && ifc.operUp)) continue;
        const subnet = networkOf(ifc.ip, ifc.mask);
        const m = protoMatch(nbr, 'rip', null, ifc);
        if (!m?.matched) continue;
        // router asal tidak boleh terhubung langsung ke subnet tsb
        if (directlyConnected(router, subnet)) continue;
        if (learned.has(subnet)) continue;
        learned.set(subnet, {
          protocol: 'rip', procLabel: 'rip',
          network: subnet, mask: edge.mask === ifc.mask ? ifc.mask : ifc.mask,
          prefix: maskToPrefix(ifc.mask),
          via: hopInfo.viaIp, interface: hopInfo.viaIf,
          metric: cur.hops + 1, distance: AD.rip,
        });
      }
    }
  }
  rows.push(...learned.values());
  return rows;
}

function directlyConnected(router, subnet) {
  return Object.values(router.interfaces).some(
    (ifc) => ifc.ip && ifc.mask && ifc.operUp && networkOf(ifc.ip, ifc.mask) === subnet
  );
}

/* ---------------- OSPF (Dijkstra cost) ---------------- */

function computeOspf(world, graph, router, procId, config) {
  const rows = [];
  // Dijkstra antar router; edge weight = cost interface keluar router asal.
  const dist = new Map([[router.id, 0]]);
  const prev = new Map(); // routerId -> {fromId, viaIf, viaIp}
  const unvisited = new Set(graph.routers.map((r) => r.id));

  while (unvisited.size) {
    let cur = null;
    let curCost = Infinity;
    for (const id of unvisited) {
      if ((dist.get(id) ?? Infinity) < curCost) {
        cur = id;
        curCost = dist.get(id);
      }
    }
    if (cur === null) break;
    unvisited.delete(cur);

    for (const edge of graph.edges) {
      const side = sideIf(edge, cur);
      if (!side) continue;
      const otherId = cur === edge.aId ? edge.bId : edge.aId;
      if (!unvisited.has(otherId)) continue;
      if (!edgeAllows(edge, 'ospf', procId, world)) continue;
      const nd = curCost + ospfCost(side.ifName);
      if (nd < (dist.get(otherId) ?? Infinity)) {
        dist.set(otherId, nd);
        prev.set(otherId, {
          fromId: cur,
          viaIf: cur === router.id ? side.ifName : prev.get(cur)?.viaIf,
          viaIp: cur === router.id ? side.otherIp : prev.get(cur)?.viaIp,
        });
      }
    }
  }

  // Destinasi: subnet milik router lain, diiklankan OSPF dengan area konsisten.
  for (const X of graph.routers) {
    if (X.id === router.id || !dist.has(X.id)) continue;
    for (const [ifName, ifc] of Object.entries(X.interfaces)) {
      if (!(ifc.ip && ifc.mask && ifc.operUp)) continue;
      const subnet = networkOf(ifc.ip, ifc.mask);
      const m = protoMatch(X, 'ospf', procId, ifc);
      if (!m?.matched) continue;
      if (directlyConnected(router, subnet)) continue;
      const destArea = m.area;
      // Semua edge di jalur harus berada di area tujuan (single-area simpel).
      let ok = true;
      let walk = X.id;
      while (walk !== router.id) {
        const p = prev.get(walk);
        if (!p) { ok = false; break; }
        const edge = graph.edges.find(
          (e) => (e.aId === p.fromId && e.bId === walk) || (e.bId === p.fromId && e.aId === walk)
        );
        const ea = protoMatch(world.devices.get(edge.aId), 'ospf', procId, world.devices.get(edge.aId).interfaces[edge.aIf]);
        const eb = protoMatch(world.devices.get(edge.bId), 'ospf', procId, world.devices.get(edge.bId).interfaces[edge.bIf]);
        if (ea?.area !== destArea || eb?.area !== destArea) { ok = false; break; }
        walk = p.fromId;
      }
      if (!ok) continue;

      const lastCost = ospfCost(ifName); // cost interface keluar router pemilik subnet
      rows.push({
        protocol: 'ospf', procLabel: `ospf ${procId}`,
        network: subnet, mask: ifc.mask, prefix: maskToPrefix(ifc.mask),
        via: prev.get(X.id)?.viaIp, interface: prev.get(X.id)?.viaIf,
        metric: dist.get(X.id) + lastCost, distance: AD.ospf,
        from: ospfRouterId(X, procId),
      });
    }
  }
  return rows;
}

/** Router-ID OSPF: router-id manual, atau IP tertinggi interface adminUp ber-IP. */
export function ospfRouterId(device, procId) {
  const proc = device.routing?.ospf?.[procId];
  if (proc?.routerId) return proc.routerId;
  let best = null;
  for (const ifc of Object.values(device.interfaces)) {
    if (!ifc.adminUp || !ifc.ip) continue;
    const o = ipToInt(ifc.ip);
    if (o !== null && (best === null || o > best)) best = o;
  }
  if (best === null) return null;
  return [(best >>> 24) & 255, (best >>> 16) & 255, (best >>> 8) & 255, best & 255].join('.');
}

/* ---------------- EIGRP (metrik komposit) ---------------- */

function computeEigrp(world, graph, router, asNum, config) {
  const rows = [];
  // Enumerasi semua simple path dari router ke setiap router lain (topologi kecil).
  const paths = new Map(); // targetId -> [ {ifNames, viaIp, viaIf} ] path terbaik saja

  const dfs = (curId, visited, ifChain, viaIp, viaIf) => {
    for (const edge of graph.edges) {
      const side = sideIf(edge, curId);
      if (!side) continue;
      const otherId = curId === edge.aId ? edge.bId : edge.aId;
      if (visited.has(otherId)) continue;
      if (!edgeAllows(edge, 'eigrp', asNum, world)) continue;
      const startEdge = ifChain.length === 0;
      const nextChain = [...ifChain, side.ifName];
      const nextVia = startEdge ? { viaIp: side.otherIp, viaIf: side.ifName } : { viaIp, viaIf };
      if (!paths.has(otherId)) paths.set(otherId, []);
      paths.get(otherId).push({ ifNames: nextChain, ...nextVia });
      dfs(otherId, new Set([...visited, otherId]), nextChain, nextVia.viaIp, nextVia.viaIf);
    }
  };
  dfs(router.id, new Set([router.id]), [], null, null);

  for (const X of graph.routers) {
    if (X.id === router.id) continue;
    const xPaths = paths.get(X.id);
    if (!xPaths?.length) continue;
    for (const [ifName, ifc] of Object.entries(X.interfaces)) {
      if (!(ifc.ip && ifc.mask && ifc.operUp)) continue;
      const subnet = networkOf(ifc.ip, ifc.mask);
      const m = protoMatch(X, 'eigrp', asNum, ifc);
      if (!m?.matched) continue;
      if (directlyConnected(router, subnet)) continue;
      let best = null;
      for (const path of xPaths) {
        const metric = eigrpMetric([...path.ifNames, ifName]);
        if (metric !== null && (best === null || metric < best.metric)) best = { ...path, metric };
      }
      if (!best) continue;
      const rd = eigrpMetric([ifName]); // jarak terlapor dari pemilik subnet
      rows.push({
        protocol: 'eigrp', procLabel: `eigrp ${asNum}`,
        network: subnet, mask: ifc.mask, prefix: maskToPrefix(ifc.mask),
        via: best.viaIp, interface: best.viaIf,
        metric: best.metric, distance: AD.eigrp, rd,
      });
    }
  }
  return rows;
}

/* ---------------- agregasi ---------------- */

/**
 * Hitung rute dinamis SEMUA router. Return Map<deviceId, rows[]>.
 * Sudah didedupe per (network, mask): AD terendah menang; tie -> metrik terendah.
 */
export function computeDynamicRoutes(world) {
  const graph = routerGraph(world);
  const result = new Map();

  for (const router of graph.routers) {
    const candidates = [];
    for (const p of activeProtocols(router)) {
      if (p.proto === 'rip') candidates.push(...computeRip(world, graph, router, p, p.config));
      if (p.proto === 'ospf') {
        for (const rows of [computeOspf(world, graph, router, p.procId, p.config)]) candidates.push(...rows);
      }
      if (p.proto === 'eigrp') candidates.push(...computeEigrp(world, graph, router, p.procId, p.config));
      if (p.proto === 'bgp') candidates.push(...computeBgp(world, graph, router, p.procId, p.config));
    }
    // Dedupe: kunci network/mask -> metrik/AD terbaik.
    const best = new Map();
    for (const row of candidates) {
      const key = `${row.network}|${row.mask}`;
      const prevRow = best.get(key);
      if (
        !prevRow ||
        row.distance < prevRow.distance ||
        (row.distance === prevRow.distance && row.metric < prevRow.metric)
      ) best.set(key, row);
    }
    result.set(router.id, [...best.values()]);
  }
  return result;
}

/* ---------------- adjacency (log & show) ---------------- */

/**
 * Set adjacency saat ini utk semua protokol.
 * key = `${proto}|${procKey}|${devId}|${nbrId}|${devIf}`
 */
export function adjacencySets(world) {
  const graph = routerGraph(world);
  const out = new Map();
  const protosSeen = new Set();
  for (const d of graph.routers) {
    for (const p of activeProtocols(d)) protosSeen.add(`${p.proto}|${p.procId}`);
  }
  for (const key of protosSeen) {
    const [proto, procStr] = key.split('|');
    const procId = procStr === '' ? null : Number(procStr);
    for (const edge of graph.edges) {
      const ok = proto === 'bgp' ? bgpEdgeAllows(edge, procId, world) : edgeAllows(edge, proto, procId, world);
      if (!ok) continue;
      const A = world.devices.get(edge.aId);
      const B = world.devices.get(edge.bId);
      const entry = (dev, other, devIf, otherIf) => {
        const k = `${proto}|${procStr}|${dev.id}|${other.id}|${devIf}`;
        out.set(k, {
          proto, procId, deviceId: dev.id, neighborId: other.id,
          interface: devIf, neighborIf: otherIf,
          neighborIp: devIf === edge.aIf ? edge.bIp : edge.aIp,
          routerId: proto === 'ospf' ? ospfRouterId(other, procId) : null,
        });
      };
      entry(A, B, edge.aIf, edge.bIf);
      entry(B, A, edge.bIf, edge.aIf);
    }
  }
  return out;
}

/**
 * Diff adjacency vs snapshot sebelumnya (world.adjacencyState).
 * Return daftar event log ala IOS: [{deviceId, text}].
 * OSPF : %OSPF-5-ADJCHG: Process 1, Nbr <ip> on <if> from LOADING to FULL, Loading Done
 * EIGRP: %DUAL-5-NBRCHANGE: IP-EIGRP(0) 100: Neighbor <ip> (<if>) is up: new adjacency
 */
export function adjacencyEvents(world) {
  const current = adjacencySets(world);
  const prev = world.adjacencyState || new Map();
  const events = [];

  for (const [key, adj] of current) {
    if (prev.has(key)) continue;
    if (adj.proto === 'ospf') {
      events.push({
        deviceId: adj.deviceId,
        text: color(`%OSPF-5-ADJCHG: Process ${adj.procId}, Nbr ${adj.neighborIp} on ${adj.interface} from LOADING to FULL, Loading Done`, ANSI.CYAN),
      });
    } else if (adj.proto === 'eigrp') {
      events.push({
        deviceId: adj.deviceId,
        text: color(`%DUAL-5-NBRCHANGE: IP-EIGRP(0) ${adj.procId}: Neighbor ${adj.neighborIp} (${adj.interface}) is up: new adjacency`, ANSI.CYAN),
      });
    } else if (adj.proto === 'bgp') {
      events.push({
        deviceId: adj.deviceId,
        text: color(`%BGP-5-ADJCHANGE: Neighbor ${adj.neighborIp} Up`, ANSI.CYAN),
      });
    }
  }
  for (const [key, adj] of prev) {
    if (current.has(key)) continue;
    if (adj.proto === 'ospf') {
      events.push({
        deviceId: adj.deviceId,
        text: color(`%OSPF-5-ADJCHG: Process ${adj.procId}, Nbr ${adj.neighborIp} on ${adj.interface} from FULL to DOWN, Neighbor Down: interface down or detached`, ANSI.CYAN),
      });
    } else if (adj.proto === 'eigrp') {
      events.push({
        deviceId: adj.deviceId,
        text: color(`%DUAL-5-NBRCHANGE: IP-EIGRP(0) ${adj.procId}: Neighbor ${adj.neighborIp} (${adj.interface}) is down: interface down or detached`, ANSI.CYAN),
      });
    } else if (adj.proto === 'bgp') {
      events.push({
        deviceId: adj.deviceId,
        text: color(`%BGP-5-ADJCHANGE: Neighbor ${adj.neighborIp} Down`, ANSI.CYAN),
      });
    }
  }
  world.adjacencyState = current;
  return events;
}
