/**
 * CiscoDevice.js — "otak" state machine tiap perangkat jaringan.
 *
 * Satu instance per perangkat. Menyimpan SEMUA state konfigurasi
 * (interface, rute statis, vlan, arp) dan posisi mode CLI
 * (user / privileged / global-config / interface-config).
 * Output `show` TIDAK dihasilkan di sini — handler di src/parser/handlers.js
 * membaca state ini dan memformatnya secara dinamis.
 */

import { macFor } from './ip.js';

export const MODES = ['user', 'privileged', 'global-config', 'interface-config', 'line-config', 'router-config', 'vlan-config', 'dhcp-config'];

/** Sufiks prompt Cisco per mode. Prompt penuh = hostname + sufiks. */
export const MODE_PROMPT_SUFFIX = {
  'user': '>',
  'privileged': '#',
  'global-config': '(config)#',
  'interface-config': '(config-if)#',
  'line-config': '(config-line)#',
  'router-config': '(config-router)#',
  'vlan-config': '(config-vlan)#',
  'dhcp-config': '(config-dhcp)#',
};

/** Nama panjang mode, dipakai untuk banner/debug. */
export const MODE_NAMES = {
  'user': 'user EXEC',
  'privileged': 'privileged EXEC',
  'global-config': 'global configuration',
  'interface-config': 'interface configuration',
  'line-config': 'line configuration',
  'router-config': 'router configuration',
  'vlan-config': 'VLAN configuration',
  'dhcp-config': 'DHCP pool configuration',
};

/** Alias singkat -> nama interface kanonik, dipakai saat `interface g0/0`. */
const IF_PREFIX_ALIASES = {
  g: 'GigabitEthernet', gi: 'GigabitEthernet', gig: 'GigabitEthernet',
  fa: 'FastEthernet', f: 'FastEthernet',
  s: 'Serial', se: 'Serial',
  v: 'Vlan', vl: 'Vlan',
};

/**
 * Pola interface yang sah per tipe perangkat (port dalam rentang wajar).
 * Router: Gi0/0..3, Se0/0/0..3, Se0/1/0..1 — Switch: Fa0/1..24, Gi0/1..2, Vlan1 —
 * PC/Server: Fa0, Fa1, Gi0 (NIC tambahan utk variasi kabel), Se0/1/0 (WIC serial).
 */
const IF_PATTERNS = {
  router: [/^GigabitEthernet0\/([0-3])$/, /^Serial0\/0\/([0-3])$/, /^Serial0\/1\/([0-1])$/],
  switch: [/^FastEthernet0\/([1-9]|1\d|2[0-4])$/, /^GigabitEthernet0\/([12])$/, /^Vlan1$/],
  pc: [/^FastEthernet0$/, /^FastEthernet1$/, /^GigabitEthernet0$/, /^Serial0\/1\/0$/],
};

/** Tipe port fisik dari nama interface kanonik (utk jenis kabel & bandwidth). */
export function portTypeOf(ifName) {
  if (ifName.startsWith('Serial')) return 'Serial';
  if (ifName.startsWith('GigabitEthernet')) return 'GigabitEthernet';
  if (ifName.startsWith('FastEthernet')) return 'FastEthernet';
  return 'Vlan (SVI)';
}

/** Kecepatan Mbps per tipe port (utk info & OSPF cost). */
export const PORT_SPEED_MBPS = { Serial: 1.544, FastEthernet: 100, GigabitEthernet: 1000 };

