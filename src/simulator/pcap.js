/**
 * pcap.js — ekspor log frame perangkat ke file .pcap (format libpcap klasik)
 * sehingga hasil "ping" bisa dianalisis di Wireshark, seperti fitur packet
 * capture NetSim. Frame Ethernet+IPv4+ICMP disintesis dari captureLog.
 */

const PCAP_MAGIC = 0xa1b2c3d4; // little-endian, microsecond

function u32(arr, v) {
  arr.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
}
function u16(arr, v) {
  arr.push(v & 255, (v >>> 8) & 255);
}

/** MAC "aa:bb:cc:dd:ee:ff" -> 6 byte. */
function macBytes(mac) {
  return (mac || 'ff:ff:ff:ff:ff:ff').split(':').map((h) => parseInt(h, 16) & 255);
}

/** IPv4 "a.b.c.d" -> 4 byte. */
function ipBytes(ip) {
  return String(ip || '0.0.0.0').split('.').map((h) => parseInt(h, 10) & 255);
}

/** Frame Ethernet + IPv4 + ICMP echo (request/reply) sederhana namun sah. */
function icmpFrame({ srcMac, dstMac, srcIp, dstIp, reply }) {
  const f = [];
  f.push(...macBytes(dstMac)); // dst
  f.push(...macBytes(srcMac)); // src
  u16(f, 0x0800); // EtherType IPv4

  const ipStart = f.length;
  const totalLen = 20 + 8 + 8; // IP + ICMP header + payload
  f.push(0x45, 0x00);
  u16(f, totalLen);
  u16(f, 0x1234); // id
  u16(f, 0x0000); // flags/frag
  f.push(64, 1); // TTL, proto ICMP
  const cksumPos = f.length;
  u16(f, 0x0000); // placeholder checksum
  f.push(...ipBytes(srcIp));
  f.push(...ipBytes(dstIp));
  // header checksum IP (sederhana, word 16-bit)
  let sum = 0;
  for (let i = ipStart; i < f.length; i += 2) sum += (f[i] << 8) | f[i + 1];
  while (sum >>> 16) sum = (sum & 0xffff) + (sum >>> 16);
  const ck = (~sum) & 0xffff;
  f[cksumPos] = (ck >>> 8) & 255;
  f[cksumPos + 1] = ck & 255;

  f.push(reply ? 0 : 8, 0x00, 0x00, 0x00); // type echo request/reply, code, cksum
  u16(f, 0x0001); // identifier
  u16(f, 0x0001); // sequence
  f.push(0x4e, 0x65, 0x74, 0x51, 0x75, 0x65, 0x73, 0x74); // payload "NetQuest"

  return f;
}

/**
 * Bangun byte array file .pcap dari captureLog sebuah device.
 * Entry log = {ts, summary, srcIp, dstIp, srcMac, dstMac, bytes}.
 */
export function pcapFromCapture(entries) {
  const out = [];
  // Global header: magic, ver 2.4, tz 0, sigfigs 0, snaplen 65535, network 1 (Ethernet)
  u32(out, PCAP_MAGIC);
  u16(out, 2); u16(out, 4);
  u32(out, 0); u32(out, 0); u32(out, 65535); u32(out, 1);

  for (const e of entries || []) {
    const ts = new Date(e.ts || Date.now());
    const tsSec = Math.floor(ts.getTime() / 1000);
    const tsUsec = (ts.getTime() % 1000) * 1000;
    const frame = icmpFrame(e);
    // Record header: ts_sec, ts_usec, incl_len, orig_len
    u32(out, tsSec); u32(out, tsUsec);
    u32(out, frame.length); u32(out, frame.length);
    out.push(...frame);
  }
  return out;
}
