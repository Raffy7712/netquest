# NetQuest 🎮🌐 — Game Edukasi Konfigurasi Cisco IOS via CLI

NetQuest adalah game web edukasi untuk belajar perintah **Cisco IOS level CCNA**.
Pemain melihat **topologi jaringan visual**, mengklik perangkat (Router / Switch / PC)
untuk membuka **terminal CLI interaktif**, lalu menyelesaikan **quest dari NPC**
yang mengalami masalah jaringan. Sistem memverifikasi kebenaran konfigurasi
**secara otomatis berdasarkan state jaringan** — bukan berdasarkan tebakan teks.

Simulator ini mensimulasikan perangkat secara nyata: `show` dibentuk **dinamis
dari state**, `ping` mengikuti **routing table + rute balik**, dan kesalahan
ketik ditandai dengan caret `^` **persis seperti IOS**.

---

## ✨ Fitur

- **Mobile responsive** — di layar ≤ 900px UI berubah menjadi 3 tab bawah
  (Topologi / Konsol / Quest) ala aplikasi native, dengan *quick keys*
  horizontal scroll (`?`, `en`, `conf t`, `sh ip int br`, `^Z`, `^C`, ...) untuk
  mengetik cepat tanpa keyboard penuh. Klik perangkat di topologi otomatis
  membawa Anda ke tab konsol — persis seperti membuka CLI di Packet Tracer.
- **Ikon perangkat ala Packet Tracer** — router (puck abu-abu 4 panah biru),
  switch (kotak 4 panah), dan PC (monitor + tower) digambar sebagai SVG inline
  tanpa aset eksternal; dipakai di node topologi, legend, dan header konsol.
  Perangkat yang sedang dibuka ditandai bingkai hijau neon.
- **Topologi visual (vis-network)** — 2 Router + 2 Switch + 2 PC saling terhubung,
  warna link berubah real-time (hijau = up, merah putus-putus = down) setiap kali
  Anda mengetik perintah. Pinch-zoom & pan dukung sentuhan.
- **Terminal interaktif (xterm.js + WebSocket)** — klik perangkat = "SSH" ke
  perangkat tersebut; prompt berubah mengikuti hostname & mode.
- **Parser CLI context-aware** — regex ketat per perintah + state machine mode
  (`user > privileged > global-config > interface-config > line-config`),
  mendukung singkatan IOS (`en`, `conf t`, `sh ip int br`, `copy run start`,
  `wr`, `tracer`, `ex`), riwayat `↑/↓`, `?` kontekstual, dan
  `% Invalid input detected at '^' marker.` dengan posisi caret yang akurat
  (termasuk caret menunjuk argumen yang salah, mis. octet `999`).
- **Paritas perintah Packet Tracer** — termasuk `do <exec>` dari mode config,
  `enable secret/password`, `line console 0` + `password` + `login`,
  `banner motd #teks#`, `copy running-config startup-config` / `wr` /
  `copy start run` / `erase startup-config` / `reload` (startup-config
  benar-benar disimpan/dipulihkan), `show history`, `show clock`,
  `show startup-config`, `interface range`, `traceroute` IOS, dan
  `% Unrecognized host or address` untuk hostname tak dikenal.
- **PC ala Windows (seperti Packet Tracer)** — `ipconfig /all` lengkap dengan
  Physical Address & DNS, `arp -a` dengan format tabel Windows, dan
  `tracert` (bukan `traceroute`) di PC.
- **Output `show` dinamis** — `show ip interface brief`, `show ip route`,
  `show running-config`, `show interfaces`, `show version`, `show arp`,
  `show vlan brief` semuanya dibentuk dari state perangkat saat itu.
- **Ping end-to-end yang jujur** — mengecek connected route, static route
  (longest prefix match), default gateway PC, **dan rute balik** dari tujuan;
  `!!!!!` hijau saat sukses, `UUUUU` merah + diagnostik saat gagal.
- **Tombol Reset** — mengembalikan seluruh lab + progress quest ke kondisi
  awal dalam satu klik (berguna mengulang permainan dari awal).