export class CiscoDevice {
  constructor(data) {
    this.id = data.id;
    this.hostname = data.hostname;
    this.type = data.type; // 'router' | 'switch' | 'pc'
    // Role end-device: 'pc' bisa dikonversi jadi 'server' (perintah `role server`)
    // lalu menjalankan service DHCP/DNS/HTTP/TFTP/Syslog ala Packet Tracer.
    this.role = data.role || (data.type === 'pc' ? 'pc' : null);
    this.info = data.info || {}; // model, ios — untuk `show version`
    this.gw = data.gw || null; // hanya PC: default gateway

    // Deep clone agar state runtime tidak pernah menyentuh objek dari JSON mentah.
    this.interfaces = {};
    for (const [name, cfg] of Object.entries(data.interfaces || {})) {
      this.interfaces[name] = {
        ip: cfg.ip || null,
        mask: cfg.mask || null,
        adminUp: cfg.adminUp !== false,
        operUp: false, // dihitung ulang oleh network.refreshOperStatus()
        description: cfg.description || null,
        mac: cfg.mac || macFor(this.id, name),
        portType: cfg.portType || portTypeOf(name), // variasi port: Fa/Gi/Serial
        clockRate: cfg.clockRate ?? null,           // hanya Serial (sisi DCE)
        // Layanan edge ala NetSim (dinilai lazily, tersimpan di snapshot):
        sw: this.type === 'switch'
          ? (cfg.sw || { mode: 'access', accessVlan: 1, trunkNative: 1, trunkAllowed: 'all' })
          : null,
        aclIn: null, aclOut: null, // nomor ACL standar terpasang (router)
        nat: null,                 // 'inside' | 'outside' (router)
      };
    }

    this.routes = (data.routes || []).map((r) => ({ ...r })); // [{network, mask, nextHop}]
    this.vlans = (data.vlans || []).map((v) => ({ ...v }));   // [{id, name}] (switch)
    this.arpTable = [];                                       // diisi saat ping sukses

    // Konfigurasi routing dinamis (router rip / ospf <pid> / eigrp <as> / bgp <as>).
    // rip  : null | { version, networks[], autoSummary, passive[] }
    // ospf : { pid -> { networks[{network, wildcard, area}], routerId, passive[] } }
    // eigrp: { as  -> { networks[{network, wildcard?}], autoSummary, passive[] } }
    // bgp  : { as  -> { routerId, neighbors{ip -> remoteAs}, networks[{network, mask}] } }
    this.routing = { rip: null, ospf: {}, eigrp: {}, bgp: {} };
    this.routerContext = null; // {proto:'rip'} | {proto:'ospf',pid} | {proto:'eigrp',as} | {proto:'bgp',as} di mode router-config

    // Layanan & keamanan tambahan (paritas NetSim):
    this.acls = {};          // nomor ACL -> [{action:'permit'|'deny', src, wildcard}]
    this.natRules = [];      // [{acl, outsideIf}]  (ip nat inside source list N interface X overload)
    this.natTranslations = []; // runtime: [{insideLocal, insideGlobal, outsideLocal, since}]
    this.dhcpPools = [];     // [{name, network, mask, defaultRouter, dnsServer}]
    this.dhcpExcluded = [];  // [{start, end?}]
    this.dhcpBindings = [];  // runtime: [{ip, mac, device, since}]
    this.vlanPriorities = {}; // (switch) vlanId -> STP priority
    this.vlanContext = null; // id VLAN saat mode vlan-config
    this.dhcpContext = null; // nama pool saat mode dhcp-config
    this.captureLog = [];    // runtime: frame log utk `show capture` & export .pcap

    // Role server (PC -> server): service ala Packet Tracer. Aktif via
    // `service <nama> on|off`; hanya sah saat role === 'server'.
    this.services = {
      dhcp:   { on: false, start: null, end: null, gateway: null, dns: null },
      dns:    { on: false, records: [] },           // [{name, ip}]
      http:   { on: false, pages: { 'index.html': '<h2>Selamat datang di NetQuest</h2><p>HTTP server simulasi.</p>' } },
      tftp:   { on: false, files: {} },             // { 'r1-confg': 'config text' }
      ftp:    { on: false, files: { 'readme.txt': 'NetQuest FTP server siap digunakan.\nGunakan ls untuk melihat file dan get <file> untuk mengambilnya.', 'firmware-v2.bin': '[binary 4.2 MB]' } },
      syslog: { on: false, log: [] },               // [{since, host, text}]
      ntp:    { on: false },                        // stratum 1 master
    };
    // Router/switch: kirim syslog ke server ini (perintah `logging <ip>`).
    this.loggingHost = null;
    this.loggingBuffer = []; // runtime: [{since, text}] salinan lokal (`show logging`)

    // SSH server (router/switch): `ip domain name` + `crypto key generate rsa`.
    this.ssh = { domain: null, keyModulus: null };
    // NTP client (router/switch): server sumber waktu (perintah `ntp server <ip>`).
    this.ntpServer = null;

    // Keamanan & banner (global config) — persis seperti IOS.
    this.enableSecret = null;      // { secret, kind: 'secret'|'password', level }
    this.bannerMotd = null;        // teks banner motd
    this.currentLine = null;       // 'console 0' / 'vty 0 4' saat di line-config
    this.lineConfig = {};          // { 'console 0': {password, login}, 'vty 0 4': {...} }
    this.commandHistory = [];      // riwayat perintah (show history)

    // Mode CLI adalah bagian dari state perangkat (sesuai spesifikasi).
    // Dengan satu pemain MVP, ini aman; attach ulang selalu reset ke "user".
    this.currentMode = 'user';
    this.currentInterface = null; // nama interface saat berada di interface-config
    this.bootTime = Date.now();

    // Snapshot kondisi pabrik (dipakai `reload` tanpa startup-config).
    this.factoryConfig = null; // diisi setelah konstruktor selesai (lihat bawah)
  }

