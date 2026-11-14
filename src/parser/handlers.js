/**
 * handlers.js — implementasi tiap perintah Cisco IOS.
 *
 * Setiap handler menerima ctx:
 *   { device, world, args, line, argIndices, commands, execute }
 *     - args: named group hasil regex (data mentah dari user)
 *     - argIndices: posisi kolom tiap named group di baris input (untuk caret error)
 *     - commands: daftar perintah yang sah utk device+mode ini (dipakai '?')
 *     - execute: parser.execute (dipakai handler `do`)
 *
 * Return:
 *   - string                     -> output biasa
 *   - { output, syslog: [...] }  -> output + pesan syslog (dipisah baris di atasnya)
 *   - { error, caret }           -> invalid input dengan posisi caret (kolom di baris perintah)
 *
 * Semua output `show` dibentuk DARI state device saat itu — tidak ada string hardcoded.
 */

import {
  isValidIp, networkOf, maskToPrefix, ipToInt,
} from '../simulator/ip.js';
import {
  routingTable, pingFrom, learnArp, findDeviceByIp, refreshOperStatus,
  cableTypeBetween, connectDevices, disconnectDevices, resolveHostname, pushSyslog,
} from '../simulator/network.js';
import { portTypeOf } from '../simulator/CiscoDevice.js';
import {
  activeProtocols, adjacencySets, classfulOf, shortIf, ospfRouterId,
  eigrpMetric, ospfCost, wildcardMatch,
} from '../simulator/routing-protocols.js';
import {
  dhcpDiscover, stpTopology, switchportOf, aclPermits, defaultSwitchport,
} from '../simulator/l2-services.js';

/* ---------------- util kecil ---------------- */

const ANSI = { RED: '\x1b[31m', GREEN: '\x1b[32m', CYAN: '\x1b[36m', YELLOW: '\x1b[33m', DIM: '\x1b[2m', RESET: '\x1b[0m' };
export const color = (text, code) => `${code}${text}${ANSI.RESET}`;

/** Validasi octet IP/mask; return null jika sah, atau caret-offset argumennya. */
function badIpArg(value, name, argIndices) {
  if (isValidIp(value)) return null;
  const idx = argIndices?.get?.(name);
  return idx ? idx[0] : 0;
}