- **Quest system otomatis** — setiap perintah memicu *health check* semua quest
  aktif; quest selesai → objektif tercentang, XP naik, toast muncul, dan topologi
  ikut berubah warna.

## 🚀 Cara Menjalankan

Prasyarat: **Node.js v20+** (dikembangkan dengan Node 24).

```bash
npm install
npm run dev        # mode watch; atau: npm start
```

Lalu buka **http://localhost:3000** — game langsung bisa dimainkan.
Ganti port dengan `PORT=8080 npm run dev` bila port 3000 terpakai.

Endpoint penting:

| Endpoint | Fungsi |
| --- | --- |
| `GET /health` | status server (JSON) |
| `GET /api/topology` | node + link + ringkasan device |
| `GET /api/quests` | state quest & XP saat ini |
| `ws://localhost:3000/ws` | sesi CLI interaktif (dipakai frontend) |

## 🕹️ Kontrol Terminal

| Tombol | Fungsi |
| --- | --- |
| `Enter` | kirim perintah |
| `↑` / `↓` | riwayat perintah (per sesi) |
| `Ctrl+C` | batalkan baris |
| `Ctrl+Z` | `end` (keluar dari mode konfigurasi) |
| `?` | bantuan kontekstual per mode (`show ?` juga didukung) |

## 📁 Struktur Proyek

```
netquest/
├── package.json              # dependency + scripts (npm run dev/test)
├── README.md
├── data/                     # "database" JSON MVP — mudah di-swap ke SQL
│   ├── commands.json         # ≥30 perintah: pattern regex, mode, handler, help
│   ├── devices.json          # state awal 6 perangkat (interface, ip, vlan, ...)
│   └── topology.json         # node + link (dipakai vis-network & mesin ping)
├── public/                   # frontend (tanpa build step)
│   ├── index.html
│   ├── css/style.css         # tema dark "hacker"
│   └── js/
│       ├── app.js            # bootstrap, WebSocket, routing pesan
│       ├── terminal.js       # xterm.js + editing baris di klien
│       ├── topology.js       # vis-network + pewarnaan link real-time
│       └── quest.js          # panel quest & XP
├── src/
│   ├── server/
│   │   ├── index.js          # Express + HTTP + WebSocket upgrade
│   │   └── ws.js             # handler sesi CLI + broadcast quest/netstate
│   ├── simulator/
│   │   ├── CiscoDevice.js    # state machine perangkat & mode CLI
│   │   ├── ip.js             # aritmetika IPv4 (subnet, prefix, MAC)
│   │   ├── network.js        # world, oper-status link, routing table, ping
│   │   ├── routing-protocols.js  # engine RIP/OSPF/EIGRP/BGP + adjacency + log
│   │   ├── l2-services.js        # VLAN domain, DHCP DORA, ACL, STP
│   │   └── pcap.js               # ekspor .pcap utk Wireshark
│   ├── parser/
│   │   ├── parser.js         # matching regex + caret invalid input + `?`
│   │   └── handlers.js       # implementasi perintah & formatter `show`
│   └── quests/
│       ├── definitions.json  # 16 quest: NPC, kondisi_awal (incl. sabotase), objektif, XP
│       └── quests.js         # QuestManager + health check otomatis
└── test/
    ├── smoke.js              # 142 assertions backend (npm test)
    └── ws-client-test.js     # uji end-to-end jalur WebSocket
```

## 🧠 Cara Kerja (singkat)

1. **State perangkat** — tiap perangkat adalah instance `CiscoDevice`:
   `interfaces {ip, mask, adminUp, operUp, description}`, `routes`, `vlans`,
   `arpTable`, `currentMode`. `operUp` dihitung dari status kedua ujung link.
2. **Parser** — input dicocokkan ke regex perintah yang *sah di mode saat ini*.
   Jika tidak cocok, parser mencari prefix valid terpanjang lalu meletakkan caret
   `^` tepat setelahnya; kesalahan semantik (octet > 255) dilaporkan handler
   dengan caret menunjuk argumennya.
3. **Ping** — `pingFrom()` menelusuri hop demi hop (maks 8): connected →
   static (longest prefix) → default gateway (PC). Setelah sampai, **rute balik**
   dicek juga. Berhasil → ARP kedua sisi terisi (dilihat oleh `show arp`).
