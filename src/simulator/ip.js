/**
 * ip.js — utilitas aritmetika IPv4 untuk simulator.
 * Semua perhitungan subnet dilakukan di sini agar handler `show`/ping
 * tidak perlu mengulang logika bit-manipulation.
 */

/** "192.168.1.1" -> 3232235777 (unsigned 32-bit). Mengembalikan null jika tidak valid. */
export function ipToInt(ip) {
  if (typeof ip !== 'string') return null;
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out >>> 0;
}

/** 3232235777 -> "192.168.1.1" */
export function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** Validasi ketat: octet 0-255, tepat 4 bagian. */
export function isValidIp(ip) {
  return ipToInt(ip) !== null;
}

/** Validasi subnet mask: setiap octet valid. (Kontiguitas mask tidak dipaksa, sesuai MVP.) */
export function isValidMask(mask) {
  return ipToInt(mask) !== null;
}

/** "255.255.255.0" -> 24 */
export function maskToPrefix(mask) {
  const m = ipToInt(mask);
  if (m === null) return null;
  let count = 0;
  for (let i = 31; i >= 0; i--) {
    if ((m >>> i) & 1) count++;
    else break; // berhenti di bit 0 pertama (mask harus kontigu untuk prefix yang benar)
  }
  return count;
}

/** Network address dari pasangan ip + mask, mis. "192.168.1.1" + "255.255.255.0" -> "192.168.1.0" */
export function networkOf(ip, mask) {
  const a = ipToInt(ip);
  const m = ipToInt(mask);
  if (a === null || m === null) return null;
  return intToIp((a & m) >>> 0);
}

/** Apakah `ip` berada di dalam subnet `network/mask`? */
export function inSubnet(ip, network, mask) {
  const a = ipToInt(ip);
  const n = ipToInt(network);
  const m = ipToInt(mask);
  if (a === null || n === null || m === null) return false;
  return ((a & m) >>> 0) === ((n & m) >>> 0);
}

/** Deterministic MAC address per (deviceId, interfaceName) — gaya Cisco "000d.bd.xxxx.xxxx". */
export function macFor(deviceId, ifName) {
  let h = 0x811c9dc5;
  const seed = `${deviceId}|${ifName}`;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const hex = (n) => n.toString(16).padStart(4, '0');
  const mac = `000d.bd${hex(h & 0xffff)}.${hex(Math.imul(h ^ 0x9e3779b9, 0x85ebca6b) >>> 0 & 0xffff)}`;
  return mac;
}