  /** Selesaikan inisialisasi: simpan snapshot pabrik. Dipanggil buildWorld. */
  captureFactoryState() {
    this.factoryConfig = this.snapshotConfig();
  }

  get isRouter() { return this.type === 'router'; }
  get isSwitch() { return this.type === 'switch'; }
  get isPc() { return this.type === 'pc'; }

  /** Prompt penuh gaya Cisco, mis. "R1(config-if)# ". */
  get prompt() {
    const suffix = MODE_PROMPT_SUFFIX[this.currentMode] ?? '>';
    return `${this.hostname}${suffix} `;
  }

  setMode(mode, extra = null) {
    if (!MODES.includes(mode)) throw new Error(`Mode tidak dikenal: ${mode}`);
    this.currentMode = mode;
    this.currentInterface = mode === 'interface-config' ? (extra ?? this.currentInterface) : null;
    this.currentLine = mode === 'line-config' ? (extra ?? this.currentLine) : null;
    this.routerContext = mode === 'router-config' ? (extra ?? this.routerContext) : null;
    this.vlanContext = mode === 'vlan-config' ? (extra ?? this.vlanContext) : null;
    this.dhcpContext = mode === 'dhcp-config' ? (extra ?? this.dhcpContext) : null;
  }

  /** Konfigurasi protokol routing utk konteks mode router-config saat ini. */
  get currentRouterCfg() {
    if (this.currentMode !== 'router-config' || !this.routerContext) return null;
    const { proto } = this.routerContext;
    if (proto === 'rip') {
      if (!this.routing.rip) this.routing.rip = { version: null, networks: [], autoSummary: true, passive: [] };
      return this.routing.rip;
    }
    if (proto === 'ospf') {
      const pid = this.routerContext.pid;
      if (!this.routing.ospf[pid]) this.routing.ospf[pid] = { networks: [], routerId: null, passive: [] };
      return this.routing.ospf[pid];
    }
    if (proto === 'eigrp') {
      const as = this.routerContext.as;
      if (!this.routing.eigrp[as]) this.routing.eigrp[as] = { networks: [], autoSummary: true, passive: [] };
      return this.routing.eigrp[as];
    }
    if (proto === 'bgp') {
      const as = this.routerContext.as;
      if (!this.routing.bgp[as]) this.routing.bgp[as] = { routerId: null, neighbors: {}, networks: [] };
      return this.routing.bgp[as];
    }
    return null;
  }

  /** Config VLAN saat berada di mode vlan-config (dibuat bila belum ada). */
  get currentVlanCfg() {
    if (this.currentMode !== 'vlan-config' || this.vlanContext === null) return null;
    let v = this.vlans.find((x) => x.id === this.vlanContext);
    if (!v) {
      v = { id: this.vlanContext, name: `VLAN${String(this.vlanContext).padStart(4, '0')}` };
      this.vlans.push(v);
    }
    return v;
  }

  /** Pool DHCP saat berada di mode dhcp-config (dibuat bila belum ada). */
  get currentDhcpPool() {
    if (this.currentMode !== 'dhcp-config' || !this.dhcpContext) return null;
    let p = this.dhcpPools.find((x) => x.name === this.dhcpContext);
    if (!p) {
      p = { name: this.dhcpContext, network: null, mask: null, defaultRouter: null, dnsServer: null };
      this.dhcpPools.push(p);
    }
    return p;
  }

  /** Definisi interface saat ini (null jika tidak sedang di interface-config). */
  get currentIf() {
    if (this.currentMode !== 'interface-config' || !this.currentInterface) return null;
    return this.interfaces[this.currentInterface] || null;
  }