4. **Quest** — `QuestManager.verifyAll(world)` dijalankan setiap perintah.
   Objektif berjenis `interface` (ip/status), `route` (ada di routing table),
   atau `ping` (sukses end-to-end). Semua terpenuhi → quest selesai + XP.

## 📜 Daftar Perintah (144 entri di `data/commands.json`)

| Grup | Perintah |
| --- | --- |
| Navigasi | `enable`, `disable`, `exit`/`ex`/`logout`, `end`, `configure terminal`, `do <exec>` |
| Global Config | `hostname <name>`, `no hostname`, `enable secret <pass>`, `enable password <pass>`, `line console 0`, `line vty 0 4`, `banner motd #teks#`, `interface <name>`, `interface range <range>`, `ip route <net> <mask> <nh>`, `no ip route …`, `router rip\|ospf <pid>\|eigrp <as>\|bgp <as>`, `no router …`, `access-list <1-99> permit\|deny …`, `no access-list <n>`, `ip nat inside source list <acl> interface <if> overload`, `ip dhcp pool <name>`, `no ip dhcp pool …`, `ip dhcp excluded-address <a> [<b>]`, `vlan <id>`, `no vlan <id>` (switch), `spanning-tree [vlan <id>] priority <n>` (switch) |
| Router Config | `network <net> [<wildcard> [area <n>]]`, `network <net> mask <mask>` (BGP), `neighbor <ip> remote-as <as>` (BGP), `no neighbor …`, `version <1\|2>` (RIP), `auto-summary` / `no auto-summary`, `passive-interface <if>` / `no passive-interface`, `router-id <ip>` (OSPF) |
| DHCP Config | `network <net> <mask>`, `default-router <ip>`, `dns-server <ip>` |
| VLAN Config | `name <text>` |
| Line Config | `password <pass>`, `login`, `no password`, `no login` |
| Interface Config | `ip address <ip> <mask>`, `no ip address`, `shutdown`, `no shutdown`, `description <text>`, `no description`, `switchport mode access\|trunk` (switch), `switchport access vlan <id>`, `switchport trunk native vlan <id>`, `switchport trunk allowed vlan <list\|all>`, `ip access-group <n> in\|out`, `no ip access-group …`, `ip nat inside\|outside`, `no ip nat …` |
| Show | `show ip interface brief`, `show ip interface`, `show ip route`, `show ip route <network>`, `show running-config`, `show startup-config`, `show interfaces`, `show interfaces <name>`, `show version`, `show arp`, `show vlan brief`, `show spanning-tree [vlan <id>]`, `show history`, `show clock`, `show ip protocols`, `show ip ospf`, `show ip ospf neighbor`, `show ip eigrp neighbors`, `show ip eigrp topology`, `show ip rip database`, `show ip bgp`, `show ip bgp summary`, `show access-lists`, `show ip dhcp binding`, `show ip nat translations`, `show capture`, `show services` (PC/server), `show logging` (router/switch) |
| Utility (IOS) | `ping <ip\|host>`, `traceroute <ip\|host>` (router/switch), `copy running-config startup-config`, `copy startup-config running-config`, `copy running-config tftp://<ip>/<file>` / `copy tftp://<ip>/<file> running-config`, `write memory`/`wr`, `erase startup-config`, `reload`, `connect <if> <device> <if>` / `disconnect <if>` (kabel runtime, semua perangkat), `interface add <name>` (tambah port baru), `clock rate <bps>` (port Serial/DCE), `logging <ip>` / `no logging` |
| Utility (PC, ala Windows/NetCLI) | `ipconfig`, `ipconfig /all`, `ipconfig /renew` (DHCP DORA), `ipconfig /release`, `arp -a`, `tracert <ip\|host>`, `ping <ip\|host>`, `nslookup <nama>`, `netstat`, `telnet <ip\|host>` (sesi CLI ke router/switch, keluar `exit`/`quit`), `web http://<host>/<page>`, `role <pc\|server>`, `service dhcp on\|off / range <a> <b> / gateway <ip> / dns <ip>`, `service dns on\|off / add <nama> <ip> / remove <nama>`, `service http\|tftp\|syslog on\|off`, `show capture`, `?` + `help` |

