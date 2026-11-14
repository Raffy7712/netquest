/**
 * quests.js — state quest + health check otomatis.
 *
 * Setiap kali pemain mengeksekusi perintah, verifyAll() menjalankan
 * "health check" terhadap SEMUA quest aktif terhadap state jaringan terkini.
 * Quest selesai -> XP ditambahkan + notifikasi dikirim ke seluruh klien.
 */

import { pingFrom, resolveHostname, findDeviceByIp } from '../simulator/network.js';
import { switchportOf } from '../simulator/l2-services.js';
import { isValidIp } from '../simulator/ip.js';

export class QuestManager {
  constructor(definitions, world) {
    this.definitions = definitions;
    this.world = world; // dipakai snapshot() untuk cek objektif real-time
    this.progress = {
      xp: 0,
      completed: [], // id quest yang selesai
    };
  }

  /** Status terkini tiap quest utk dikirim ke frontend. */
  snapshot() {
    return {
      xp: this.progress.xp,
      quests: this.definitions.map((q) => ({
        id: q.id,
        title: q.title,
        xp: q.xp,
        npc: q.npc,
        dialog: q.dialog,
        completed: this.progress.completed.includes(q.id),
        objectives: q.objectives.map((o) => ({
          id: o.id,
          text: o.text,
          done: this.progress.completed.includes(q.id) || this.checkObjective(q, o),
        })),
      })),
    };
  }

  /**
   * Jalankan health check semua quest aktif.
   * Return daftar quest yang BARU selesai pada panggilan ini (untuk notifikasi).
   */
  verifyAll(world) {
    this.world = world;
    const justCompleted = [];
    for (const q of this.definitions) {
      if (this.progress.completed.includes(q.id)) continue;
      const allDone = q.objectives.every((o) => this.checkObjective(q, o, world));
      if (allDone) {
        this.progress.completed.push(q.id);
        this.progress.xp += q.xp;
        justCompleted.push(q);
      }
    }
    return justCompleted;
  }