  /** Konfigurasi line saat ini (dibuat bila belum ada). */
  get currentLineCfg() {
    if (this.currentMode !== 'line-config' || !this.currentLine) return null;
    if (!this.lineConfig[this.currentLine]) {
      this.lineConfig[this.currentLine] = { password: null, login: false };
    }
    return this.lineConfig[this.currentLine];
  }

  /**
   * Normalisasi input interface ke nama kanonik.
   * "g0/0" -> "GigabitEthernet0/0", "fa0/1" -> "FastEthernet0/1", "vlan1" -> "Vlan1".
   * Mengembalikan null bila format/rentang tidak sah untuk tipe perangkat ini.
   */
  normalizeInterfaceName(raw) {
    if (typeof raw !== 'string') return null;
    const s = raw.trim().replace(/\s+/g, '');
    const m = s.match(/^([A-Za-z]+)(\d+(?:\/\d+)*)$/);
    if (!m) return null;

    // Aliasmaya dipecah: huruf depan -> nama kanonik, sisanya tetap dipertahankan.
    // "gig0/0": prefix alias terpanjang yang cocok menang ("gig" bukan "g").
    const letters = m[1].toLowerCase();
    let prefix = null;
    for (const key of Object.keys(IF_PREFIX_ALIASES)) {
      if (letters.startsWith(key) && (!prefix || key.length > prefix.length)) prefix = key;
    }
    if (!prefix) return null;
    const candidate = IF_PREFIX_ALIASES[prefix] + m[2];
    return (IF_PATTERNS[this.type] || []).some((re) => re.test(candidate)) ? candidate : null;
  }

  /**
   * Ambil (atau buat, bila format sah) objek interface.
   * Interface baru dibuat dengan default Cisco: no ip, administratively up.
   */
  ensureInterface(canonicalName) {
    if (!this.interfaces[canonicalName]) {
      this.interfaces[canonicalName] = {
        ip: null, mask: null, adminUp: true, operUp: false,
        description: null, mac: macFor(this.id, canonicalName),
        portType: portTypeOf(canonicalName), clockRate: null,
      };
    }
    return this.interfaces[canonicalName];
  }

  /** Tambah rute statis (tanpa duplikat). */
  addStaticRoute(network, mask, nextHop) {
    const exists = this.routes.some(
      (r) => r.network === network && r.mask === mask && r.nextHop === nextHop
    );
    if (!exists) this.routes.push({ network, mask, nextHop });
    return !exists;
  }
  /** Hapus rute statis yang cocok persis. Return jumlah yang terhapus. */
  removeStaticRoute(network, mask, nextHop) {
    const before = this.routes.length;
    this.routes = this.routes.filter(
      (r) => !(r.network === network && r.mask === mask && r.nextHop === nextHop)
    );
    return before - this.routes.length;
  }

  /** `no router rip|ospf <pid>|eigrp <as>|bgp <as>` — hapus konfigurasi protokol. */
  removeRoutingProto(proto, id = null) {
    if (proto === 'rip') this.routing.rip = null;
    else if (proto === 'ospf') delete this.routing.ospf[id];
    else if (proto === 'eigrp') delete this.routing.eigrp[id];
    else if (proto === 'bgp') delete this.routing.bgp[id];
    // Bila sedang berada di konteks yang dihapus, keluar ke global-config.
    const c = this.routerContext;
    if (
      this.currentMode === 'router-config' && c &&
      (c.proto === proto) &&
      ((proto === 'ospf' && c.pid === id) ||
       ((proto === 'eigrp' || proto === 'bgp') && c.as === id))
    ) this.setMode('global-config');
  }

  /** Pencarian rute statis terpanjang (longest prefix match) terhadap sebuah IP tujuan. */
  bestStaticRoute(ip, helpers) {
    let best = null;
    for (const r of this.routes) {
      if (!helpers.inSubnet(ip, r.network, r.mask)) continue;
      const prefix = helpers.maskToPrefix(r.mask);
      if (!best || prefix > helpers.maskToPrefix(best.mask)) best = r;
    }
    return best;
  }

  /** Ringkasan JSON untuk endpoint /api/devices. */
  toSummary() {
    return {
      id: this.id,
      hostname: this.hostname,
      type: this.type,
      role: this.role,
      mode: this.currentMode,
      interfaces: Object.fromEntries(
        Object.entries(this.interfaces).map(([n, i]) => [n, { ip: i.ip, mask: i.mask, adminUp: i.adminUp, operUp: i.operUp, portType: i.portType, clockRate: i.clockRate }])
      ),
      services: this.type === 'pc'
        ? Object.fromEntries(Object.entries(this.services).map(([k, v]) => [k, v.on]))
        : null,
      routeCount: this.routes.length,
    };
  }