## 🧪 Virtual Lab Pribadi

Kanvas topologi milik pemain sendiri, terpisah dari lab utama & quest (tidak
mengganggu pemain lain). Ketik `lab ?` di terminal (atau tombol 🧪 lab):

```
lab start            masuk mode lab (clone lab utama, kondisi bebas dikonfigurasi)
lab add router R5    tambah perangkat baru (router|switch|pc)
lab connect r5 g0/0 r1 g0/2   sambungkan port — jenis kabel otomatis
lab disconnect r5 g0/0        lepas kabel
lab remove r5        hapus perangkat (+ kabelnya)
lab save <nama>      simpan lab pribadi (per browser: data/labs/<clientId>.json)
lab list / lab load <nama> / lab delete <nama> / lab reset
lab exit             kembali ke lab utama (quest & XP aktif kembali)
```

- Selama mode lab, badge **🧪 LAB PRIBADI** tampil di header dan peta topologi
  ikut berubah (pesan WS `lab-topology`); quest utama dijeda.
- Semua perintah IOS (IP address, VLAN, routing dinamis, service server, port
  serial + clock rate, dsb.) bekerja di kanvas lab pribadi.
- ClientId disimpan di `localStorage` browser — lab tersimpan otomatis
  milik sesi browser tersebut (personal, bukan global).

## 🖥️ Fitur ala NetCLI (PC/Server, port & kabel)

PC di NetQuest kini setara end-device simulator Android ala NetCLI/Packet Tracer:

- **Port variasi** — setiap perangkat bisa menambah port baru: `interface add
  serial0/0/0`, `interface add gigabitethernet0`, `interface add fa0/5`. Tipe port
  otomatis dari nama (FastEthernet/GigabitEthernet/Serial); port Serial punya
  `clock rate <bps>` (sisi DCE). `show interfaces` menampilkan tipe port & clock.
- **Kabel otomatis sesuai port** — `connect <if> <device> <remote-if>` menyambungkan
  dua port saat runtime dan memilih kabel otomatis: **Serial DCE/DTE** (serial↔serial),
  **Copper Straight-Through** (host↔switch), **Copper Cross-Over** (host↔host,
  switch↔switch). Port yang tidak kompatibel (ethernet vs serial) ditolak dengan
  pesan jelas; `disconnect <if>` melepas kabel. Jenis kabel juga tampil di API
  topologi (`/api/topology` → `links[].cable`).
- **PC ↔ Server** — `role server` mengubah PC menjadi server; `role pc` kembali.
- **Service server ala Packet Tracer** (di perangkat role server):
  - **DHCP** — `service dhcp on`, `service dhcp range <start> <end>`,
    `service dhcp gateway <ip>`, `service dhcp dns <ip>`; PC di LAN bisa
    `ipconfig /renew` dan menerima lease dari server (bukan hanya router pool).
  - **DNS** — `service dns on`, `service dns add web1 192.168.2.10`;
    record langsung dipakai `ping`/`traceroute`/`nslookup`/`web`.
  - **HTTP** — `service http on`; halaman dibuka dari PC dengan
    `web http://web1/index.html` (ala web browser Packet Tracer).
  - **TFTP** — `service tftp on`; router/switch menyimpan/memuat konfigurasi:
    `copy running-config tftp://192.168.2.10/r1-confg` dan sebaliknya.
  - **FTP** — `service ftp on`; PC melakukan sesi FTP: `ftp <ip|nama>` lalu
    `ls`, `get <file>`, `bye` (file bawaan: readme.txt, firmware-v2.bin).
  - **NTP** — `service ntp on` (stratum 1); router/switch sinkron waktu dengan
    `ntp server <ip>` → `show ntp status` bilang *Clock is synchronized*.
  - **Syslog** — `service syslog on`; router/switch mengirim event dengan
    `logging <ip>`, server menyimpan log (`show services` menampilkan jumlah).
  - Status semua service: `show services`; port listening: `netstat`.