  checkObjective(_quest, objective) {
    const world = this.world;
    if (!world) return false;
    const { devices } = world;
    switch (objective.type) {
      case 'interface': {
        const dev = devices.get(objective.device);
        const ifc = dev?.interfaces[objective.interface];
        if (!ifc) return false;
        const e = objective.expect;
        return (
          (e.adminUp === undefined || ifc.adminUp === e.adminUp) &&
          (e.operUp === undefined || ifc.operUp === e.operUp) &&
          (e.ip === undefined || ifc.ip === e.ip) &&
          (e.mask === undefined || ifc.mask === e.mask) &&
          (e.description === undefined || (ifc.description || null) === e.description) &&
          (e.aclIn === undefined || (ifc.aclIn ?? null) === e.aclIn) &&
          (e.aclOut === undefined || (ifc.aclOut ?? null) === e.aclOut) &&
          (e.clockRate === undefined || (ifc.clockRate ?? null) === e.clockRate)
        );
      }
      case 'route': {
        const dev = devices.get(objective.device);
        if (!dev) return false;
        const e = objective.expect;
        if (e.absent) {
          // rute SALAH harus sudah tidak ada (troubleshooting)
          return !dev.routes.some((r) => r.network === e.network && r.mask === e.mask && r.nextHop === e.nextHop);
        }
        return dev.routes.some(
          (r) => r.network === e.network && r.mask === e.mask && r.nextHop === e.nextHop
        );
      }
      case 'ping': {
        const from = devices.get(objective.from);
        if (!from) return false;
        const ip = isValidIp(objective.to) ? objective.to : resolveHostname(world, objective.to);
        if (!ip) return false;
        return pingFrom(world, from, ip).ok;
      }
      case 'switchport': {
        const dev = devices.get(objective.device);
        const ifc = dev?.interfaces[objective.interface];
        if (!ifc?.sw) return false;
        const e = objective.expect;
        const sw = switchportOf(dev, objective.interface);
        return (
          (e.mode === undefined || sw.mode === e.mode) &&
          (e.accessVlan === undefined || sw.accessVlan === e.accessVlan) &&
          (e.trunkNative === undefined || sw.trunkNative === e.trunkNative)
        );
      }
      case 'vlan': {
        const dev = devices.get(objective.device);
        if (!dev) return false;
        const vlan = dev.vlans?.find((v) => v.id === objective.vlan);
        if (!vlan) return false;
        return objective.name === undefined || vlan.name === objective.name;
      }
      case 'protocol': {
        const dev = devices.get(objective.device);
        if (!dev?.routing) return false;
        const p = objective.proto;
        const r = dev.routing[p];
        if (p === 'rip') return !!r && r.networks?.some((n) => (typeof n === 'string' ? n : n.network) === objective.network);
        if (p === 'ospf') {
          const inst = r?.[objective.pid];
          return !!inst && inst.networks?.some(
            (n) => n.network === objective.network && n.area === objective.area
          );
        }
        if (p === 'eigrp') {
          const inst = r?.[objective.as];
          return !!inst && inst.networks?.some((n) => n.network === objective.network);
        }
        if (p === 'bgp') {
          const inst = r?.[objective.as];
          if (!inst) return false;
          const hasNet = inst.networks?.some((n) => n.network === objective.network);
          const hasNeighbor = objective.neighbor
            ? Object.values(inst.neighbors || {}).some((n) => n.remoteAs === objective.neighbor.remoteAs)
            : true;
          return hasNet && hasNeighbor;
        }
        return false;
      }
      case 'dhcp-lease': {
        const dev = devices.get(objective.device);
        if (!dev) return false;
        const ifc = dev.interfaces[objective.interface || Object.keys(dev.interfaces)[0]];
        if (!ifc?.ip) return false;
        const e = objective.expect || {};
        // IP harus berasal dari binding DHCP di salah satu server (bukan statis)
        const leased = [...world.devices.values()].some(
          (d) => (d.dhcpBindings || []).some((b) => b.ip === ifc.ip && b.device === dev.id)
        );
        if (!leased) return false;
        return (e.gateway === undefined || dev.gw === e.gateway);
      }
      case 'service': {
        const dev = devices.get(objective.device);
        const svc = dev?.services?.[objective.service];
        if (!svc) return false;
        const e = objective.expect || {};
        if (e.on !== undefined && svc.on !== e.on) return false;
        if (e.hasRecord) {
          if (!svc.records?.some((r) => r.name === e.hasRecord.name && r.ip === e.hasRecord.ip)) return false;
        }
        if (e.hasRange) {
          if (!(svc.start && svc.end)) return false;
        }
        if (e.hasFile && !svc.files?.[e.hasFile]) return false;
        if (e.minMessages) {
          const count = (svc.log || []).filter(
            (m) => objective.fromHost === undefined || m.host?.toLowerCase() === objective.fromHost.toLowerCase()
          ).length;
          if (count < e.minMessages) return false;
        }
        return true;
      }
      case 'role': {
        const dev = devices.get(objective.device);
        return dev?.role === objective.expect;
      }
      case 'gateway': {
        const dev = devices.get(objective.device);
        return dev?.gw === objective.expect;
      }
      case 'hostname': {
        const dev = devices.get(objective.device);
        return dev?.hostname === objective.expect;
      }
      case 'ssh': {
        const dev = devices.get(objective.device);
        if (!dev?.ssh) return false;
        const e = objective.expect || {};
        return (
          (e.domain === undefined || dev.ssh.domain === e.domain) &&
          (e.keyModulus === undefined || (dev.ssh.keyModulus || 0) >= e.keyModulus)
        );
      }
      case 'ntp': {
        const dev = devices.get(objective.device);
        if (!dev?.ntpServer) return false;
        const e = objective.expect || {};
        if (e.server !== undefined && dev.ntpServer !== e.server) return false;
        const server = findDeviceByIp(world, dev.ntpServer)?.device;
        const svcOn = server && (server.services?.ntp?.on || server.type === 'router' || server.type === 'switch');
        if (!svcOn) return false;
        return pingFrom(world, dev, dev.ntpServer).ok;
      }
      default:
        return false;
    }
  }
}