  /* ---------------- startup-config (NVRAM) ---------------- */

  /** Simpan snapshot konfigurasi berjalan ke "NVRAM" (copy run start / wr). */
  saveStartup() {
    this.startupConfig = this.snapshotConfig();
    return this.startupConfig;
  }

  /** Snapshot seluruh state konfigurasi (bukan mode CLI / runtime). */
  snapshotConfig() {
    return {
      hostname: this.hostname,
      interfaces: Object.fromEntries(
        Object.entries(this.interfaces).map(([n, i]) => [n, { ...i }])
      ),
      routes: this.routes.map((r) => ({ ...r })),
      vlans: this.vlans.map((v) => ({ ...v })),
      gw: this.gw,
      enableSecret: this.enableSecret ? { ...this.enableSecret } : null,
      bannerMotd: this.bannerMotd,
      lineConfig: JSON.parse(JSON.stringify(this.lineConfig || {})),
      routing: JSON.parse(JSON.stringify(this.routing || { rip: null, ospf: {}, eigrp: {}, bgp: {} })),
      role: this.role,
      services: JSON.parse(JSON.stringify(this.services || {})),
      loggingHost: this.loggingHost ?? null,
      ssh: { domain: this.ssh?.domain ?? null, keyModulus: this.ssh?.keyModulus ?? null },
      ntpServer: this.ntpServer ?? null,
      acls: JSON.parse(JSON.stringify(this.acls || {})),
      natRules: JSON.parse(JSON.stringify(this.natRules || [])),
      dhcpPools: JSON.parse(JSON.stringify(this.dhcpPools || [])),
      dhcpExcluded: JSON.parse(JSON.stringify(this.dhcpExcluded || [])),
      vlanPriorities: { ...(this.vlanPriorities || {}) },
    };
  }

  /** Terapkan sebuah snapshot konfigurasi ke device ini (copy start run). */
  applyConfig(snap) {
    if (!snap) return;
    this.hostname = snap.hostname;
    this.interfaces = Object.fromEntries(
      Object.entries(snap.interfaces || {}).map(([n, i]) => [n, { ...i }])
    );
    this.routes = (snap.routes || []).map((r) => ({ ...r }));
    this.vlans = (snap.vlans || []).map((v) => ({ ...v }));
    this.gw = snap.gw ?? null;
    this.enableSecret = snap.enableSecret ? { ...snap.enableSecret } : null;
    this.bannerMotd = snap.bannerMotd ?? null;
    this.lineConfig = JSON.parse(JSON.stringify(snap.lineConfig || {}));
    this.routing = JSON.parse(JSON.stringify(snap.routing || { rip: null, ospf: {}, eigrp: {}, bgp: {} }));
    this.role = snap.role ?? this.role;
    this.services = JSON.parse(JSON.stringify(snap.services || this.services));
    this.loggingHost = snap.loggingHost ?? null;
    this.loggingBuffer = [];
    this.ssh = { domain: snap.ssh?.domain ?? null, keyModulus: snap.ssh?.keyModulus ?? null };
    this.ntpServer = snap.ntpServer ?? null;
    this.acls = JSON.parse(JSON.stringify(snap.acls || {}));
    this.natRules = JSON.parse(JSON.stringify(snap.natRules || []));
    this.dhcpPools = JSON.parse(JSON.stringify(snap.dhcpPools || []));
    this.dhcpExcluded = JSON.parse(JSON.stringify(snap.dhcpExcluded || []));
    this.vlanPriorities = { ...(snap.vlanPriorities || {}) };
    this.natTranslations = [];
    this.dhcpBindings = [];
    this.captureLog = [];
  }

  /** copy startup-config running-config: timpa running dengan NVRAM. */
  restoreStartup() {
    if (!this.startupConfig) return false;
    this.applyConfig(this.startupConfig);
    return true;
  }

  /** reload tanpa startup-config: kembali ke pabrik + kondisi data awal. */
  restoreFactory() {
    this.applyConfig(this.factoryConfig || this.snapshotConfig());
    return true;
  }
}