- **Klien jaringan ala NetCLI** — `nslookup <nama>` (query ke DNS server),
  `netstat` (koneksi & port listening), `telnet <ip|host>` (sesi CLI remote ke
  router/switch dengan banner & prompt perangkat tujuan; `exit`/`quit` menutup),
  `ssh <ip|host>` (prasyarat: router punya `ip domain name` + `crypto key
  generate rsa`), `ftp <ip|host>` (sesi FTP), `web http://...` (HTTP client).

## 🧩 Fitur ala NetSim (terinspirasi joxorsayan/netsim)

Paket fitur di bawah diadopsi dari proyek [NetSim](https://github.com/joxorsayan/netsim)
(zero-install CCNA lab berbasis browser) dan diimplementasikan ulang di engine Node.js NetQuest:

- **VLAN & switchport** — `vlan <id>` (+ `name`), `switchport mode access|trunk`,
  `switchport access vlan`, `switchport trunk native/allowed vlan`. Isolasi L2 nyata:
  ping antar VLAN diblokir (`vlan-blocked`) dan `show vlan brief` menampilkan port
  anggota dinamis (access + trunk yang mengizinkan).
- **DHCP DORA** — `ip dhcp pool` / `excluded-address` / `default-router` / `dns-server`
  di router; PC melakukan Discover→Offer→Request→Ack lewat `ipconfig /renew`
  (broadcast dicarikan ke server DHCP yang benar-benar terjangkau di domain L2);
  `show ip dhcp binding` menampilkan lease.
- **ACL standar** — `access-list 1-99 permit|deny` (wildcard + `host` + `any`,
  implicit deny), `ip access-group in|out`; paket ping diblokir di hop router yang
  cocok; `show access-lists`.
- **NAT/PAT overload** — `ip nat inside/outside` + `ip nat inside source list <acl>
  interface <if> overload`; ping dari LAN ditulis ulang ke IP interface outside dan
  tercatat di `show ip nat translations`.
- **BGP eBGP** — `router bgp <as>`, `neighbor <ip> remote-as <as>`, `network <net>
  mask <mask>`; propagasi rute antar-AS dengan AS-path (AD 20), log
  `%BGP-5-ADJCHANGE: Neighbor <ip> Up`, `show ip bgp` + `show ip bgp summary`.
- **Spanning-tree** — `spanning-tree [vlan N] priority`; root bridge dipilih per
  pulau L2 (priority terendah, tie MAC), `show spanning-tree` ala PT.
- **Packet capture → .pcap** — setiap ping merekam frame di perangkat yang dilewati;
  `show capture` menampilkan ringkasan, tombol **⬇ pcap** di header konsol (atau
  `GET /api/pcap/<device>`) mengunduh file libpcap sah yang bisa dibuka di Wireshark.

Yang belum diadopsi dari NetSim (roadmap): IPv6 dual-stack, EtherChannel, FHRP
(HSRP/VRRP), redistribusi antar-protokol, dan AI tutor on-device.

## 🔄 Routing Dinamis (RIP v2 / OSPF / EIGRP)

Engine di `src/simulator/routing-protocols.js` menghitung ulang seluruh tabel
routing secara **deterministik & instan** setiap kali konfigurasi berubah —
tanpa menunggu timer — dengan metrik yang dihitung dari profil interface:

| Protokol | AD | Metrik | Contoh `show ip route` |
| --- | --- | --- | --- |
| RIP v2 | 120 | hop count (BFS, maks 15) | `R 192.168.2.0/24 [120/1] via 10.0.0.2, 00:00:05, GigabitEthernet0/1` |
| OSPF (single area) | 110 | Σ cost = 10⁸/BW | `O 192.168.2.0/24 [110/2] via 10.0.0.2, 00:00:07, GigabitEthernet0/1` |
| EIGRP | 90 | 256 × (10⁷/BW + Σdelay) | `D 192.168.2.0/24 [90/3072] via 10.0.0.2, 00:00:09, GigabitEthernet0/1` |

- **Log adjacency persis IOS/PT** muncul otomatis saat adjacency terbentuk/putus:
  `%OSPF-5-ADJCHG: Process 1, Nbr 10.0.0.2 on GigabitEthernet0/1 from LOADING to FULL, Loading Done`
  dan `%DUAL-5-NBRCHANGE: IP-EIGRP(0) 100: Neighbor 10.0.0.2 (GigabitEthernet0/1) is up: new adjacency`.
- **Kompetisi rute ala IOS**: untuk prefix yang sama, AD terendah menang
  (static 1 < EIGRP 90 < OSPF 110 < RIP 120).
- `show ip route` memakai format IOS 15 penuh: blok Codes, `Gateway of last
  resort`, pengelompokan `… is variably subnetted, N subnets, M masks`, dan
  kolom `[AD/metric] via …, uptime, interface`.
- `show ip eigrp topology` menampilkan successor dengan FD/RD nyata
  (`via 10.0.0.2 (3072/2816)`, GigE langsung = FD 2816).
- `passive-interface` memutus adjacency tapi subnet tetap diiklankan; OSPF
  butuh area yang sama, EIGRP butuh AS yang sama, RIP pakai batas classful.

## 🎯 Quest yang Tersedia

| # | Judul | NPC | XP | Inti masalah |
| --- | --- | --- | --- | --- |
| 1 | Sinyal Hilang ke Router-2 | Bu Sari (Staf Administrasi) | 100 | Interface WAN R1 di-shutdown + R2 tanpa rute balik |
| 2 | Kantor Cabang Terisolasi | Pak Budi (Manajer Cabang) | 150 | Routing statis antar-router belum lengkap |
| 3 | Gateway Gudang Salah Alamat | Rina (Kepala Gudang) | 150 | IP interface LAN R2 diganti orang iseng |
| 4 | Routing Dinamis: RIP v2 | Pak Hendra (Network Engineer) | 200 | Aktifkan RIP v2 di R1+R2, advertise semua jaringan |
| 5 | Upgrade ke OSPF Area 0 | Bu Maya (Arsitek Jaringan) | 200 | Migrasi ke OSPF single-area dengan wildcard 0.0.0.0 |
| 6 | Eksperimen EIGRP AS 100 | Rizky (Junior Admin) | 200 | EIGRP AS 100 di kedua router + bandingkan show ip route |
| 7 | PC Kantor Sudah Bosa Set IP Sendiri | Dewi (IT Support) | 175 | DHCP pool di R1 + PC-1 pindah ke otomatis (/release, /renew) |
| 8 | Server DNS Internal | Pak Anton (Admin Server) | 175 | role server + service DNS + record web1 -> IP |
| 9 | Portal Web Perusahaan | Nayla (Komunikasi) | 125 | service HTTP + buka halaman via `web http://...` |
| 10 | Backup Konfigurasi ke TFTP | Pak Hendra (Network Engineer) | 150 | service TFTP + copy running-config tftp:// |
| 11 | Sentral Log Syslog | Bu Maya (Arsitek Jaringan) | 150 | service Syslog + logging 192.168.2.10 di R1 |
| 12 | Manajemen Aman via SSH | Pak Anton (Admin Server) | 200 | ip domain name + crypto key generate rsa + ssh dari PC |
| 13 | Waktu Jaringan Tersinkron | Dewi (IT Support) | 150 | service NTP di server + ntp server di R1 & R2 |
| 14 | Segmentasi VLAN Kantor Baru | Rina (Kepala Gudang) | 175 | VLAN 20 OFFICE + Fa0/3 access VLAN 20 di SW-1 |
| 15 | Peering eBGP Antar-Cabang | Bu Maya (Arsitek Jaringan) | 225 | eBGP AS 65001<->65002 via WAN + advertise LAN |
| 16 | Insiden Besar: Audit Bersih-Bersih | Pak Direktur (Direktur Operasional) | 300 | Troubleshooting: rute hantu 192.168.9.0 di R2 + ACL sisa di Gi0/1 R1 (disuntikkan saat boot) |

Total **16 quest / 2825 XP**. Quest 16 menyuntikkan sabotase (rute statis salah +
ACL menempel di interface) lewat `initial` di definitions.json — pola yang sama
bisa dipakai guru untuk membuat quest troubleshooting tambahan.

## 🗺️ Walkthrough Quest #1 (langkah demi langkah)

**Cerita:** Bu Sari keluhan PC-1 tidak bisa ping ke Router-2 (10.0.0.2).
Kondisi awal yang disuntikkan game: `GigabitEthernet0/1` di R1 **shutdown**,
dan R2 belum punya rute balik ke LAN pusat.

1. **Diagnosis dari PC-1.** Klik node **PC-1** di topologi, lalu:
   ```
   PC-1> ping 10.0.0.2
   UUUUU
   Success rate is 0 percent (0/5)
   [diagnostik simulator: destination unreachable]
   ```
2. **Periksa interface di R1.** Klik node **R1**, lalu:
   ```
   R1> enable
   R1# show ip interface brief
   Interface                  IP-Address      OK? Method Status                Protocol
   GigabitEthernet0/0         192.168.1.1     YES manual up                    up
   GigabitEthernet0/1         10.0.0.1        YES manual administratively down down
   ```
   Baris `administratively down` = interface dimatikan lewat `shutdown`.
3. **Aktifkan interfacenya.**
   ```
   R1# configure terminal
   R1(config)# interface GigabitEthernet0/1
   R1(config-if)# no shutdown
   %LINK-5-CHANGED: Interface GigabitEthernet0/1, changed state to up
   %LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet0/1, changed state to up
   R1(config-if)# end
   ```
   Perhatikan: link R1–R2 di topologi berubah dari merah putus-putus menjadi hijau.
4. **Coba lagi dari PC-1 — masih gagal.**
   ```
   PC-1> ping 10.0.0.2
   UUUUU
   [diagnostik simulator: destination has no route back]
   ```
   Ini pelajaran penting: paket *sampai* ke R2, tapi R2 tidak tahu cara
   membalas ke 192.168.1.0/24.
5. **Tambahkan rute balik di R2.** Klik node **R2**:
   ```
   R2> enable
   R2# configure terminal
   R2(config)# ip route 192.168.1.0 255.255.255.0 10.0.0.1
   R2(config)# end
   R2# show ip route
   C    10.0.0.0/30 is directly connected, GigabitEthernet0/0
   L    10.0.0.2/32 is directly connected, GigabitEthernet0/0
   S    192.168.1.0/24 [1/0] via 10.0.0.1
   ```
6. **Verifikasi akhir dari PC-1.**
   ```
   PC-1> ping 10.0.0.2
   !!!!!
   Success rate is 100 percent (5/5), round-trip min/avg/max = 4/6/10 ms
   ```
   Ketiga objektif quest #1 tercentang otomatis → toast **“Quest selesai:
   Sinyal Hilang ke Router-2 (+100 XP)”** muncul dan XP di kanan atas naik.

> 💡 Objektif quest #2/#3 juga bisa dikerjakan secara bebas; health check
> berjalan untuk semua quest setiap kali Anda mengetik perintah.

## 🧪 Testing

```bash
npm test                  # 142 assertions: parser, caret, show, ping, quest (16), RIP-OSPF-EIGRP-BGP, VLAN-DHCP-ACL-NAT-STP-pcap, NetCLI, SSH-FTP-NTP, lab pribadi
node test/ws-client-test.js   # uji WS end-to-end (server harus berjalan)
```

## 🔌 Catatan Arsitektur & Rencana Pengembangan

- **Database**: MVP memakai JSON (`data/*.json`) yang dibaca saat boot dan
  state live di memori. Untuk pindah ke SQLite/PostgreSQL, cukup ganti lapisan
  pemuatan di `src/server/index.js` (`readJson`) menjadi query — bentuk objek
  device sengaja dibuat flat dan stabil.
- **Progress/XP** tersimpan di memori; restart server mengembalikan kondisi
  awal lab (praktisnya: reset permainan). Refresing halaman *tidak* me-reset lab.
- **Tab-completion** dan `--More--` pager belum diimplementasikan (di luar
  scope MVP); editing baris & riwayat sudah ditangani klien.
- Menambah perintah baru = menambah 1 entri di `data/commands.json`
  (pattern/mode/handler/help) + 1 fungsi handler di `src/parser/handlers.js`.
- Menambah quest = menambah entri di `src/quests/definitions.json`
  tanpa menyentuh kode verifier.