function pad(s, width) {
  s = String(s ?? '');
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function padLeft(s, width) {
  s = String(s ?? '');
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

function statusOf(ifc) {
  if (!ifc.adminUp) return 'administratively down';
  return ifc.operUp ? 'up' : 'down';
}

function protocolOf(ifc) {
  return ifc.adminUp && ifc.operUp ? 'up' : 'down';
}

/** Resolusi hostname -> IP (Packet Tracer memakai file DNS sederhana). */
function resolveTarget(world, name) {
  if (isValidIp(name)) return { ip: name, via: null };
  // DNS statis (meta) + record dinamis di server (role server, service dns on).
  const dns = world.meta?.dns || {};
  if (Object.prototype.hasOwnProperty.call(dns, name)) return { ip: dns[name], via: name };
  const ip = resolveHostname(world, name);
  if (ip) return { ip, via: name };
  return null;
}

/* ---------------- navigasi mode ---------------- */

export function cmdEnable(ctx) {
  const d = ctx.device;
  // Dengan enable secret terpasang, IOS meminta password — simulator
  // menerima langsung (password diketahui pemain lewat quest/guru).
  if (d.currentMode === 'user') d.setMode('privileged');
  return '';
}

export function cmdDisable(ctx) {
  if (ctx.device.currentMode === 'privileged') ctx.device.setMode('user');
  return '';
}

export function cmdExit(ctx) {
  const d = ctx.device;
  if (['interface-config', 'line-config', 'router-config', 'vlan-config', 'dhcp-config'].includes(d.currentMode)) {
    d.setMode(d.type === 'pc' ? 'user' : 'global-config');
  }
  else if (d.currentMode === 'global-config') d.setMode('privileged');
  else if (d.currentMode === 'privileged') d.setMode('user');
  // user EXEC: `exit`/`logout` = keluar sesi; simulator tetap di user mode.
  return '';
}

export function cmdEnd(ctx) {
  // PC tidak punya global-config: `end` kembali ke user EXEC.
  ctx.device.setMode(ctx.device.type === 'pc' ? 'user' : 'privileged');
  return '';
}

export function cmdConfigureTerminal(ctx) {
  ctx.device.setMode('global-config');
  return 'Enter configuration commands, one per line. End with CNTL/Z.';
}

/** `do <exec-cmd>` — jalankan perintah EXEC dari mode config (perilaku IOS). */
export function cmdDo(ctx) {
  const d = ctx.device;
  const sub = ctx.args.line.trim();
  const mode = d.currentMode;
  const line = d.currentLine;
  const ifc = d.currentInterface;
  d.setMode('privileged');
  const res = ctx.execute(d, sub, ctx.world);
  // kembalikan posisi mode semula (prompt tetap mode config).
  d.setMode(mode, mode === 'line-config' ? line : ifc);
  if (res.error) return res;
  return { output: res.output || '', syslog: res.syslog || null };
}

/* ---------------- global config ---------------- */

const HOSTNAME_RE = /^[A-Za-z][A-Za-z0-9-]{0,62}$/;

export function cmdHostname(ctx) {
  const name = ctx.args.name;
  if (!HOSTNAME_RE.test(name)) {
    // IOS: hostname harus diawali huruf.
    const idx = ctx.argIndices?.get?.('name');
    return { error: `Invalid hostname '${name}' (must start with a letter, alnum/hyphen only).`, caret: idx ? idx[0] : 0 };
  }
  const old = ctx.device.hostname;
  ctx.device.hostname = name;
  pushSyslog(ctx.world, ctx.device, `hostname changed from ${old} to ${name}`);
  return '';
}

const DEFAULT_HOSTNAMES = { router: 'Router', switch: 'Switch', pc: 'PC' };

export function cmdNoHostname(ctx) {
  ctx.device.hostname = DEFAULT_HOSTNAMES[ctx.device.type] || 'Device';
  return '';
}

/** `enable secret` / `enable password` — level diabaikan (satu level 15). */
export function cmdEnableSecret(ctx) {
  const d = ctx.device;
  const secret = ctx.args.secret;
  if (!secret) return { error: 'Incomplete command.', caret: 0 };
  const isPassword = /^\s*enable\s+pass/.test(ctx.line);
  d.enableSecret = { secret, level: ctx.args.level ? Number(ctx.args.level) : 15, kind: isPassword ? 'password' : 'secret' };
  return '';
}

export function cmdNoEnableSecret(ctx) {
  ctx.device.enableSecret = null;
  return '';
}

export function cmdLineConsole(ctx) {
  const d = ctx.device;
  const raw = ctx.args.lineType;
  const idx = ctx.args.index ?? '0';
  const end = ctx.args.endIdx;
  const kind = raw === 'con' || raw === 'console' ? 'console' : raw === 'aux' ? 'aux' : 'vty';
  const name = kind === 'vty'
    ? `vty ${idx}${end ? ` ${end}` : ''}`
    : `${kind} ${idx}`;
  if (!d.lineConfig[name]) d.lineConfig[name] = { password: null, login: false };
  d.setMode('line-config', name);
  return '';
}

export function cmdPasswordLine(ctx) {
  const cfg = ctx.device.currentLineCfg;
  if (!cfg) return { error: 'No line selected.', caret: 0 };
  cfg.password = ctx.args.secret;
  return '';
}

export function cmdNoPasswordLine(ctx) {
  const cfg = ctx.device.currentLineCfg;
  if (cfg) cfg.password = null;
  return '';
}

export function cmdLoginLine(ctx) {
  const cfg = ctx.device.currentLineCfg;
  if (!cfg) return { error: 'No line selected.', caret: 0 };
  cfg.login = true;
  return '';
}

export function cmdNoLoginLine(ctx) {
  const cfg = ctx.device.currentLineCfg;
  if (cfg) cfg.login = false;
  return '';
}

export function cmdBannerMotd(ctx) {
  ctx.device.bannerMotd = ctx.args.text.trim();
  return '';
}

export function cmdNoBannerMotd(ctx) {
  ctx.device.bannerMotd = null;
  return '';
}

export function cmdInterface(ctx) {
  const d = ctx.device;
  const canonical = d.normalizeInterfaceName(ctx.args.name);
  if (!canonical) {
    const idx = ctx.argIndices?.get?.('name');
    return {
      error: `Unknown or unsupported interface '${ctx.args.name}' for this ${d.type}.`,
      caret: idx ? idx[0] : 0,
    };
  }
  d.ensureInterface(canonical);
  d.setMode('interface-config', canonical);
  return '';
}

/** `interface range` — simulator memasuki mode interface-config interface pertama. */
export function cmdInterfaceRange(ctx) {
  const d = ctx.device;
  const first = ctx.args.range.split('-')[0].trim();
  const m = first.match(/^([A-Za-z]+)(\d+(?:\/\d+)*)$/);
  if (!m) return { error: `Invalid interface range '${ctx.args.range}'.`, caret: 0 };
  const canonical = d.normalizeInterfaceName(`${m[1]}${m[2]}`);
  if (!canonical) return { error: `Unknown or unsupported interface range '${ctx.args.range}'.`, caret: 0 };
  d.ensureInterface(canonical);
  d.setMode('interface-config', canonical);
  return '';
}

/* ---------------- interface config ---------------- */

export function cmdIpAddress(ctx) {
  const ifc = ctx.device.currentIf;
  if (!ifc) return { error: 'No interface selected.', caret: 0 };
  const badIp = badIpArg(ctx.args.ip, 'ip', ctx.argIndices);
  if (badIp !== null) return { error: `Invalid IPv4 address '${ctx.args.ip}'.`, caret: badIp };
  const badMask = badIpArg(ctx.args.mask, 'mask', ctx.argIndices);
  if (badMask !== null) return { error: `Invalid subnet mask '${ctx.args.mask}'.`, caret: badMask };

  ifc.ip = ctx.args.ip;
  ifc.mask = ctx.args.mask;
  return '';
}

export function cmdNoIpAddress(ctx) {
  const ifc = ctx.device.currentIf;
  if (!ifc) return { error: 'No interface selected.', caret: 0 };
  ifc.ip = null;
  ifc.mask = null;
  return '';
}

export function cmdShutdown(ctx) {
  const ifc = ctx.device.currentIf;
  if (!ifc) return { error: 'No interface selected.', caret: 0 };
  if (ifc.adminUp) {
    ifc.adminUp = false;
    refreshOperStatus(ctx.world);
    return {
      output: '',
      syslog: [
        color(`%LINK-5-CHANGED: Interface ${ctx.device.currentInterface}, changed state to administratively down`, ANSI.CYAN),
        color(`%LINEPROTO-5-UPDOWN: Line protocol on Interface ${ctx.device.currentInterface}, changed state to down`, ANSI.CYAN),
      ],
    };
  }
  return '';
}

export function cmdNoShutdown(ctx) {
  const ifc = ctx.device.currentIf;
  if (!ifc) return { error: 'No interface selected.', caret: 0 };
  if (!ifc.adminUp) {
    ifc.adminUp = true;
    refreshOperStatus(ctx.world);
    const name = ctx.device.currentInterface;
    const lines = [
      color(`%LINK-5-CHANGED: Interface ${name}, changed state to up`, ANSI.CYAN),
    ];
    // Line protocol hanya up bila ujung lain link juga up.
    refreshOperStatus(ctx.world);
    if (ifc.operUp) {
      lines.push(color(`%LINEPROTO-5-UPDOWN: Line protocol on Interface ${name}, changed state to up`, ANSI.CYAN));
    }
    return { output: '', syslog: lines };
  }
  return '';
}

export function cmdDescription(ctx) {
  const ifc = ctx.device.currentIf;
  if (!ifc) return { error: 'No interface selected.', caret: 0 };
  ifc.description = ctx.args.text.trim();
  return '';
}

export function cmdNoDescription(ctx) {
  const ifc = ctx.device.currentIf;
  if (!ifc) return { error: 'No interface selected.', caret: 0 };
  ifc.description = null;
  return '';
}

/* ---------------- routing statis ---------------- */

export function cmdIpRoute(ctx) {
  const d = ctx.device;
  if (!d.isRouter) return { error: 'Static routing is only available on routers.', caret: 0 };
  for (const [key, label] of [['network', 'network'], ['mask', 'mask'], ['nextHop', 'next-hop']]) {
    const bad = badIpArg(ctx.args[key], key, ctx.argIndices);
    if (bad !== null) return { error: `Invalid ${label} address '${ctx.args[key]}'.`, caret: bad };
  }
  d.addStaticRoute(ctx.args.network, ctx.args.mask, ctx.args.nextHop);
  return '';
}

export function cmdNoIpRoute(ctx) {
  const d = ctx.device;
  if (!d.isRouter) return { error: 'Static routing is only available on routers.', caret: 0 };
  const removed = d.removeStaticRoute(ctx.args.network, ctx.args.mask, ctx.args.nextHop);
  if (!removed) return { error: 'No matching static route to delete.', caret: 0 };
  return '';
}

/* ---------------- routing dinamis: RIP / OSPF / EIGRP ---------------- */

export function cmdRouterRip(ctx) {
  const d = ctx.device;
  d.setMode('router-config', { proto: 'rip' });
  d.currentRouterCfg; // buat konfigurasi bila belum ada
  return '';
}

export function cmdRouterOspf(ctx) {
  const d = ctx.device;
  const pid = Number(ctx.args.pid);
  if (!pid || pid > 65535) return { error: 'Invalid OSPF process ID.', caret: 0 };
  d.setMode('router-config', { proto: 'ospf', pid });
  d.currentRouterCfg;
  return '';
}

export function cmdRouterEigrp(ctx) {
  const d = ctx.device;
  const as = Number(ctx.args.as);
  if (!as || as > 65535) return { error: 'Invalid EIGRP autonomous system number.', caret: 0 };
  d.setMode('router-config', { proto: 'eigrp', as });
  d.currentRouterCfg;
  return '';
}

export function cmdNoRouter(ctx) {
  const d = ctx.device;
  const proto = ctx.args.proto;
  if ((proto === 'ospf' || proto === 'eigrp') && !ctx.args.id) {
    return { error: `Invalid input detected: 'no router ${proto}' requires ${proto === 'ospf' ? 'a process ID' : 'an AS number'}.`, caret: ctx.line.length };
  }
  d.removeRoutingProto(proto, ctx.args.id ? Number(ctx.args.id) : null);
  return '';
}

function addUniqueNetwork(cfg, entry) {
  const key = `${entry.network}|${entry.wildcard ?? ''}`;
  if (!cfg.networks.some((n) => `${n.network}|${n.wildcard ?? ''}` === key)) cfg.networks.push(entry);
}

export function cmdNetworkProto(ctx) {
  const d = ctx.device;
  const cfg = d.currentRouterCfg;
  const c = d.routerContext;
  if (!cfg || !c) return { error: 'No routing protocol context.', caret: 0 };
  const { net, wild, area } = ctx.args;

  const badNet = badIpArg(net, 'net', ctx.argIndices);
  if (badNet !== null) return { error: `Invalid network address '${net}'.`, caret: badNet };
  if (wild) {
    const badWild = badIpArg(wild, 'wild', ctx.argIndices);
    if (badWild !== null) return { error: `Invalid wildcard mask '${wild}'.`, caret: badWild };
  }

  if (c.proto === 'rip') {
    if (wild) return { error: "RIP 'network' command does not take a wildcard mask.", caret: ctx.argIndices?.get?.('wild')?.[0] ?? 0 };
    if (area) return { error: "RIP 'network' command does not take an area.", caret: 0 };
    const cf = classfulOf(net);
    if (!cf) return { error: `Invalid network '${net}'.`, caret: 0 };
    if (!cfg.networks.includes(cf.network)) cfg.networks.push(cf.network); // RIP: daftar string classful
    return '';
  }
  if (c.proto === 'eigrp') {
    if (area) return { error: "EIGRP 'network' command does not take an area.", caret: 0 };
    if (wild) {
      addUniqueNetwork(cfg, { network: applyWildcardToNetwork(net, wild), wildcard: wild });
    } else {
      const cf = classfulOf(net);
      if (!cf) return { error: `Invalid network '${net}'.`, caret: 0 };
      addUniqueNetwork(cfg, { network: cf.network });
    }
    return '';
  }
  // OSPF: wildcard wajib, area opsional (default 0).
  if (!wild) {
    return { error: 'OSPF requires a wildcard mask: network <net> <wildcard> area <area>', caret: ctx.line.length };
  }
  addUniqueNetwork(cfg, { network: applyWildcardToNetwork(net, wild), wildcard: wild, area: area ? Number(area) : 0 });
  return '';
}

/** Normalisasi network dgn wildcard: net & ~wild (ala IOS saat parsing). */
function applyWildcardToNetwork(net, wild) {
  const n = ipToInt(net);
  const w = ipToInt(wild);
  if (n === null || w === null) return net;
  const masked = (n & (~w >>> 0)) >>> 0;
  return [(masked >>> 24) & 255, (masked >>> 16) & 255, (masked >>> 8) & 255, masked & 255].join('.');
}

export function cmdNoNetworkProto(ctx) {
  const d = ctx.device;
  const cfg = d.currentRouterCfg;
  const c = d.routerContext;
  if (!cfg || !c) return { error: 'No routing protocol context.', caret: 0 };
  const { net, wild } = ctx.args;
  const target = wild ? applyWildcardToNetwork(net, wild) : classfulOf(net)?.network ?? net;
  const before = cfg.networks.length;
  cfg.networks = cfg.networks.filter((n) => {
    if (n.network !== target) return true;
    if (c.proto === 'ospf' && wild && n.wildcard !== wild) return true;
    return false;
  });
  if (cfg.networks.length === before) return { error: 'No matching network statement to delete.', caret: 0 };
  return '';
}

export function cmdVersionRip(ctx) {
  const d = ctx.device;
  if (d.routerContext?.proto !== 'rip') return { error: "'version' is only valid in RIP router configuration mode.", caret: 0 };
  d.currentRouterCfg.version = Number(ctx.args.v);
  return '';
}

export function cmdNoVersionRip(ctx) {
  const d = ctx.device;
  if (d.routerContext?.proto !== 'rip') return { error: "'no version' is only valid in RIP router configuration mode.", caret: 0 };
  d.currentRouterCfg.version = null;
  return '';
}

export function cmdAutoSummary(ctx) {
  const d = ctx.device;
  const cfg = d.currentRouterCfg;
  if (!cfg || (d.routerContext?.proto !== 'rip' && d.routerContext?.proto !== 'eigrp')) {
    return { error: "'auto-summary' is only valid in RIP/EIGRP router configuration mode.", caret: 0 };
  }
  cfg.autoSummary = true;
  return '';
}

export function cmdNoAutoSummary(ctx) {
  const d = ctx.device;
  const cfg = d.currentRouterCfg;
  if (!cfg || (d.routerContext?.proto !== 'rip' && d.routerContext?.proto !== 'eigrp')) {
    return { error: "'no auto-summary' is only valid in RIP/EIGRP router configuration mode.", caret: 0 };
  }
  cfg.autoSummary = false;
  return '';
}

export function cmdPassiveInterface(ctx) {
  const cfg = ctx.device.currentRouterCfg;
  if (!cfg) return { error: 'No routing protocol context.', caret: 0 };
  const name = ctx.device.normalizeInterfaceName(ctx.args.name);
  if (!name) return { error: `Unknown or unsupported interface '${ctx.args.name}'.`, caret: 0 };
  if (!cfg.passive) cfg.passive = [];
  if (!cfg.passive.includes(name)) cfg.passive.push(name);
  return '';
}

export function cmdNoPassiveInterface(ctx) {
  const cfg = ctx.device.currentRouterCfg;
  if (!cfg) return { error: 'No routing protocol context.', caret: 0 };
  const name = ctx.device.normalizeInterfaceName(ctx.args.name);
  if (!name) return { error: `Unknown or unsupported interface '${ctx.args.name}'.`, caret: 0 };
  cfg.passive = (cfg.passive || []).filter((p) => p !== name);
  return '';
}

export function cmdRouterId(ctx) {
  const d = ctx.device;
  if (d.routerContext?.proto !== 'ospf') return { error: "'router-id' is only valid in OSPF router configuration mode.", caret: 0 };
  const bad = badIpArg(ctx.args.ip, 'ip', ctx.argIndices);
  if (bad !== null) return { error: `Invalid router ID '${ctx.args.ip}'.`, caret: bad };
  d.currentRouterCfg.routerId = ctx.args.ip;
  return '';
}

/* ---------------- BGP (paritas NetSim) ---------------- */

export function cmdRouterBgp(ctx) {
  const d = ctx.device;
  const as = Number(ctx.args.as);
  if (!as || as > 65535) return { error: 'Invalid BGP autonomous system number.', caret: 0 };
  d.setMode('router-config', { proto: 'bgp', as });
  d.currentRouterCfg;
  return '';
}

export function cmdBgpNeighbor(ctx) {
  const d = ctx.device;
  const cfg = d.currentRouterCfg;
  if (!cfg || d.routerContext?.proto !== 'bgp') return { error: "'neighbor' is only valid in BGP router configuration mode.", caret: 0 };
  const bad = badIpArg(ctx.args.ip, 'ip', ctx.argIndices);
  if (bad !== null) return { error: `Invalid neighbor address '${ctx.args.ip}'.`, caret: bad };
  const ras = Number(ctx.args.ras);
  if (!ras || ras > 65535) return { error: 'Invalid remote AS number.', caret: 0 };
  cfg.neighbors[ctx.args.ip] = { remoteAs: ras };
  return '';
}

export function cmdNoBgpNeighbor(ctx) {
  const cfg = ctx.device.currentRouterCfg;
  if (!cfg || ctx.device.routerContext?.proto !== 'bgp') return { error: "'no neighbor' is only valid in BGP router configuration mode.", caret: 0 };
  if (!cfg.neighbors[ctx.args.ip]) return { error: 'No matching BGP neighbor to delete.', caret: 0 };
  delete cfg.neighbors[ctx.args.ip];
  return '';
}

export function cmdBgpNetwork(ctx) {
  const d = ctx.device;
  const cfg = d.currentRouterCfg;
  if (!cfg || d.routerContext?.proto !== 'bgp') return { error: "'network ... mask ...' is only valid in BGP router configuration mode.", caret: 0 };
  for (const [k, label] of [['net', 'network'], ['mask', 'mask']]) {
    const bad = badIpArg(ctx.args[k], k, ctx.argIndices);
    if (bad !== null) return { error: `Invalid ${label} address '${ctx.args[k]}'.`, caret: bad };
  }
  const key = { network: networkOf(ctx.args.net, ctx.args.mask), mask: ctx.args.mask };
  if (!cfg.networks.some((n) => n.network === key.network && n.mask === key.mask)) cfg.networks.push(key);
  return '';
}

export function cmdNoBgpNetwork(ctx) {
  const cfg = ctx.device.currentRouterCfg;
  if (!cfg || ctx.device.routerContext?.proto !== 'bgp') return { error: "'no network' is only valid in BGP router configuration mode.", caret: 0 };
  const key = { network: networkOf(ctx.args.net, ctx.args.mask), mask: ctx.args.mask };
  const before = cfg.networks.length;
  cfg.networks = cfg.networks.filter((n) => !(n.network === key.network && n.mask === key.mask));
  if (cfg.networks.length === before) return { error: 'No matching network statement to delete.', caret: 0 };
  return '';
}

/* ---------------- DHCP server (paritas NetSim) ---------------- */

export function cmdIpDhcpPool(ctx) {
  ctx.device.setMode('dhcp-config', ctx.args.name);
  ctx.device.currentDhcpPool;
  return '';
}

export function cmdNoIpDhcpPool(ctx) {
  const d = ctx.device;
  const before = d.dhcpPools.length;
  d.dhcpPools = d.dhcpPools.filter((p) => p.name !== ctx.args.name);
  if (d.dhcpPools.length === before) return { error: 'No matching DHCP pool to delete.', caret: 0 };
  return '';
}

export function cmdIpDhcpExcluded(ctx) {
  const d = ctx.device;
  for (const [k, label] of [['start', 'start'], ['end', 'end']]) {
    if (!ctx.args[k]) continue;
    const bad = badIpArg(ctx.args[k], k, ctx.argIndices);
    if (bad !== null) return { error: `Invalid ${label} address '${ctx.args[k]}'.`, caret: bad };
  }
  d.dhcpExcluded.push({ start: ctx.args.start, end: ctx.args.end ?? null });
  return '';
}

export function cmdDhcpNetwork(ctx) {
  const p = ctx.device.currentDhcpPool;
  if (!p) return { error: 'No DHCP pool context.', caret: 0 };
  const badNet = badIpArg(ctx.args.net, 'net', ctx.argIndices);
  if (badNet !== null) return { error: `Invalid network address '${ctx.args.net}'.`, caret: badNet };
  const badMask = badIpArg(ctx.args.mask, 'mask', ctx.argIndices);
  if (badMask !== null) return { error: `Invalid subnet mask '${ctx.args.mask}'.`, caret: badMask };
  p.network = networkOf(ctx.args.net, ctx.args.mask);
  p.mask = ctx.args.mask;
  return '';
}

export function cmdDhcpDefaultRouter(ctx) {
  const p = ctx.device.currentDhcpPool;
  if (!p) return { error: 'No DHCP pool context.', caret: 0 };
  const bad = badIpArg(ctx.args.ip, 'ip', ctx.argIndices);
  if (bad !== null) return { error: `Invalid gateway address '${ctx.args.ip}'.`, caret: bad };
  p.defaultRouter = ctx.args.ip;
  return '';
}

export function cmdDhcpDns(ctx) {
  const p = ctx.device.currentDhcpPool;
  if (!p) return { error: 'No DHCP pool context.', caret: 0 };
  const bad = badIpArg(ctx.args.ip, 'ip', ctx.argIndices);
  if (bad !== null) return { error: `Invalid DNS address '${ctx.args.ip}'.`, caret: bad };
  p.dnsServer = ctx.args.ip;
  return '';
}

/* ---------------- ACL standar (paritas NetSim) ---------------- */

function normalizeAclSrc(srcArg, wildArg) {
  if (srcArg === 'any') return { src: 'any', wildcard: null };
  if (srcArg.startsWith('host ')) return { src: srcArg.slice(5).trim(), wildcard: '0.0.0.0' };
  return { src: srcArg, wildcard: wildArg ?? '0.0.0.0' };
}

export function cmdAccessList(ctx) {
  const d = ctx.device;
  const num = Number(ctx.args.num);
  if (num < 1 || num > 99) return { error: 'Standard ACL number must be 1-99.', caret: 0 };
  const { src, wildcard } = normalizeAclSrc(ctx.args.src, ctx.args.wild);
  if (src !== 'any') {
    const bad = badIpArg(src, 'src', ctx.argIndices);
    if (bad !== null) return { error: `Invalid source address '${src}'.`, caret: bad };
    if (wildcard && badIpArg(wildcard, 'wild', ctx.argIndices) !== null) {
      return { error: `Invalid wildcard mask '${wildcard}'.`, caret: 0 };
    }
  }
  if (!d.acls[num]) d.acls[num] = [];
  d.acls[num].push({ action: ctx.args.action, src, wildcard: wildcard ?? '255.255.255.255' });
  return '';
}

export function cmdNoAccessList(ctx) {
  const d = ctx.device;
  const num = Number(ctx.args.num);
  if (!d.acls[num]) return { error: 'No matching access-list to delete.', caret: 0 };
  delete d.acls[num];
  // Lepaskan juga dari semua interface yang memakainya.
  for (const ifc of Object.values(d.interfaces)) {
    if (ifc.aclIn === num) ifc.aclIn = null;
    if (ifc.aclOut === num) ifc.aclOut = null;
  }
  d.natRules = (d.natRules || []).filter((r) => r.acl !== num);
  return '';
}

export function cmdIpAccessGroup(ctx) {
  const d = ctx.device;
  if (!d.currentIf) return { error: 'No interface selected.', caret: 0 };
  const num = Number(ctx.args.num);
  if (!d.acls[num]) return { error: `Access-list ${num} does not exist.`, caret: 0 };
  d.currentIf[ctx.args.dir === 'in' ? 'aclIn' : 'aclOut'] = num;
  return '';
}

export function cmdNoIpAccessGroup(ctx) {
  const d = ctx.device;
  if (!d.currentIf) return { error: 'No interface selected.', caret: 0 };
  const num = Number(ctx.args.num);
  if (ctx.args.dir) d.currentIf[ctx.args.dir === 'in' ? 'aclIn' : 'aclOut'] = null;
  else {
    if (d.currentIf.aclIn === num) d.currentIf.aclIn = null;
    if (d.currentIf.aclOut === num) d.currentIf.aclOut = null;
  }
  return '';
}

/* ---------------- NAT/PAT (paritas NetSim) ---------------- */

export function cmdIpNatRule(ctx) {
  const d = ctx.device;
  const acl = Number(ctx.args.acl);
  if (!d.acls[acl]) return { error: `Access-list ${acl} does not exist.`, caret: 0 };
  const ifName = d.normalizeInterfaceName(ctx.args.if);
  if (!ifName) return { error: `Unknown or unsupported interface '${ctx.args.if}'.`, caret: 0 };
  if (!d.natRules) d.natRules = [];
  d.natRules.push({ acl, outsideIf: ifName });
  return '';
}

export function cmdNoIpNatRule(ctx) {
  ctx.device.natRules = [];
  return '';
}

export function cmdIpNatSide(ctx) {
  const d = ctx.device;
  if (!d.currentIf) return { error: 'No interface selected.', caret: 0 };
  d.currentIf.nat = ctx.args.side;
  return '';
}

export function cmdNoIpNatSide(ctx) {
  const d = ctx.device;
  if (!d.currentIf) return { error: 'No interface selected.', caret: 0 };
  if (!ctx.args.side || d.currentIf.nat === ctx.args.side) d.currentIf.nat = null;
  return '';
}

/* ---------------- VLAN & switchport (paritas NetSim) ---------------- */

export function cmdVlanCreate(ctx) {
  const d = ctx.device;
  const id = Number(ctx.args.id);
  if (id < 1 || id > 4094) return { error: 'VLAN ID must be 1-4094.', caret: 0 };
  d.setMode('vlan-config', id);
  d.currentVlanCfg; // buat bila belum ada
  return '';
}

export function cmdVlanName(ctx) {
  const v = ctx.device.currentVlanCfg;
  if (!v) return { error: 'No VLAN context.', caret: 0 };
  v.name = ctx.args.text.trim();
  return '';
}

export function cmdNoVlan(ctx) {
  const d = ctx.device;
  const id = Number(ctx.args.id);
  if (id === 1) return { error: '% Default VLAN 1 may not be deleted.', caret: 0 };
  const before = d.vlans.length;
  d.vlans = d.vlans.filter((v) => v.id !== id);
  if (d.vlans.length === before) return { error: 'No matching VLAN to delete.', caret: 0 };
  // Port yang menunjuk VLAN ini kembali ke VLAN 1.
  for (const ifc of Object.values(d.interfaces)) {
    if (ifc.sw?.accessVlan === id) ifc.sw.accessVlan = 1;
    if (ifc.sw?.trunkNative === id) ifc.sw.trunkNative = 1;
  }
  return '';
}

export function cmdSwitchportMode(ctx) {
  const d = ctx.device;
  if (!d.currentIf) return { error: 'No interface selected.', caret: 0 };
  const sw = switchportOf(d, d.currentInterface);
  sw.mode = ctx.args.mode;
  return '';
}

export function cmdSwitchportAccessVlan(ctx) {
  const d = ctx.device;
  if (!d.currentIf) return { error: 'No interface selected.', caret: 0 };
  const id = Number(ctx.args.id);
  if (!d.vlans.some((v) => v.id === id)) return { error: `% Access VLAN ${id} does not exist.`, caret: 0 };
  const sw = switchportOf(d, d.currentInterface);
  sw.mode = 'access';
  sw.accessVlan = id;
  return '';
}

export function cmdSwitchportTrunkNative(ctx) {
  const d = ctx.device;
  if (!d.currentIf) return { error: 'No interface selected.', caret: 0 };
  const id = Number(ctx.args.id);
  if (!d.vlans.some((v) => v.id === id)) return { error: `% Native VLAN ${id} does not exist.`, caret: 0 };
  const sw = switchportOf(d, d.currentInterface);
  sw.mode = 'trunk';
  sw.trunkNative = id;
  return '';
}

export function cmdSwitchportTrunkAllowed(ctx) {
  const d = ctx.device;
  if (!d.currentIf) return { error: 'No interface selected.', caret: 0 };
  const sw = switchportOf(d, d.currentInterface);
  sw.mode = 'trunk';
  sw.trunkAllowed = ctx.args.list === 'all'
    ? 'all'
    : ctx.args.list.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  return '';
}

export function cmdNoSwitchportTrunkAllowed(ctx) {
  const d = ctx.device;
  if (!d.currentIf) return { error: 'No interface selected.', caret: 0 };
  const sw = switchportOf(d, d.currentInterface);
  sw.trunkAllowed = 'all';
  return '';
}

export function cmdSpanningTreePriority(ctx) {
  const d = ctx.device;
  const vlan = ctx.args.vlan ? Number(ctx.args.vlan) : 1;
  const prio = Number(ctx.args.prio);
  if (prio < 0 || prio > 61440 || prio % 4096 !== 0) {
    return { error: 'Priority must be 0-61440 in steps of 4096.', caret: 0 };
  }
  if (!d.vlanPriorities) d.vlanPriorities = {};
  d.vlanPriorities[vlan] = prio;
  return '';
}

/* ---------------- port & kabel (variasi port ala NetCLI) ---------------- */

export function cmdInterfaceAdd(ctx) {
  const d = ctx.device;
  const canonical = d.normalizeInterfaceName(ctx.args.name);
  if (!canonical) {
    return { error: `Nama port '${ctx.args.name}' tidak sah untuk perangkat ini. Contoh: fa0/5, gi0/2, serial0/0/0.`, caret: 0 };
  }
  if (d.interfaces[canonical]) return { error: `Port ${canonical} sudah ada di ${d.hostname}.`, caret: 0 };
  d.ensureInterface(canonical);
  return `% Port ${canonical} (tipe ${portTypeOf(canonical)}) ditambahkan ke ${d.hostname}. Masuk 'interface ${canonical.toLowerCase()}' untuk konfigurasi.`;
}

export function cmdClockRate(ctx) {
  const ifc = ctx.device.currentIf;
  if (!ifc) return { error: 'No interface selected.', caret: 0 };
  if (ifc.portType !== 'Serial') return { error: '% Clock rate hanya berlaku pada port Serial (sisi DCE).', caret: 0 };
  const rate = Number(ctx.args.rate);
  if (rate < 1200 || rate > 8000000) return { error: 'Clock rate harus 1200-8000000 bps.', caret: 0 };
  ifc.clockRate = rate;
  return '';
}

export function cmdConnect(ctx) {
  const d = ctx.device;
  const localIf = d.normalizeInterfaceName(ctx.args.if) || ctx.args.if;
  const other = ctx.world.devices.get(ctx.args.device) ||
    [...ctx.world.devices.values()].find((x) => x.hostname.toLowerCase() === ctx.args.device.toLowerCase());
  if (!other) return { error: `Perangkat '${ctx.args.device}' tidak ditemukan.`, caret: 0 };
  const remoteIf = other.normalizeInterfaceName(ctx.args.rif) || ctx.args.rif;
  const res = connectDevices(ctx.world, d, localIf, other, remoteIf);
  if (!res.ok) return { error: `% Kabel gagal dipasang: ${res.error}`, caret: 0 };
  return [
    `Kabel terpasang: ${d.hostname}:${localIf} <-> ${other.hostname}:${remoteIf}`,
    `Jenis kabel (otomatis): ${res.cable}`,
  ].join('\n');
}

export function cmdDisconnect(ctx) {
  const d = ctx.device;
  const localIf = d.normalizeInterfaceName(ctx.args.if) || ctx.args.if;
  const removed = disconnectDevices(ctx.world, d, localIf);
  if (!removed) return { error: `Tidak ada kabel di port ${localIf}.`, caret: 0 };
  return `% Kabel dilepas dari ${d.hostname}:${localIf} (link runtime hilang saat reset lab).`;
}

/* ---------------- role PC -> server ---------------- */

function requireServerRole(ctx) {
  const d = ctx.device;
  if (d.type !== 'pc' || d.role !== 'server') {
    return { error: "% Perintah ini hanya untuk server. Konversi dulu dengan 'role server'.", caret: 0 };
  }
  return null;
}

export function cmdRole(ctx) {
  const d = ctx.device;
  if (d.type !== 'pc') return { error: '% Konversi role hanya tersedia pada PC/server.', caret: 0 };
  if (d.role === ctx.args.role) return `% Role sudah '${d.role}'.`;
  d.role = ctx.args.role;
  return ctx.args.role === 'server'
    ? `% ${d.hostname} dikonversi menjadi SERVER. Konfigurasi service:\n   service dhcp on | service dns on | service http on | service tftp on | service syslog on\n   (lihat status: show services)`
    : `% ${d.hostname} kembali berperan sebagai PC biasa (service tidak lagi dilayani).`;
}

/* ---------------- service server (DHCP/DNS/HTTP/TFTP/Syslog) ---------------- */

export function cmdServiceDhcpToggle(ctx) {
  const err = requireServerRole(ctx);
  if (err) return err;
  ctx.device.services.dhcp.on = ctx.args.act === 'on';
  return `% DHCP server ${ctx.args.act === 'on' ? 'aktif' : 'nonaktif'} pada ${ctx.device.hostname}.`;
}

export function cmdServiceDhcpRange(ctx) {
  const err = requireServerRole(ctx);
  if (err) return err;
  for (const [k, label] of [['start', 'start'], ['end', 'end']]) {
    const bad = badIpArg(ctx.args[k], k, ctx.argIndices);
    if (bad !== null) return { error: `Invalid ${label} address '${ctx.args[k]}'.`, caret: bad };
  }
  if (ipToInt(ctx.args.start) >= ipToInt(ctx.args.end)) {
    return { error: 'Start address harus lebih kecil dari end address.', caret: 0 };
  }
  ctx.device.services.dhcp.start = ctx.args.start;
  ctx.device.services.dhcp.end = ctx.args.end;
  return `% DHCP range: ${ctx.args.start} - ${ctx.args.end}.`;
}

export function cmdServiceDhcpGateway(ctx) {
  const err = requireServerRole(ctx);
  if (err) return err;
  const bad = badIpArg(ctx.args.ip, 'ip', ctx.argIndices);
  if (bad !== null) return { error: `Invalid gateway address '${ctx.args.ip}'.`, caret: bad };
  ctx.device.services.dhcp.gateway = ctx.args.ip;
  return `% DHCP gateway: ${ctx.args.ip}.`;
}

export function cmdServiceDhcpDns(ctx) {
  const err = requireServerRole(ctx);
  if (err) return err;
  const bad = badIpArg(ctx.args.ip, 'ip', ctx.argIndices);
  if (bad !== null) return { error: `Invalid DNS address '${ctx.args.ip}'.`, caret: bad };
  ctx.device.services.dhcp.dns = ctx.args.ip;
  return `% DHCP DNS: ${ctx.args.ip}.`;
}

export function cmdServiceDnsToggle(ctx) {
  const err = requireServerRole(ctx);
  if (err) return err;
  ctx.device.services.dns.on = ctx.args.act === 'on';
  return `% DNS server ${ctx.args.act === 'on' ? 'aktif' : 'nonaktif'} pada ${ctx.device.hostname}.`;
}

export function cmdServiceDnsAdd(ctx) {
  const err = requireServerRole(ctx);
  if (err) return err;
  const bad = badIpArg(ctx.args.ip, 'ip', ctx.argIndices);
  if (bad !== null) return { error: `Invalid address '${ctx.args.ip}'.`, caret: bad };
  const recs = ctx.device.services.dns.records;
  const existing = recs.find((r) => r.name === ctx.args.name);
  if (existing) existing.ip = ctx.args.ip;
  else recs.push({ name: ctx.args.name, ip: ctx.args.ip });
  return `% DNS record: ${ctx.args.name} -> ${ctx.args.ip}.`;
}

export function cmdServiceDnsRemove(ctx) {
  const err = requireServerRole(ctx);
  if (err) return err;
  const recs = ctx.device.services.dns.records;
  const before = recs.length;
  ctx.device.services.dns.records = recs.filter((r) => r.name !== ctx.args.name);
  if (ctx.device.services.dns.records.length === before) return { error: `Record '${ctx.args.name}' tidak ada.`, caret: 0 };
  return `% DNS record '${ctx.args.name}' dihapus.`;
}

export function cmdServiceHttpToggle(ctx) {
  const err = requireServerRole(ctx);
  if (err) return err;
  ctx.device.services.http.on = ctx.args.act === 'on';
  return `% HTTP server ${ctx.args.act === 'on' ? 'aktif' : 'nonaktif'} pada ${ctx.device.hostname} (uji dengan: web http://${ctx.device.hostname.toLowerCase()}).`;
}

export function cmdServiceTftpToggle(ctx) {
  const err = requireServerRole(ctx);
  if (err) return err;
  ctx.device.services.tftp.on = ctx.args.act === 'on';
  return `% TFTP server ${ctx.args.act === 'on' ? 'aktif' : 'nonaktif'} pada ${ctx.device.hostname} (uji dengan: copy running-config tftp://${ctx.device.interfaces[Object.keys(ctx.device.interfaces)[0]]?.ip}/backup).`;
}

export function cmdServiceSyslogToggle(ctx) {
  const err = requireServerRole(ctx);
  if (err) return err;
  ctx.device.services.syslog.on = ctx.args.act === 'on';
  return `% Syslog server ${ctx.args.act === 'on' ? 'aktif' : 'nonaktif'} pada ${ctx.device.hostname} (arahkan router: logging <ip server>).`;
}

export function showServices(ctx) {
  const d = ctx.device;
  const s = d.services;
  const st = (on) => (on ? 'ON' : 'off');
  return [
    `Services pada ${d.hostname} (role: ${d.role})`,
    '',
    `${pad('Service', 10)}${pad('Status', 8)}Detail`,
    `${pad('DHCP', 10)}${pad(st(s.dhcp.on), 8)}${s.dhcp.on ? `range ${s.dhcp.start ?? '-'} - ${s.dhcp.end ?? '-'}, gw ${s.dhcp.gateway ?? '-'}, dns ${s.dhcp.dns ?? '-'}` : '-'}`,
    `${pad('DNS', 10)}${pad(st(s.dns.on), 8)}${s.dns.records.length} record${s.dns.records.length ? ': ' + s.dns.records.map((r) => r.name).join(', ') : ''}`,
    `${pad('HTTP', 10)}${pad(st(s.http.on), 8)}port 80, halaman index.html`,
    `${pad('TFTP', 10)}${pad(st(s.tftp.on), 8)}port 69, ${Object.keys(s.tftp.files).length} file tersimpan`,
    `${pad('FTP', 10)}${pad(st(s.ftp.on), 8)}port 21, ${Object.keys(s.ftp.files).length} file`,
    `${pad('SYSLOG', 10)}${pad(st(s.syslog.on), 8)}port 514, ${s.syslog.log.length} pesan diterima`,
    `${pad('NTP', 10)}${pad(st(s.ntp.on), 8)}port 123 (stratum 1)`,
  ].join('\n');
}

/* ---------------- utility client ala NetCLI (nslookup/netstat/telnet/web) ---------------- */

function dnsLookupDetailed(world, name) {
  const dns = world.meta?.dns || {};
  if (Object.prototype.hasOwnProperty.call(dns, name)) return { ip: dns[name], server: 'DNS statis lab' };
  for (const dev of world.devices.values()) {
    if (dev.type !== 'pc' || dev.role !== 'server' || !dev.services?.dns?.on) continue;
    for (const rec of dev.services.dns.records) {
      if (rec.name.toLowerCase() === name.toLowerCase()) return { ip: rec.ip, server: `${dev.hostname} (${rec.name} server DNS)` };
    }
  }
  return null;
}

export function cmdNslookup(ctx) {
  const res = dnsLookupDetailed(ctx.world, ctx.args.name);
  if (!res) return `*** Server can't find ${ctx.args.name}: Non-existent domain`;
  return [
    `Server:  ${res.server}`,
    '',
    `Name:    ${ctx.args.name}`,
    `Address: ${res.ip}`,
  ].join('\n');
}

export function cmdNetstat(ctx) {
  const d = ctx.device;
  const ifc = Object.values(d.interfaces)[0];
  const lines = [
    'Active Connections (simulasi ala Windows netstat)',
    '',
    `${pad('Proto', 7)}${pad('Local Address', 26)}${pad('Foreign Address', 26)}State`,
    `${pad('UDP', 7)}${pad(`${ifc?.ip ?? '0.0.0.0'}:137`, 26)}${pad('*:*', 26)}LISTENING`,
  ];
  const svc = d.services || {};
  const listens = [];
  if (svc.dns?.on) listens.push(['TCP', ':53 (DNS)']);
  if (svc.http?.on) listens.push(['TCP', ':80 (HTTP)']);
  if (svc.tftp?.on) listens.push(['UDP', ':69 (TFTP)']);
  if (svc.syslog?.on) listens.push(['UDP', ':514 (SYSLOG)']);
  for (const [proto, desc] of listens) {
    lines.push(`${pad(proto, 7)}${pad(`${ifc?.ip ?? '0.0.0.0'}${desc}`, 26)}${pad('0.0.0.0:0', 26)}LISTENING`);
  }
  for (const e of (d.arpTable || []).slice(0, 8)) {
    lines.push(`${pad('TCP', 7)}${pad(`${ifc?.ip ?? '0.0.0.0'}:${1020 + (e.ip.split('.').reduce((a, b) => a + Number(b), 0) % 800)}`, 26)}${pad(`${e.ip}:445`, 26)}ESTABLISHED`);
  }
  return lines.join('\n');
}

export function cmdTelnet(ctx) {
  const d = ctx.device;
  const resolv = resolveTarget(ctx.world, ctx.args.target);
  if (!resolv) return color(`% Translating "${ctx.args.target}"...domain server (255.255.255.255)\n% Unrecognized host or address`, ANSI.YELLOW);
  const target = findDeviceByIp(ctx.world, resolv.ip)?.device;
  if (!target) return { error: `Tidak ada perangkat dengan IP ${resolv.ip}.`, caret: 0 };
  if (target.id === d.id) return { error: '% Tidak bisa telnet ke diri sendiri.', caret: 0 };
  if (target.type === 'pc') return { error: '% Telnet hanya ke router/switch (PC/server tidak menjalankan telnet server).', caret: 0 };
  const reach = pingFrom(ctx.world, d, resolv.ip);
  if (!reach.ok) return color('% Request timed out (perangkat tidak terjangkau).', ANSI.YELLOW);
  d.telnetSession = target.id;
  return `Trying ${resolv.ip} ... Open\n\n${target.bannerMotd ? target.bannerMotd + '\n\n' : ''}(sesi telnet ke ${target.hostname} — ketik perintah IOS, akhiri dengan 'exit')`;
}

export function cmdWeb(ctx) {
  const d = ctx.device;
  let url = ctx.args.url.replace(/^https?:\/\//i, '');
  const [host, ...pathParts] = url.split('/');
  const path = pathParts.join('/') || 'index.html';
  const resolv = resolveTarget(ctx.world, host);
  if (!resolv) return color(`% Host ${host} tidak dikenal (cek DNS dengan 'nslookup ${host}').`, ANSI.YELLOW);
  const server = findDeviceByIp(ctx.world, resolv.ip)?.device;
  if (!server) return { error: `Tidak ada perangkat dengan IP ${resolv.ip}.`, caret: 0 };
  const reach = pingFrom(ctx.world, d, resolv.ip);
  if (!reach.ok) return color('Request timed out (server tidak terjangkau).', ANSI.YELLOW);
  if (server.type !== 'pc' || server.role !== 'server' || !server.services?.http?.on) {
    return color(`HTTP request gagal: tidak ada web server di ${host}.`, ANSI.YELLOW);
  }
  const page = server.services.http.pages[path];
  if (!page) {
    return [`Connecting to ${host} (${resolv.ip})...`, 'HTTP/1.1 404 Not Found', '', `Halaman '${path}' tidak ada (coba index.html).`].join('\n');
  }
  const text = page.replace(/<[^>]+>/g, (m) => (/<(h[1-3]|p|br|li)/i.test(m) ? '\n' : '')).replace(/\n{2,}/g, '\n').trim();
  return [
    `Connecting to ${host} (${resolv.ip})...`,
    'HTTP/1.1 200 OK',
    `Server: ${server.hostname} (NetQuest HTTP service)`,
    `Content-Type: text/html`,
    '',
    text,
  ].join('\n');
}

/* ---------------- syslog & TFTP ---------------- */

export function cmdLoggingHost(ctx) {
  const d = ctx.device;
  const bad = badIpArg(ctx.args.ip, 'ip', ctx.argIndices);
  if (bad !== null) return { error: `Invalid address '${ctx.args.ip}'.`, caret: bad };
  d.loggingHost = ctx.args.ip;
  pushSyslog(ctx.world, d, `Logging to ${ctx.args.ip} configured`);
  return `% Syslog dikirim ke ${ctx.args.ip} (service syslog on di server tsb).`;
}

export function cmdNoLoggingHost(ctx) {
  ctx.device.loggingHost = null;
  return '% Logging host dihapus.';
}

export function showLogging(ctx) {
  const d = ctx.device;
  const lines = [
    `Syslog logging: enabled (0 messages dropped)`,
    `Logging to ${d.loggingHost ?? 'no server configured'}`,
    '',
  ];
  const buf = d.loggingBuffer || [];
  if (!buf.length) lines.push('(buffer kosong — lakukan perubahan konfigurasi)');
  for (const e of buf) lines.push(`[${e.since.slice(11, 19)}] ${e.text}`);
  return lines.join('\n');
}

export function cmdCopyTftpSave(ctx) {
  const d = ctx.device;
  const server = findDeviceByIp(ctx.world, ctx.args.ip)?.device;
  if (!server || server.type !== 'pc' || server.role !== 'server' || !server.services?.tftp?.on) {
    return { error: `TFTP server tidak tersedia di ${ctx.args.ip} (aktifkan: role server + service tftp on).`, caret: 0 };
  }
  const reach = pingFrom(ctx.world, d, ctx.args.ip);
  if (!reach.ok) return color('TFTP write: request timed out (server tidak terjangkau).', ANSI.YELLOW);
  const text = showRunningConfig(ctx);
  server.services.tftp.files[ctx.args.file] = text;
  return `Accessing tftp://${ctx.args.ip}/${ctx.args.file}... Writing running-config !!!!! [OK - ${text.length} bytes]`;
}

export function cmdCopyTftpLoad(ctx) {
  const d = ctx.device;
  const server = findDeviceByIp(ctx.world, ctx.args.ip)?.device;
  if (!server || server.type !== 'pc' || server.role !== 'server' || !server.services?.tftp?.on) {
    return { error: `TFTP server tidak tersedia di ${ctx.args.ip}.`, caret: 0 };
  }
  const reach = pingFrom(ctx.world, d, ctx.args.ip);
  if (!reach.ok) return color('TFTP read: request timed out (server tidak terjangkau).', ANSI.YELLOW);
  const text = server.services.tftp.files[ctx.args.file];
  if (!text) return { error: `File '${ctx.args.file}' tidak ada di TFTP server (yang tersedia: ${Object.keys(server.services.tftp.files).join(', ') || 'kosong'}).`, caret: 0 };
  // Terapkan baris per baris lewat parser (round-trip config kita sendiri).
  const skip = /^(version |service |enable secret 5|banner motd|!|$)/;
  let applied = 0;
  for (const line of text.split('\n')) {
    if (skip.test(line)) continue;
    ctx.execute(d, line, ctx.world);
    applied++;
  }
  return `Accessing tftp://${ctx.args.ip}/${ctx.args.file}... Loading running-config !!!!! [OK - ${text.length} bytes, ${applied} baris diterapkan]`;
}

/* ---------------- SSH / FTP / NTP ---------------- */

export function cmdIpDomainName(ctx) {
  ctx.device.ssh = ctx.device.ssh || { domain: null, keyModulus: null };
  ctx.device.ssh.domain = ctx.args.domain;
  return `% Domain name di-set: ${ctx.args.domain} (langkah SSH berikutnya: crypto key generate rsa).`;
}

export function cmdCryptoKey(ctx) {
  const d = ctx.device;
  if (!d.ssh?.domain) {
    return { error: '% Please create a hostname and ip domain-name first (crypto key butuh domain).', caret: 0 };
  }
  const mod = Number(ctx.args.mod || 1024);
  d.ssh.keyModulus = mod;
  return [
    `Generating RSA keys ...`,
    `[OK]`,
    ``,
    `RSA key dengan modulus ${mod} berhasil dibuat untuk ${d.hostname}.${d.ssh.domain}.`,
    `SSH server aktif (uji dari PC: ssh ${d.hostname.toLowerCase()}).`,
  ].join('\n');
}

export function showIpSsh(ctx) {
  const d = ctx.device;
  const on = !!(d.ssh?.keyModulus);
  return [
    `SSH Enabled - version ${on ? '2.0' : '-'}`,
    `Authentication methods: password, local`,
    `Domain: ${d.ssh?.domain ?? 'belum di-set'}`,
    `RSA key modulus: ${d.ssh?.keyModulus ?? 'belum dibuat'}`,
    `Transport input: ${on ? 'ssh' : 'telnet'}`,
  ].join('\n');
}

export function cmdNtpServer(ctx) {
  const d = ctx.device;
  d.ntpServer = ctx.args.ip;
  const server = findDeviceByIp(ctx.world, ctx.args.ip)?.device;
  const svc = server && (server.services?.ntp?.on || server.type !== 'pc');
  return [
    `% NTP server dikonfigurasi: ${ctx.args.ip}`,
    ...(svc ? ['% Sinkronisasi berjalan (cek: show ntp status).'] : ['% Perhatian: NTP service di server tersebut belum aktif (service ntp on).']),
  ].join('\n');
}

export function cmdNoNtpServer(ctx) {
  ctx.device.ntpServer = null;
  return '% NTP server dihapus.';
}

/** Helper status NTP — dipakai handler & test. */
export function ntpStatus(world, dev) {
  if (!dev.ntpServer) return { synced: false, server: null };
  const server = findDeviceByIp(world, dev.ntpServer)?.device;
  const svcOn = server && (server.services?.ntp?.on || server.type !== 'pc');
  if (!svcOn) return { synced: false, server: dev.ntpServer, reason: 'service NTP tidak aktif' };
  const reach = pingFrom(world, dev, dev.ntpServer);
  if (!reach.ok) return { synced: false, server: dev.ntpServer, reason: 'server tidak terjangkau' };
  return { synced: true, server: dev.ntpServer, stratum: 2, ref: server.hostname };
}

export function showNtp(ctx) {
  const st = ntpStatus(ctx.world, ctx.device);
  const now = new Date();
  if (!st.synced) {
    return [
      `Clock is unsynchronized, stratum 16, reference is ${st.server ?? 'none'}`,
      ...(st.reason ? [`  (${st.reason})`] : []),
      ``,
      `Waktu lokal: ${now.toISOString().slice(0, 19).replace('T', ' ')} UTC`,
    ].join('\n');
  }
  return [
    `Clock is synchronized, stratum ${st.stratum}, reference is ${st.server}`,
    `Nominal freq is 250.0000 Hz, actual freq is 249.9995 Hz`,
    ``,
    `Waktu tersinkron: ${now.toISOString().slice(0, 19).replace('T', ' ')} UTC (dari ${st.ref})`,
  ].join('\n');
}

export function cmdServiceFtpToggle(ctx) {
  const err = requireServerRole(ctx);
  if (err) return err;
  ctx.device.services.ftp.on = ctx.args.act === 'on';
  return `% FTP server ${ctx.args.act === 'on' ? 'aktif' : 'nonaktif'} pada ${ctx.device.hostname} (uji dari PC: ftp ${ctx.device.hostname.toLowerCase()}).`;
}

export function cmdServiceNtpToggle(ctx) {
  const err = requireServerRole(ctx);
  if (err) return err;
  ctx.device.services.ntp.on = ctx.args.act === 'on';
  return `% NTP server ${ctx.args.act === 'on' ? 'aktif' : 'nonaktif'} pada ${ctx.device.hostname} (arahkan router: ntp server <ip>).`;
}

export function cmdSsh(ctx) {
  const d = ctx.device;
  const resolv = resolveTarget(ctx.world, ctx.args.target);
  if (!resolv) return color(`% Translating "${ctx.args.target}"...domain server (255.255.255.255)\n% Unrecognized host or address`, ANSI.YELLOW);
  const target = findDeviceByIp(ctx.world, resolv.ip)?.device;
  if (!target) return { error: `Tidak ada perangkat dengan IP ${resolv.ip}.`, caret: 0 };
  if (target.id === d.id) return { error: '% Tidak bisa SSH ke diri sendiri.', caret: 0 };
  if (target.type === 'pc') return { error: '% SSH hanya ke router/switch.', caret: 0 };
  if (!target.ssh?.keyModulus) return color(`% SSH gagal: ${target.hostname} belum menjalankan crypto key generate rsa.`, ANSI.YELLOW);
  const reach = pingFrom(ctx.world, d, resolv.ip);
  if (!reach.ok) return color('% Connection timed out (perangkat tidak terjangkau).', ANSI.YELLOW);
  d.telnetSession = target.id;
  return `Trying ${resolv.ip}...\n\nSSH-2.0-NetQuest_1.0\n\nLogin autentikasi via password vty.\n(sesi SSH ke ${target.hostname} — ketik perintah IOS, akhiri dengan 'exit')`;
}

export function cmdFtp(ctx) {
  const d = ctx.device;
  const resolv = resolveTarget(ctx.world, ctx.args.target);
  if (!resolv) return color(`% Translating "${ctx.args.target}"...domain server (255.255.255.255)\n% Unrecognized host or address`, ANSI.YELLOW);
  const target = findDeviceByIp(ctx.world, resolv.ip)?.device;
  if (!target || target.type !== 'pc' || target.role !== 'server' || !target.services?.ftp?.on) {
    return { error: `FTP server tidak tersedia di '${ctx.args.target}' (aktifkan: role server + service ftp on).`, caret: 0 };
  }
  const reach = pingFrom(ctx.world, d, resolv.ip);
  if (!reach.ok) return color('ftp: connect: Connection timed out (server tidak terjangkau).', ANSI.YELLOW);
  d.ftpSession = target.id;
  return `Connected to ${resolv.ip}.\n220 NetQuest FTP server ready (${target.hostname})\nRemote system type is UNIX.\nGunakan: ls, get <file>, bye`;
}

/* ---------------- SHOW: dihasilkan dinamis dari state ---------------- */

export function showIpInterfaceBrief(ctx) {
  const d = ctx.device;
  const lines = [];
  lines.push(`${pad('Interface', 27)}${pad('IP-Address', 16)}${pad('OK?', 4)}${pad('Method', 7)}${pad('Status', 22)}Protocol`);
  for (const [name, ifc] of Object.entries(d.interfaces)) {
    const ip = ifc.ip ?? 'unassigned';
    const method = ifc.ip ? 'manual' : 'unset';
    lines.push(
      `${pad(name, 27)}${pad(ip, 16)}${pad('YES', 4)}${pad(method, 7)}${pad(statusOf(ifc), 22)}${pad(protocolOf(ifc), 10)}`
    );
  }
  return lines.join('\n');
}

export function showIpInterface(ctx) {
  const d = ctx.device;
  const blocks = [];
  for (const [name, ifc] of Object.entries(d.interfaces)) {
    const st = statusOf(ifc);
    blocks.push(
      [
        `${name} is ${ifc.operUp ? 'up' : 'down'}, line protocol is ${protocolOf(ifc)}`,
        `  Internet address is ${ifc.ip ? `${ifc.ip}/${maskToPrefix(ifc.mask ?? '255.255.255.255')}` : 'not set'}`,
        `  Broadcast address is ${ifc.ip ? networkOf(ifc.ip, ifc.mask ?? '255.255.255.255').replace(/\.0$/, '.255') : 'not set'}`,
        '  MTU 1500 bytes, BW 1000000 Kbit/sec, DLY 10 usec',
        `  ${ifc.adminUp ? '' : 'administratively '}shutdown state: ${st}`,
        ifc.description ? `  Description: ${ifc.description}` : null,
      ].filter(Boolean).join('\n')
    );
  }
  return blocks.join('\n');
}

/** Uptime sejak world boot, format hh:mm:ss (utk kolom umur rute dinamis). */
function uptimeStr(world) {
  const s = Math.max(0, Math.floor((Date.now() - (world.bootTime ?? Date.now())) / 1000));
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(Math.floor(s / 3600))}:${p2(Math.floor((s % 3600) / 60))}:${p2(s % 60)}`;
}

function routeLine(r, world) {
  const netField = `${r.network}/${r.prefix}`;
  switch (r.type) {
    case 'C':
    case 'L':
      return `${r.type}${padLeft(netField, 18)} is directly connected, ${r.interface}`;
    case 'S': {
      const isDefault = r.network === '0.0.0.0' && r.mask === '0.0.0.0';
      return `${isDefault ? 'S*' : 'S'}${padLeft(netField, 18)} [1/0] via ${r.via}`;
    }
    default: // R (RIP) / O (OSPF) / D (EIGRP)
      return `${r.type}${padLeft(netField, 18)} [${r.distance}/${r.metric}] via ${r.via}, ${uptimeStr(world)}, ${r.interface}`;
  }
}

export function showIpRoute(ctx) {
  const d = ctx.device;
  const rows = routingTable(ctx.world, d);
  const lines = [
    'Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP',
    '       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area',
    '       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2',
    '       E1 - OSPF external type 1, E2 - OSPF external type 2, E - EGP',
    '       i - IS-IS, su - IS-IS summary, L1 - IS-IS level-1, L2 - IS-IS level-2',
    '       ia - IS-IS inter area, * - candidate default, U - per-user static route',
    '       o - ODR, P - periodic downloaded static route, H - NHRP, l - LISP',
    '       a - application route, + - replicated route, % - next hop override',
    '',
  ];
  const def = rows.find((r) => r.network === '0.0.0.0' && r.mask === '0.0.0.0');
  lines.push(def ? `Gateway of last resort is ${def.via} to network 0.0.0.0` : 'Gateway of last resort is not set');
  if (rows.length === 0) {
    lines.push('', '(routing table kosong — tidak ada interface up ber-IP dan belum ada rute)');
    return lines.join('\n');
  }
  lines.push('');

  // Kelompokkan per major network classful (ala IOS), 0.0.0.0 selalu terakhir.
  const groups = new Map();
  for (const r of rows) {
    const cf = classfulOf(r.network) || { network: '0.0.0.0', prefix: 0 };
    if (!groups.has(cf.network)) groups.set(cf.network, []);
    groups.get(cf.network).push(r);
  }
  const keys = [...groups.keys()].sort((a, b) => ipToInt(a) - ipToInt(b));
  if (keys.includes('0.0.0.0')) {
    keys.splice(keys.indexOf('0.0.0.0'), 1);
    keys.push('0.0.0.0');
  }
  for (const k of keys) {
    const grp = groups.get(k).sort(
      (a, b) => (ipToInt(a.network) - ipToInt(b.network)) || (a.prefix - b.prefix)
    );
    if (grp.length > 1) {
      const maskCount = new Set(grp.map((r) => r.prefix)).size;
      const majorPrefix = classfulOf(k)?.prefix ?? 0;
      lines.push(
        maskCount > 1
          ? `      ${k}/${majorPrefix} is variably subnetted, ${grp.length} subnets, ${maskCount} masks`
          : `      ${k}/${majorPrefix} is subnetted, ${grp.length} subnets`
      );
    }
    for (const r of grp) lines.push(routeLine(r, ctx.world));
  }
  return lines.join('\n');
}

export function showIpRouteNetwork(ctx) {
  const target = ctx.args.network;
  const rows = routingTable(ctx.world, ctx.device).filter((r) => r.network === target);
  if (rows.length === 0) return '% Network not in table';
  const blocks = [];
  for (const r of rows) {
    const connected = r.type === 'C' || r.type === 'L';
    const known = connected ? 'connected' : r.type === 'S' ? 'static' : r.procLabel;
    const dist = connected ? 0 : r.distance;
    const met = connected ? 0 : (r.metric ?? 0);
    const viaDesc = r.via ? r.via : `directly connected, via ${r.interface}`;
    blocks.push([
      `Routing entry for ${r.network}/${r.prefix}`,
      `  Known via "${known}", distance ${dist}, metric ${met}${connected ? ' (connected)' : ''}`,
      '  Routing Descriptor Blocks:',
      `  * ${viaDesc}`,
      `      Route metric is ${met}, traffic share count is 1`,
      '',
    ].join('\n'));
  }
  return blocks.join('\n').trimEnd();
}

/**
 * Konfigurasi lengkap sebuah "snapshot" device (dipakai show running-config
 * dan show startup-config). Snapshot = objek CiscoDevice hasil clone.
 */
export function formatConfig(d, { building = 'Building configuration...' } = {}) {
  const body = configBody(d);
  const head = [building, '', `Current configuration : ${body.length} bytes`, '!'];
  return [...head, ...body, 'end', ''].join('\n');
}

function configBody(d) {
  const out = [];
  if (!d.isPc) out.push('version 15.2', 'service timestamps log datetime msec', 'no service password-encryption', '!');
  if (d.bannerMotd) {
    out.push('banner motd ^', ...d.bannerMotd.split('\n'), '^', '!');
  }
  out.push(`hostname ${d.hostname}`, '!');
  if (d.enableSecret) {
    out.push(
      d.enableSecret.kind === 'password'
        ? `enable password ${d.enableSecret.secret}`
        : `enable secret 5 $1$mERr$hx5rVt7rPNoS4wqbXKX7m0`,
      '!'
    );
  }
  // VLAN database switch (VLAN 1 default tidak ditulis ulang).
  if (d.isSwitch) {
    for (const v of d.vlans) {
      if (v.id === 1 && v.name === 'default') continue;
      out.push(`vlan ${v.id}`);
      if (v.name) out.push(` name ${v.name}`);
      out.push('!');
    }
  }
  for (const [name, cfg] of Object.entries(d.lineConfig)) {
    out.push(`line ${name}`);
    if (cfg.password) out.push(` password ${cfg.password}`);
    if (cfg.login) out.push(' login');
    out.push('!');
  }
  const sorted = Object.entries(d.interfaces).sort(([a], [b]) => a.localeCompare(b));
  for (const [name, ifc] of sorted) {
    out.push(`interface ${name}`);
    if (ifc.description) out.push(` description ${ifc.description}`);
    if (ifc.ip && ifc.mask && !d.isPc) out.push(` ip address ${ifc.ip} ${ifc.mask}`);
    if (ifc.sw) {
      if (ifc.sw.mode === 'trunk') {
        out.push(' switchport mode trunk');
        if (ifc.sw.trunkNative !== 1) out.push(` switchport trunk native vlan ${ifc.sw.trunkNative}`);
        if (ifc.sw.trunkAllowed !== 'all') out.push(` switchport trunk allowed vlan ${ifc.sw.trunkAllowed.join(',')}`);
      } else if (ifc.sw.accessVlan !== 1) {
        out.push(' switchport mode access');
        out.push(` switchport access vlan ${ifc.sw.accessVlan}`);
      }
    }
    if (ifc.aclIn != null) out.push(` ip access-group ${ifc.aclIn} in`);
    if (ifc.aclOut != null) out.push(` ip access-group ${ifc.aclOut} out`);
    if (ifc.nat) out.push(` ip nat ${ifc.nat}`);
    if (!ifc.adminUp) out.push(' shutdown');
    out.push('!');
  }
  if (d.isRouter && d.routes.length) {
    for (const r of d.routes) out.push(`ip route ${r.network} ${r.mask} ${r.nextHop}`, '!');
  }
  const rt = d.routing || {};
  if (rt.rip) {
    out.push('router rip');
    if (rt.rip.version) out.push(` version ${rt.rip.version}`);
    for (const n of rt.rip.networks) out.push(` network ${n}`);
    if (!rt.rip.autoSummary) out.push(' no auto-summary');
    for (const p of rt.rip.passive || []) out.push(` passive-interface ${p}`);
    out.push('!');
  }
  for (const [pid, cfg] of Object.entries(rt.ospf || {})) {
    out.push(`router ospf ${pid}`);
    if (cfg.routerId) out.push(` router-id ${cfg.routerId}`);
    for (const n of cfg.networks) out.push(` network ${n.network} ${n.wildcard} area ${n.area}`);
    for (const p of cfg.passive || []) out.push(` passive-interface ${p}`);
    out.push('!');
  }
  for (const [as, cfg] of Object.entries(rt.eigrp || {})) {
    out.push(`router eigrp ${as}`);
    for (const n of cfg.networks) out.push(` network ${n.network}${n.wildcard ? ` ${n.wildcard}` : ''}`);
    if (!cfg.autoSummary) out.push(' no auto-summary');
    for (const p of cfg.passive || []) out.push(` passive-interface ${p}`);
    out.push('!');
  }
  for (const [as, cfg] of Object.entries(rt.bgp || {})) {
    out.push(`router bgp ${as}`);
    if (cfg.routerId) out.push(` bgp router-id ${cfg.routerId}`);
    for (const [ip, n] of Object.entries(cfg.neighbors || {})) out.push(` neighbor ${ip} remote-as ${n.remoteAs}`);
    for (const n of cfg.networks) out.push(` network ${n.network} mask ${n.mask}`);
    out.push('!');
  }
  // ACL standar (before interface blocks dipakai access-group — tampil di atas).
  for (const num of Object.keys(d.acls || {}).map(Number).sort((a, b) => a - b)) {
    for (const e of d.acls[num]) {
      const src = e.src === 'any' ? 'any' : e.wildcard === '0.0.0.0' ? `host ${e.src}` : `${e.src} ${e.wildcard}`;
      out.push(`access-list ${num} ${e.action} ${src}`);
    }
    out.push('!');
  }
  for (const r of d.natRules || []) {
    out.push(`ip nat inside source list ${r.acl} interface ${r.outsideIf} overload`, '!');
  }
  if (d.dhcpPools?.length) {
    for (const e of d.dhcpExcluded || []) {
      out.push(e.end ? `ip dhcp excluded-address ${e.start} ${e.end}` : `ip dhcp excluded-address ${e.start}`);
    }
    out.push('!');
    for (const p of d.dhcpPools) {
      out.push(`ip dhcp pool ${p.name}`);
      if (p.network) out.push(` network ${p.network} ${p.mask}`);
      if (p.defaultRouter) out.push(` default-router ${p.defaultRouter}`);
      if (p.dnsServer) out.push(` dns-server ${p.dnsServer}`);
      out.push('!');
    }
  }
  if (d.isSwitch && Object.keys(d.vlanPriorities || {}).length) {
    for (const [vlan, prio] of Object.entries(d.vlanPriorities)) {
      out.push(vlan === '1' ? `spanning-tree priority ${prio}` : `spanning-tree vlan ${vlan} priority ${prio}`);
    }
    out.push('!');
  }
  if (d.isPc && d.gw) out.push(`ip default-gateway ${d.gw}`, '!');
  return out;
}

export function showRunningConfig(ctx) {
  return formatConfig(ctx.device);
}

export function showStartupConfig(ctx) {
  const d = ctx.device;
  if (!d.startupConfig) {
    return 'startup-config is not present';
  }
  return formatConfig(d.startupConfig);
}

function hardwareLabel(d, name) {
  if (d.isRouter) return 'CN Gigabit Ethernet';
  if (d.isSwitch) return 'FastEthernet';
  return 'PC Network Adapter';
}

export function showInterfaces(ctx) {
  const d = ctx.device;
  const wanted = ctx.args?.name ? d.normalizeInterfaceName(ctx.args.name) : null;
  if (ctx.args?.name && !wanted) {
    return `% Invalid interface '${ctx.args.name}' on ${d.hostname}.`;
  }
  const names = wanted ? [wanted] : Object.keys(d.interfaces).sort();
  const blocks = names.map((name) => {
    const ifc = d.interfaces[name];
    const up = ifc.operUp;
    const bw = { Serial: 1544, FastEthernet: 100000, GigabitEthernet: 1000000 }[ifc.portType] ?? 1000000;
    const media = ifc.portType === 'Serial' ? 'Serial (V.35)' : 'RJ45';
    return [
      `${name} is ${up ? 'up' : 'down'}, line protocol is ${protocolOf(ifc)} ${up ? '(connected)' : ''}`.trimEnd(),
      `  Hardware is ${hardwareLabel(d, name)}, address is ${ifc.mac} (bia ${ifc.mac})`,
      `  Port type: ${ifc.portType}${ifc.portType === 'Serial' && ifc.clockRate ? `, clock rate ${ifc.clockRate} (DCE)` : ''}`,
      ifc.description ? `  Description: ${ifc.description}` : null,
      ifc.ip ? `  Internet address is ${ifc.ip}/${maskToPrefix(ifc.mask)}` : null,
      `  MTU 1500 bytes, BW ${bw} Kbit/sec, DLY 10 usec,`,
      '     reliability 255/255, txload 1/255, rxload 1/255',
      `  ${up ? 'Full-duplex' : 'Auto-duplex'}, media type is ${media}`,
      '  input flow-control is off, output flow-control is off',
      '  5 minute input rate 0 bits/sec, 0 packets/sec',
      '  5 minute output rate 0 bits/sec, 0 packets/sec',
      `     ${up ? '1247' : '0'} packets input, ${up ? '183204' : '0'} bytes, 0 no buffer`,
      `     ${up ? '986' : '0'} packets output, ${up ? '147930' : '0'} bytes, 0 underruns`,
    ].filter(Boolean).join('\n');
  });
  return blocks.join('\n');
}

export function showVersion(ctx) {
  const d = ctx.device;
  const upMs = Date.now() - d.bootTime;
  const upMin = Math.floor(upMs / 60000);
  const uptime = upMin < 1 ? 'less than 1 minute' : `${upMin} minute${upMin === 1 ? '' : 's'}`;
  const ifCount = Object.keys(d.interfaces).length;
  const model = d.info.model || (d.isRouter ? 'CISCO2911/K9' : d.isSwitch ? 'WS-C2960-24TT' : 'Generic PC');
  const ios = d.info.ios || 'Simulated IOS';
  const lines = d.isPc
    ? [
        'NetQuest PC Console — simulated end device',
        `Model: ${model}`,
        `Hostname: ${d.hostname}`,
        `Uptime: ${uptime}`,
      ]
    : [
        `Cisco IOS Software, ${ios}, RELEASE SOFTWARE (fc1)`,
        'Technical Support: http://www.cisco.com/techsupport',
        'Copyright (c) 1986-2013 by Cisco Systems, Inc.',
        `Compiled Wed 06-Nov-13 21:32 by prod_rel_team`,
        '',
        `ROM: System Bootstrap, Version 15.1(4r)M4, RELEASE SOFTWARE (fc1)`,
        '',
        `${d.hostname} uptime is ${uptime}`,
        'System returned to ROM by power-on',
        'System image file is "flash:c2900-universalk9-mz.SPA.152-4.M3.bin"',
        '',
        `Cisco ${model} (revision 1.0) with 475136K/442368K bytes of memory.`,
        'Processor board ID FTX1524ABCD',
        '',
        `${ifCount} interface(s)`,
        'DRAM configuration is 64 bits wide with parity disabled.',
        '255K bytes of non-volatile configuration memory.',
        '250880K bytes of ATA System CompactFlash (Read/Write)',
      ];
  return lines.join('\n');
}

export function showArp(ctx) {
  const d = ctx.device;
  const lines = [
    `Protocol  Address          Age (min)  Hardware Addr   Type   Interface`,
  ];
  if (d.arpTable.length === 0) {
    lines.push('(ARP table kosong — lakukan ping terlebih dahulu)');
  }
  for (const e of d.arpTable) {
    lines.push(`Internet  ${pad(e.ip, 16)}  ${padLeft(String(e.age), 10)}  ${pad(e.mac, 15)}  ARPA   ${e.interface}`);
  }
  return lines.join('\n');
}

/* ---------------- SHOW routing dinamis ---------------- */

/** `show ip protocols` — parameter & sumber tiap protokol aktif. */
export function showIpProtocols(ctx) {
  const d = ctx.device;
  const protos = activeProtocols(d);
  if (protos.length === 0) {
    return [
      'Routing Information Sources:',
      '  Gateway         Distance      Last Update',
      'Distance: (default is 4294967295)',
    ].join('\n');
  }
  const adj = adjacencySets(ctx.world);
  const sourcesOf = (proto, procId) => {
    const seen = new Map();
    for (const a of adj.values()) {
      if (a.deviceId !== d.id || a.proto !== proto) continue;
      if (proto !== 'rip' && a.procId !== procId) continue;
      const key = proto === 'ospf' ? a.routerId : a.neighborIp;
      if (key) seen.set(key, a);
    }
    return [...seen.keys()].sort();
  };
  const blocks = [];
  for (const p of protos) {
    const cfg = p.config;
    const dist = p.proto === 'rip' ? 120 : p.proto === 'ospf' ? 110 : 90;
    if (p.proto === 'rip') {
      blocks.push([
        `Routing Protocol is "rip"`,
        `Sending updates every 30 seconds, next due in ${10 + (Math.abs(d.id.length * 7) % 15)} seconds`,
        `Invalid after 180 seconds, hold down 180, flushed after 240`,
        `Outgoing update filter list for all interfaces is not set`,
        `Incoming update filter list for all interfaces is not set`,
        `Redistributing: rip`,
        `Default version control: send version ${cfg.version ?? 1}, receive version ${cfg.version ?? 1}`,
        `  Interface        Send  Recv  Triggered RIP  Key-chain`,
        ...enabledIfaces(d, 'rip', null).map((n) => `  ${pad(n, 17)}${cfg.version ?? 1}     ${cfg.version ?? 1}`),
        `Automatic network summarization is ${cfg.autoSummary ? '' : 'not '}in effect`,
        `Maximum path: 4`,
        `Routing for Networks:`,
        ...cfg.networks.map((n) => `    ${n}`),
        ...(cfg.passive?.length ? ['Passive Interface(s):', ...cfg.passive.map((n) => `    ${n}`)] : []),
        `Routing Information Sources:`,
        `  Gateway         Distance      Last Update`,
        ...sourcesOf('rip', null).map((g) => `  ${pad(g, 16)}${pad(String(120), 9)}${uptimeStr(ctx.world)}`),
        `Distance: (default is 120)`,
      ].join('\n'));
    } else if (p.proto === 'ospf') {
      const areas = new Set(cfg.networks.map((n) => n.area));
      blocks.push([
        `Routing Protocol is "ospf ${p.procId}"`,
        `  Outgoing update filter list for all interfaces is not set`,
        `  Incoming update filter list for all interfaces is not set`,
        `  Router ID ${ospfRouterId(d, p.procId) ?? '0.0.0.0'}`,
        `  Number of areas in this router is ${areas.size}. ${areas.size} normal 0 stub 0 nssa`,
        `  Maximum path: 4`,
        `  Routing for Networks:`,
        ...cfg.networks.map((n) => `    ${n.network} ${n.wildcard} area ${n.area}`),
        ...(cfg.passive?.length ? ['  Passive Interface(s):', ...cfg.passive.map((n) => `    ${n}`)] : []),
        `  Routing Information Sources:`,
        `  Gateway         Distance      Last Update`,
        ...sourcesOf('ospf', p.procId).map((g) => `  ${pad(g, 16)}${pad(String(110), 9)}${uptimeStr(ctx.world)}`),
        `  Distance: (default is 110)`,
      ].join('\n'));
    } else if (p.proto === 'eigrp') {
      blocks.push([
        `Routing Protocol is "eigrp ${p.procId}"`,
        `  Outgoing update filter list for all interfaces is not set`,
        `  Incoming update filter list for all interfaces is not set`,
        `  Default networks flagged in outgoing updates`,
        `  Default networks accepted from incoming updates`,
        `  EIGRP metric weight K1=1, K2=0, K3=1, K4=0, K5=0`,
        `  EIGRP maximum hopcount 100`,
        `  EIGRP maximum metric variance 1`,
        `Redistributing: eigrp ${p.procId}`,
        `Automatic network summarization is ${cfg.autoSummary ? '' : 'not '}in effect`,
        `Maximum path: 4`,
        `  Routing for Networks:`,
        ...cfg.networks.map((n) => `    ${n.network}`),
        ...(cfg.passive?.length ? ['  Passive Interface(s):', ...cfg.passive.map((n) => `    ${n}`)] : []),
        `  Routing Information Sources:`,
        `  Gateway         Distance      Last Update`,
        ...sourcesOf('eigrp', p.procId).map((g) => `  ${pad(g, 16)}${pad(String(90), 9)}${uptimeStr(ctx.world)}`),
        `  Distance: internal 90 external 170`,
      ].join('\n'));
    } else if (p.proto === 'bgp') {
      blocks.push([
        `Routing Protocol is "bgp ${p.procId}"`,
        `  Outgoing update filter list for all interfaces is not set`,
        `  Incoming update filter list for all interfaces is not set`,
        `  BGP router identifier ${ospfRouterId(d, null) ?? '0.0.0.0'}, local AS number ${p.procId}`,
        `  BGP table version is 1, main routing table version 1`,
        `  IGP synchronization disabled`,
        `  Automatic route summarization is disabled`,
        `  Neighbor(s):`,
        ...Object.entries(p.config.neighbors || {}).map(([ip, n]) => `    ${pad(ip, 16)}AS ${n.remoteAs} (eBGP)`),
        `  Routing Information Sources:`,
        `  Gateway         Distance      Last Update`,
        ...sourcesOf('bgp', p.procId).map((g) => `  ${pad(g, 16)}${pad(String(20), 9)}${uptimeStr(ctx.world)}`),
        `  Distance: external 20 internal 200 local 200`,
      ].join('\n'));
    }
  }
  return blocks.join('\n\n');
}

/** Interface yang dicakup network statement (utk tabel Interface di show ip protocols). */
function enabledIfaces(d, proto, procId) {
  const out = [];
  for (const [name, ifc] of Object.entries(d.interfaces)) {
    if (!(ifc.ip && ifc.mask)) continue;
    if (protoMatchPublic(d, proto, procId, ifc)) out.push(name);
  }
  return out.sort();
}

/** Bungkus protoMatch agar bisa dipakai dari modul lain tanpa ekspos internal. */
function protoMatchPublic(device, proto, procId, ifc) {
  // Routing-protocols.protoMatch tidak diekspor; duplikasi ringan via wildcardMatch/classful.
  if (proto === 'rip') {
    const cf = classfulOf(ifc.ip);
    return device.routing?.rip?.networks?.includes(cf?.network);
  }
  if (proto === 'ospf') {
    const p = device.routing?.ospf?.[procId];
    return p?.networks?.some((n) => wildcardMatch(ifc.ip, n.network, n.wildcard));
  }
  if (proto === 'eigrp') {
    const p = device.routing?.eigrp?.[procId];
    return p?.networks?.some((n) =>
      n.wildcard ? wildcardMatch(ifc.ip, n.network, n.wildcard) : classfulOf(ifc.ip)?.network === n.network
    );
  }
  return false;
}

/** `show ip ospf` — ringkasan proses OSPF. */
export function showIpOspf(ctx) {
  const d = ctx.device;
  const procs = Object.entries(d.routing?.ospf || {});
  if (procs.length === 0) return '';
  const blocks = [];
  for (const [pid, cfg] of procs) {
    const areas = new Set(cfg.networks.map((n) => n.area));
    blocks.push([
      ` Routing Process "ospf ${pid}" with ID ${ospfRouterId(d, Number(pid)) ?? '0.0.0.0'} and Domain ID 0.0.0.1`,
      ` Supports only single TOS(TOS0) routes`,
      ` Supports opaque LSA`,
      ` Supports Link-local Signaling (LLS)`,
      ` Number of areas in this router is ${areas.size}. ${areas.size} normal 0 stub 0 nssa`,
      ` Reference bandwidth unit is 100 mbps`,
      ` Routing for Networks:`,
      ...cfg.networks.map((n) => `   ${n.network} ${n.wildcard} area ${n.area}`),
    ].join('\n'));
  }
  return blocks.join('\n\n');
}

/** `show ip ospf neighbor` — tabel tetangga OSPF. */
export function showIpOspfNeighbor(ctx) {
  const d = ctx.device;
  const rows = [];
  for (const a of adjacencySets(ctx.world).values()) {
    if (a.deviceId !== d.id || a.proto !== 'ospf') continue;
    const myId = ospfRouterId(d, a.procId);
    const nbrId = a.routerId ?? '0.0.0.0';
    // DR = router-id tertinggi di segmen (pemilihan sederhana 2-router).
    const state = myId && nbrId && ipToInt(nbrId) > ipToInt(myId) ? 'FULL/DR' : 'FULL/BDR';
    rows.push({ nbrId, state, address: a.neighborIp, interface: a.interface });
  }
  if (rows.length === 0) return '';
  rows.sort((a, b) => ipToInt(a.address) - ipToInt(b.address));
  const lines = [
    `${pad('Neighbor ID', 16)}${pad('Pri', 4)}${pad('State', 16)}${pad('Dead Time', 12)}${pad('Address', 16)}Interface`,
  ];
  for (const r of rows) {
    lines.push(
      `${pad(r.nbrId, 16)}${pad('1', 4)}${pad(r.state, 16)}${pad('00:00:33', 12)}${pad(r.address, 16)}${r.interface}`
    );
  }
  return lines.join('\n');
}

/** `show ip eigrp neighbors` — tabel tetangga EIGRP. */
export function showIpEigrpNeighbors(ctx) {
  const d = ctx.device;
  const asList = ctx.args?.as ? [Number(ctx.args.as)] : Object.keys(d.routing?.eigrp || {}).map(Number);
  const blocks = [];
  for (const as of asList) {
    if (!d.routing?.eigrp?.[as]) continue;
    const rows = [];
    for (const a of adjacencySets(ctx.world).values()) {
      if (a.deviceId !== d.id || a.proto !== 'eigrp' || a.procId !== as) continue;
      rows.push(a);
    }
    rows.sort((a, b) => ipToInt(a.neighborIp) - ipToInt(b.neighborIp));
    const lines = [`IP-EIGRP neighbors for process ${as}`];
    if (rows.length) {
      lines.push(
        `H   Address                 Interface       Hold Uptime   SRTT   RTO  Q  Seq`,
        `                                     (sec)         (ms)       Cnt Num`
      );
      rows.forEach((r, i) => {
        lines.push(
          `${pad(String(i), 4)}${pad(r.neighborIp, 24)}${pad(shortIf(r.interface), 16)}${pad('13', 5)}${pad(uptimeStr(ctx.world), 10)}${pad('1', 4)}${pad('100', 5)}${pad('0', 3)}${5 + i}`
        );
      });
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n');
}

/** `show ip eigrp topology` — successor, FD, RD. */
export function showIpEigrpTopology(ctx) {
  const d = ctx.device;
  const asList = ctx.args?.as ? [Number(ctx.args.as)] : Object.keys(d.routing?.eigrp || {}).map(Number);
  const blocks = [];
  for (const as of asList) {
    if (!d.routing?.eigrp?.[as]) continue;
    const lines = [
      `IP-EIGRP Topology Table for AS(${as})/ID(${ospfRouterId(d, null) ?? '0.0.0.0'})`,
      ``,
      `Codes: P - Passive, A - Active, U - Update, Q - Query, R - Reply,`,
      `       r - reply Status, s - sia Status`,
      ``,
    ];
    // Entry connected yang dicakup EIGRP.
    for (const [name, ifc] of Object.entries(d.interfaces)) {
      if (!(ifc.ip && ifc.mask && ifc.operUp)) continue;
      const subnet = networkOf(ifc.ip, ifc.mask);
      const matched = d.routing.eigrp[as].networks.some((n) =>
        n.wildcard ? wildcardMatch(ifc.ip, n.network, n.wildcard) : classfulOf(ifc.ip)?.network === n.network
      );
      if (!matched) continue;
      lines.push(`P ${subnet}/${maskToPrefix(ifc.mask)}, 1 successors, FD is ${eigrpMetric([name])}`);
      lines.push(`    via Connected, ${name}`);
    }
    // Entry hasil pembelajaran.
    for (const r of routingTable(ctx.world, d)) {
      if (r.type !== 'D' || r.procLabel !== `eigrp ${as}`) continue;
      lines.push(`P ${r.network}/${r.prefix}, 1 successors, FD is ${r.metric}`);
      lines.push(`    via ${r.via} (${r.metric}/${r.rd}), ${r.interface}`);
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

/** `show ip rip database` — entri RIP: connected + learned (+ auto-summary). */
export function showIpRipDatabase(ctx) {
  const d = ctx.device;
  const rip = d.routing?.rip;
  if (!rip) return '';
  const entries = [];
  for (const [name, ifc] of Object.entries(d.interfaces)) {
    if (!(ifc.ip && ifc.mask && ifc.operUp)) continue;
    if (!rip.networks.includes(classfulOf(ifc.ip)?.network)) continue;
    entries.push({ subnet: networkOf(ifc.ip, ifc.mask), prefix: maskToPrefix(ifc.mask), connected: true, ifName: name });
  }
  for (const r of routingTable(ctx.world, d)) {
    if (r.type !== 'R') continue;
    entries.push({ subnet: r.network, prefix: r.prefix, connected: false, via: r.via, hops: r.metric, ifName: r.interface });
  }
  entries.sort((a, b) => ipToInt(a.subnet) - ipToInt(b.subnet) || a.prefix - b.prefix);
  const lines = [];
  for (const e of entries) {
    if (e.connected) {
      lines.push(`    ${pad(`${e.subnet}/${e.prefix}`, 18)} directly connected, ${e.ifName}`);
    } else {
      lines.push(`    ${e.subnet}/${e.prefix}`);
      lines.push(`        [${e.hops}] via ${e.via}, ${uptimeStr(ctx.world)}, ${e.ifName}`);
    }
  }
  return lines.join('\n');
}

export function showVlanBrief(ctx) {
  const d = ctx.device;
  const lines = [
    `VLAN Name                             Status    Ports`,
    `---- -------------------------------- --------- -------------------------------`,
  ];
  const vlans = d.vlans.length ? [...d.vlans].sort((a, b) => a.id - b.id) : [{ id: 1, name: 'default' }];
  for (const v of vlans) {
    // Anggota: access port di VLAN ini + trunk yang mengizinkan (atau 'all').
    const members = Object.entries(d.interfaces)
      .filter(([name, ifc]) => {
        if (!ifc.adminUp) return false;
        const sw = switchportOf(d, name);
        if (!sw) return false;
        if (sw.mode === 'access') return sw.accessVlan === v.id;
        return sw.trunkAllowed === 'all' || sw.trunkAllowed.includes(v.id);
      })
      .map(([name]) => shortIf(name).toUpperCase().replace('GI', 'Gi').replace('FA', 'Fa'));
    lines.push(`${pad(v.id, 4)} ${pad(v.name, 33)} ${pad('active', 9)} ${members.join(', ')}`);
  }
  return lines.join('\n');
}

/** `show spanning-tree` — pemilihan root bridge per pulau L2. */
export function showSpanningTree(ctx) {
  const d = ctx.device;
  const stp = stpTopology(ctx.world);
  const info = stp.get(d.id) ?? { rootId: d.id, rootMac: d.interfaces[Object.keys(d.interfaces)[0]]?.mac, rootPriority: 32768, isRoot: true };
  const prio = d.vlanPriorities?.[1] ?? 32768;
  const lines = [
    'VLAN0001',
    '  Spanning tree enabled protocol ieee',
    `  Root ID    Priority    ${info.rootPriority}`,
    `             Address     ${info.rootMac}`,
    info.isRoot
      ? '             This bridge is the root'
      : `             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec`,
    '',
    `  Bridge ID  Priority    ${prio}  (priority ${prio} sys-id-ext 1)`,
    `             Address     ${d.interfaces[Object.keys(d.interfaces)[0]]?.mac}`,
    `             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec`,
    '             Aging Time  20',
    '',
    'Interface           Role Sts Cost      Prio.Nbr Type',
    '------------------- ---- --- --------- -------- --------------------------------',
  ];
  for (const [name, ifc] of Object.entries(d.interfaces)) {
    if (!ifc.adminUp) continue;
    lines.push(`${pad(shortIf(name), 19)} ${pad('Desg', 4)} ${pad('FWD', 4)} ${pad('19', 9)} ${pad('128.' + name.split('/').pop(), 8)} P2p`);
  }
  return lines.join('\n');
}

/** `show access-lists` — semua ACL dan aturannya. */
export function showAccessLists(ctx) {
  const d = ctx.device;
  const nums = Object.keys(d.acls || {}).map(Number).sort((a, b) => a - b);
  if (!nums.length) return '';
  const lines = [];
  for (const num of nums) {
    lines.push(`Standard IP access list ${num}`);
    for (const [i, e] of (d.acls[num] || []).entries()) {
      const src = e.src === 'any' ? 'any' : e.wildcard === '0.0.0.0' ? `host ${e.src}` : `${e.src} ${e.wildcard}`;
      lines.push(`    ${pad(String(10 * (i + 1)), 5)}${e.action} ${src}`);
    }
  }
  return lines.join('\n');
}

/** `show ip dhcp binding` — lease DHCP yang dikeluarkan router ini. */
export function showIpDhcpBinding(ctx) {
  const d = ctx.device;
  const b = d.dhcpBindings || [];
  const lines = [
    'IP address       Client-ID/              Lease expiration        Type',
    '                 Hardware address',
    '-------------------------------------------------------------------------------',
  ];
  for (const e of b) {
    lines.push(`${pad(e.ip, 17)}${pad(e.mac, 24)}--                      Automatic`);
  }
  return lines.join('\n');
}

/** `show ip nat translations` — tabel translasi NAT/PAT aktif. */
export function showIpNatTranslations(ctx) {
  const d = ctx.device;
  const t = d.natTranslations || [];
  if (!t.length) return '';
  const lines = [
    'Pro  Inside global      Inside local       Outside local      Outside global',
  ];
  for (const e of t) {
    lines.push(
      `icmp ${pad(e.insideGlobal + ':1', 19)}${pad(e.insideLocal + ':1', 19)}${pad(e.outsideLocal + ':1', 19)}${e.outsideLocal + ':1'}`
    );
  }
  return lines.join('\n');
}

/** `show ip bgp` — tabel BGP (Network / Next Hop / Metric / Path). */
export function showIpBgp(ctx) {
  const d = ctx.device;
  const asList = Object.keys(d.routing?.bgp || {}).map(Number);
  if (!asList.length) return '';
  const as = asList[0];
  const lines = [
    `BGP table version is ${(routingTable(ctx.world, d).filter((r) => r.type === 'B').length + 1) * 2}, local router ID is ${ospfRouterId(d, null) ?? '0.0.0.0'}`,
    'Status codes: s suppressed, d damped, h history, * valid, > best, i - internal,',
    '              r RIB-failure, S Stale, R Removed',
    'Origin codes: i - IGP, e - EGP, ? - incomplete',
    '',
    '   Network          Next Hop            Metric LocPrf Weight Path',
  ];
  // Jaringan sendiri (origin i, weight 32768) lalu yang dipelajari via eBGP.
  for (const n of d.routing.bgp[as].networks) {
    const connected = Object.values(d.interfaces).some(
      (ifc) => ifc.ip && ifc.mask && ifc.operUp && networkOf(ifc.ip, ifc.mask) === networkOf(n.network, n.mask)
    );
    if (!connected) continue;
    lines.push(`*> ${pad(`${n.network}/${maskToPrefix(n.mask)}`, 17)}${pad('0.0.0.0', 21)}${pad('0', 11)}${pad('', 8)}32768 ${as}i`);
  }
  for (const r of routingTable(ctx.world, d)) {
    if (r.type !== 'B') continue;
    lines.push(`*> ${pad(`${r.network}/${r.prefix}`, 17)}${pad(r.via, 21)}${pad('0', 11)}${pad('', 8)}${pad('0', 6)}${(r.asPath || []).join(' ')} i`);
  }
  return lines.join('\n');
}

/** `show ip bgp summary` — ringkasan peer BGP. */
export function showIpBgpSummary(ctx) {
  const d = ctx.device;
  const asList = Object.keys(d.routing?.bgp || {}).map(Number);
  if (!asList.length) return '';
  const as = asList[0];
  const cfg = d.routing.bgp[as];
  const adj = adjacencySets(ctx.world);
  const lines = [
    `BGP router identifier ${ospfRouterId(d, null) ?? '0.0.0.0'}, local AS number ${as}`,
    'BGP table version is 1, main routing table uses 1 entries',
    'Neighbor        V           AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd',
  ];
  const peers = Object.entries(cfg.neighbors || {}).sort(([a], [b]) => ipToInt(a) - ipToInt(b));
  for (const [ip, n] of peers) {
    const established = [...adj.values()].some(
      (a) => a.proto === 'bgp' && a.procId === as && a.deviceId === d.id && a.neighborIp === ip
    );
    const learned = routingTable(ctx.world, d).filter(
      (r) => r.type === 'B' && r.via === ip
    ).length;
    lines.push(
      `${pad(ip, 16)}${pad('4', 13)}${pad(String(n.remoteAs), 8)}${pad(String(3 + ip.length), 8)}${pad(String(3 + ip.length), 8)}${pad('1', 8)}${pad('0', 5)}${pad('0', 5)}${pad('00:00:12', 9)}${established ? learned : 'Idle'}`
    );
  }
  return lines.join('\n');
}

/** `show capture` — frame yang terekam di device (juga bisa diekspor .pcap). */
export function showCapture(ctx) {
  const d = ctx.device;
  const log = d.captureLog || [];
  if (!log.length) {
    return 'No frames captured yet. Jalankan ping/traceroute, lalu cek lagi. Ekspor: /api/pcap/' + d.id;
  }
  const lines = [
    `Captured frames on ${d.hostname} (ekspor Wireshark: GET /api/pcap/${d.id})`,
    '',
    `${pad('#', 4)}${pad('Time', 13)}${pad('Source', 17)}${pad('Destination', 17)}${pad('Proto', 7)}Summary`,
  ];
  log.slice(-25).forEach((e, i) => {
    const t = new Date(e.ts);
    const hh = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0') + ':' + String(t.getSeconds()).padStart(2, '0');
    lines.push(`${pad(String(i + 1), 4)}${pad(hh, 13)}${pad(e.srcIp, 17)}${pad(e.dstIp, 17)}${pad('ICMP', 7)}${e.summary}`);
  });
  return lines.join('\n');
}

export function showHistory(ctx) {
  const h = ctx.device.commandHistory || [];
  if (h.length === 0) return '';
  return h.map((cmd, i) => `${padLeft(String(i + 1), 4)}  ${cmd}`).join('\n');
}

export function showClock(ctx) {
  const now = new Date();
  const hari = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][now.getDay()];
  const bulan = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][now.getMonth()];
  const p2 = (n) => String(n).padStart(2, '0');
  return `*${hari} ${bulan} ${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3, '0')} UTC`;
}

/* ---------------- utility ---------------- */

/**
 * Ping ala IOS/PT. Menerima IP atau hostname (hostname ditranslate dulu;
 * bila tidak dikenal: "% Unrecognized host or address" seperti di PT).
 */
export function cmdPing(ctx) {
  const d = ctx.device;
  const target = ctx.args.ip;
  const resolv = resolveTarget(ctx.world, target);
  if (!resolv) {
    return color('% Unrecognized host or address, or protocol not running', ANSI.YELLOW);
  }
  const ip = resolv.ip;
  const res = pingFrom(ctx.world, d, ip);
  const header = [
    resolv.via ? `Translating "${resolv.via}"...domain server (255.255.255.255)` : '',
    'Type escape sequence to abort.',
    `Sending 5, 100-byte ICMP Echos to ${ip}, timeout is 2 seconds:`,
  ].filter((x) => x !== '');
  if (res.ok) {
    learnArp(ctx.world, d, res.srcIp, ip);
    // 5 ICMP echo sukses; RTT acak 1-10 ms (spesifikasi MVP).
    const rtts = Array.from({ length: 5 }, () => 1 + Math.floor(Math.random() * 10));
    const rtt = `round-trip min/avg/max = ${Math.min(...rtts)}/${(rtts.reduce((a, b) => a + b) / 5).toFixed(0)}/${Math.max(...rtts)} ms`;
    return [...header, color('!!!!!', ANSI.GREEN), `Success rate is 100 percent (5/5), ${rtt}`].join('\n');
  }
  const reasonMap = {
    'no-route': 'no route to destination',
    'unreachable': 'destination unreachable',
    'no-return-route': 'destination has no route back',
    'link-down': 'a link on the path is down',
    'dest-interface-down': 'destination interface is down',
    'no-source-address': 'no source IP on any up interface',
    'invalid-address': 'invalid IP address',
    'ttl-exceeded': 'TTL exceeded (routing loop?)',
  };
  const hint = reasonMap[res.reason] || res.reason;
  return [
    ...header,
    color('UUUUU', ANSI.RED),
    'Success rate is 0 percent (0/5)',
    color(`[diagnostik simulator: ${hint}]`, ANSI.YELLOW),
  ].join('\n');
}

/** Traceroute IOS (router/switch): hop-by-hop dengan 3x RTT per hop. */
export function cmdTraceroute(ctx) {
  const d = ctx.device;
  const resolv = resolveTarget(ctx.world, ctx.args.ip);
  if (!resolv) {
    return color('% Unrecognized host or address, or protocol not running', ANSI.YELLOW);
  }
  const ip = resolv.ip;
  const res = pingFrom(ctx.world, d, ip);
  if (res.ok) {
    const hops = res.hops.map((h, i) => {
      const rtt = (1 + Math.random() * 9).toFixed(0);
      return `  ${i + 1}  ${h.via} ${rtt} msec ${rtt} msec ${rtt} msec`;
    });
    if (hops.length === 0) hops.push(`  1  ${ip} 1 msec 1 msec 1 msec`);
    return ['Type escape sequence to abort.', `Tracing the route to ${ip}`, '', ...hops].join('\n');
  }
  const reasonMap = {
    'no-route': 'no route to destination',
    'unreachable': 'destination unreachable',
    'no-return-route': 'destination has no route back',
    'link-down': 'a link on the path is down',
    'dest-interface-down': 'destination interface is down',
    'no-source-address': 'no source IP on any up interface',
    'invalid-address': 'invalid IP address',
    'ttl-exceeded': 'TTL exceeded (routing loop?)',
  };
  const hint = reasonMap[res.reason] || res.reason;
  const hops = res.hops.map((h, i) => `  ${i + 1}  ${h.via} ${(1 + Math.random() * 9).toFixed(0)} msec`);
  return [
    'Type escape sequence to abort.',
    `Tracing the route to ${ip}`,
    '',
    ...hops,
    color('  * * *', ANSI.RED),
    color(`[diagnostik simulator: ${hint}]`, ANSI.YELLOW),
  ].join('\n');
}

/** `tracert` versi Windows di PC — format ala Packet Tracer. */
export function cmdTracert(ctx) {
  const d = ctx.device;
  const resolv = resolveTarget(ctx.world, ctx.args.ip);
  if (!resolv) {
    return `Unable to resolve target system name ${ctx.args.ip}.`;
  }
  const ip = resolv.ip;
  const res = pingFrom(ctx.world, d, ip);
  const lines = [`\nTracing route to ${ip} over a maximum of 30 hops:`];
  const rows = res.hops.map((h, i) => {
    const t = (1 + Math.random() * 9).toFixed(0);
    return `  ${padLeft(String(i + 1), 2)}   ${pad(t + ' ms', 10)}${pad(t + ' ms', 10)}${t} ms  ${h.via}`;
  });
  if (res.ok) {
    if (rows.length === 0) rows.push(`   1   1 ms      1 ms      1 ms  ${ip}`);
    lines.push(...rows, '\nTrace complete.');
  } else {
    lines.push(...rows, `  ${padLeft(String(res.hops.length + 1), 2)}   *         *         *      Request timed out.`, '\nTrace complete (tujuan tidak tercapai).');
  }
  return lines.join('\n');
}

/* ---------------- save / load konfigurasi ---------------- */

export function cmdCopyRunStart(ctx) {
  ctx.device.saveStartup();
  return [
    'Destination filename [startup-config]?',
    'Building configuration...',
    color('[OK]', ANSI.GREEN),
  ].join('\n');
}

export function cmdWriteMemory(ctx) {
  ctx.device.saveStartup();
  return ['Building configuration...', color('[OK]', ANSI.GREEN)].join('\n');
}

export function cmdCopyStartRun(ctx) {
  const d = ctx.device;
  if (!d.startupConfig) {
    return 'startup-config not present — nothing to copy';
  }
  d.restoreStartup();
  refreshOperStatus(ctx.world);
  return ['Building configuration...', 'Total: 0 error(s)'].join('\n');
}

export function cmdEraseStartup(ctx) {
  ctx.device.startupConfig = null;
  return ['Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]', '[OK]', 'Erase of nvram: complete'].join('\n');
}

export function cmdReload(ctx) {
  const d = ctx.device;
  if (d.startupConfig) {
    d.restoreStartup();
  } else {
    d.restoreFactory();
  }
  refreshOperStatus(ctx.world);
  return 'Proceed with reload? [confirm]';
}

/* ---------------- PC (Windows ala Packet Tracer) ---------------- */

export function cmdIpconfig(ctx) {
  const d = ctx.device;
  const ifc = Object.values(d.interfaces)[0];
  if (ctx.args?.opt === 'renew' || ctx.args?.opt === 'release') {
    if (ctx.args.opt === 'release') {
      d.gw = null;
      ifc.ip = null;
      ifc.mask = null;
      return 'Windows IP Configuration\n\nIP address released.';
    }
    // ipconfig /renew -> DHCP DORA (Discover/Offer/Request/ACK) ala PT.
    const res = dhcpDiscover(ctx.world, d);
    return ['Windows IP Configuration', '', ...res.lines].join('\n');
  }
  if (ctx.args?.opt === 'all') {
    const dnsServers = Object.values(ctx.world.meta?.dns || {});
    const macDashed = (ifc?.mac || '000d.bd00.0000').replace(/[.-]/g, '').replace(/(..)/g, '$1-').replace(/-$/, '');
    return [
      'Windows IP Configuration',
      '',
      'Host Name . . . . . . . . . . . . : ' + d.hostname,
      'Primary Dns Suffix  . . . . . . . :',
      'Node Type . . . . . . . . . . . . : Hybrid',
      'IP Routing Enabled. . . . . . . . : No',
      'WINS Proxy Enabled. . . . . . . . : No',
      '',
      'Ethernet adapter Local Area Connection:',
      '',
      '   Connection-specific DNS Suffix  . :',
      '   Description . . . . . . . . . . . : Realtek PCIe GBE Family Controller',
      '   Physical Address. . . . . . . . . : ' + macDashed,
      '   Dhcp Enabled. . . . . . . . . . : No',
      '   IPv4 Address. . . . . . . . . . : ' + (ifc?.ip ?? '0.0.0.0'),
      '   Subnet Mask . . . . . . . . . . : ' + (ifc?.mask ?? '0.0.0.0'),
      '   Default Gateway . . . . . . . . : ' + (d.gw ?? ''),
      '   DNS Servers . . . . . . . . . . : ' + (dnsServers[0] ?? ''),
    ].join('\n');
  }
  return [
    `IP Address......................: ${ifc?.ip ?? '0.0.0.0'}`,
    `Subnet Mask.....................: ${ifc?.mask ?? '0.0.0.0'}`,
    `Default Gateway.................: ${d.gw ?? '0.0.0.0'}`,
  ].join('\n');
}

/** `arp -a` Windows ala PT. */
export function cmdPcArp(ctx) {
  const d = ctx.device;
  const ifc = Object.values(d.interfaces)[0];
  const lines = [
    `Interface: ${ifc?.ip ?? '0.0.0.0'} --- 0x2`,
    '  Internet Address      Physical Address      Type',
  ];
  if (d.arpTable.length === 0) {
    lines.push('  (kosong — lakukan ping terlebih dahulu)');
  }
  for (const e of d.arpTable) {
    const mac = (e.mac || '').replace(/[.-]/g, '').replace(/(..)/g, '$1-').replace(/-$/, '');
    lines.push(`  ${pad(e.ip, 20)} ${pad(mac, 20)} dynamic`);
  }
  return lines.join('\n');
}

export function cmdHelpPc(ctx) {
  return groupHelp(ctx.commands.filter((c) => c.group === 'Utility'));
}

export function cmdContextHelp(ctx) {
  return groupHelp(ctx.commands);
}

/** Format daftar bantuan `?` ala IOS dari daftar perintah sah mode ini. */
function groupHelp(commands) {
  const groups = [];
  for (const c of commands) {
    if (!groups.includes(c.group)) groups.push(c.group);
  }
  const out = [];
  for (const g of groups) {
    out.push(`${g}:`);
    for (const c of commands.filter((x) => x.group === g)) {
      out.push(`  ${pad(c.usage || c.name, 38)}${c.help}`);
    }
    out.push('');
  }
  return out.join('\n').trimEnd();
}
