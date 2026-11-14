/**
 * parser.js — CLI parser context-aware per perangkat.
 *
 * Aturan utama (meniru perilaku IOS):
 *  1. Regex ketat per perintah (dari data/commands.json) + cek mode.
 *  2. Tidak cocok  -> cari prefix valid TERPANJANG dari input; caret diletakkan
 *     tepat setelahnya (IOS menunjuk token pertama yang salah).
 *  3. Perintah valid di mode lain -> invalid dengan caret di kolom 0.
 *  4. Handler bisa mengembalikan {error, caret} utk kesalahan semantik
 *     (mis. octet 999) dan caret menunjuk argumen yang salah.
 *  5. `prefix ?` -> daftar perintah yang cocok dengan prefix tersebut.
 */

import * as handlers from './handlers.js';
import { adjacencyEvents } from '../simulator/routing-protocols.js';

export class CommandParser {
  /**
   * @param {{commands: Array}} commandsJson isi data/commands.json
   */
  constructor(commandsJson) {
    this.all = commandsJson.commands;
    for (const c of this.all) {
      c.regex = new RegExp(c.pattern); // pattern sudah ber-anchor ^...$
      c.regexOpen = new RegExp(c.pattern.replace(/\$\$/, '').replace(/\$$/, '')); // tanpa $ utk prefix test
      if (!c.deviceTypes) c.deviceTypes = ['router', 'switch'];
      c.modeList = Array.isArray(c.mode) ? c.mode : [c.mode];
    }
  }

  /** Perintah yang sah untuk tipe perangkat ini (tanpa melihat mode). */
  commandsFor(device) {
    return this.all.filter((c) => c.deviceTypes.includes(device.type));
  }

  /** Perintah sah untuk device + mode saat ini. */
  allowedCommands(device) {
    return this.commandsFor(device).filter((c) => c.modeList.includes(device.currentMode));
  }

  /**
   * Eksekusi satu baris perintah.
   * Return { output, promptChanged } — output sudah final (string, mungkin kosong).
   * `promptChanged` true bila hostname/mode berubah sehingga prompt harus dikirim ulang.
   */
  execute(device, rawLine, world) {
    const line = rawLine.replace(/\s+$/, '').replace(/^\s+/, '');
    if (line === '') return { output: '', promptChanged: false };

    // Sesi FTP (PC -> server): protokol mini ftp — ls / get / bye.
    if (device.ftpSession) {
      const target = world.devices.get(device.ftpSession);
      if (!target) {
        device.ftpSession = null;
      } else {
        const cmd = line.trim().toLowerCase();
        if (['bye', 'quit', 'exit'].includes(cmd)) {
          device.ftpSession = null;
          return { output: `221 Goodbye.`, prompt: device.prompt, promptChanged: true };
        }
        if (cmd === 'ls' || cmd === 'dir') {
          const files = target.services?.ftp?.files || {};
          return {
            output: ['150 Opening data connection.', ...Object.entries(files).map(([f, c]) => `${f.padEnd(24)} ${c.length} bytes`), '226 Transfer complete.'].join('\n'),
            prompt: 'ftp> ', promptChanged: true,
          };
        }
        const getMatch = /^(?:get|recv)\s+(\S+)$/.exec(cmd);
        if (getMatch) {
          const files = target.services?.ftp?.files || {};
          const f = getMatch[1];
          if (!files[f]) return { output: `550 File '${f}' tidak ada.`, prompt: 'ftp> ', promptChanged: true };
          return {
            output: [`150 Opening BINARY mode data connection for ${f}.`, `226 Transfer complete (${files[f].length} bytes).`, '', files[f].startsWith('[binary') ? '(file binary — konten tidak ditampilkan)' : files[f]].join('\n'),
            prompt: 'ftp> ', promptChanged: true,
          };
        }
        if (cmd === 'help' || cmd === '?') {
          return { output: 'Perintah FTP: ls, get <file>, bye', prompt: 'ftp> ', promptChanged: true };
        }
        if (cmd === '') return { output: '', prompt: 'ftp> ', promptChanged: false };
        return { output: `500 '${line.trim()}' tidak dikenal (ls, get <file>, bye).`, prompt: 'ftp> ', promptChanged: true };
      }
    }

    // Sesi telnet (PC -> router/switch): baris dieksekusi di perangkat tujuan.
    // 'exit' di user mode tujuan (atau 'quit') menutup sesi dan kembali ke PC.
    if (device.telnetSession) {
      const closeNow = line.toLowerCase() === 'quit' ||
        (line.toLowerCase() === 'exit' && world.devices.get(device.telnetSession)?.currentMode === 'user');
      if (closeNow) {
        const closed = world.devices.get(device.telnetSession);
        device.telnetSession = null;
        return { output: `Connection to ${closed?.hostname ?? 'host'} closed.`, prompt: device.prompt, promptChanged: true };
      }
      const target = world.devices.get(device.telnetSession);
      if (!target) {
        device.telnetSession = null;
      } else {
        const res = this.execute(target, line, world);
        return { ...res, prompt: target.prompt, promptChanged: true };
      }
    }

    // Ctrl+Z dari terminal = `end` (bawa klien sebagai \x1a).
    const effective = line === '\x1a' ? 'end' : line;
    if (effective !== line) return this.execute(device, effective, world);

    // `prefix ?` (mis. "show ?") -> bantuan kontekstual, bukan perintah penuh.
    if (effective.endsWith('?') && effective.length > 1) {
      const help = this.helpForPrefix(device, effective.slice(0, -1));
      return { output: help ?? `% Unrecognized command`, promptChanged: false };
    }

    const allowed = this.allowedCommands(device);

    // 1) Coba full match pada perintah sah di mode ini.
    for (const cmd of allowed) {
      const m = cmd.regex.exec(effective);
      if (m) {
        const argIndices = collectArgIndices(cmd.regex, effective, m);
        const ctx = {
          device, world,
          args: m.groups || {},
          argIndices,
          line: effective,
          commands: allowed,
          execute: (dev, subLine, w) => this.execute(dev, subLine, w), // dipakai `do`
        };
        const beforeMode = device.currentMode;
        const beforeHost = device.hostname;
        let result;
        try {
          result = handlers[cmd.handler]?.(ctx);
          if (result === undefined || result === null) result = '';
          if (typeof result === 'string') result = { output: result };
        } catch (err) {
          result = { output: `% Simulator error: ${err.message}` };
        }
        // Kesalahan semantik dari handler (mis. octet 999) -> invalid input
        // dengan caret menunjuk argumen yang salah.
        if (result.error) {
          return { output: invalidInputText(effective, result.caret ?? 0, result.error), promptChanged: false };
        }
        // Log adjacency routing dinamis (RIP tanpa log; OSPF/EIGRP ala IOS):
        // rekonvergensi instan -> event muncul pada perintah yang mengubahnya.
        const adjEvents = adjacencyEvents(world).filter((e) => e.deviceId === device.id);
        if (adjEvents.length) {
          result.syslog = [...(result.syslog || []), ...adjEvents.map((e) => e.text)];
        }
        const promptChanged = device.currentMode !== beforeMode || device.hostname !== beforeHost;
        if (effective !== '?' && !cmd.name.startsWith('do')) pushHistory(device, effective);
        return { output: result.output || '', syslog: result.syslog || null, promptChanged };
      }
    }

    // 2) Cocok di mode LAIN -> invalid di kolom 0 (perilaku IOS di config mode).
    const inOtherMode = this.commandsFor(device).some(
      (c) => c.modeList.some((mo) => mo !== device.currentMode) && c.regex.exec(effective)
    );
    const caret = inOtherMode ? 0 : longestValidPrefix(allowed, effective);
    // Perintah salah tetap masuk riwayat (perilaku IOS `show history`).
    if (effective !== '?') pushHistory(device, effective);
    return { output: invalidInputText(effective, caret), promptChanged: false };
  }

  /**
   * Bantuan `prefix ?` — mis. "show ?" atau "sh ?".
   * Memakai field `usage` tiap perintah: token per token, token user boleh
   * merupakan singkatan (prefix) dari token usage — mirip perilaku IOS.
   * Return string bantuan atau null bila tidak ada yang cocok.
   */
  helpForPrefix(device, prefixLine) {
    const prefix = prefixLine.trim();
    if (prefix === '') return null;
    const tokens = prefix.split(/\s+/);
    const allowed = this.allowedCommands(device);
    const matches = allowed.filter((c) => {
      if (!c.usage) return false;
      const usageTokens = c.usage.split(' ');
      if (tokens.length > usageTokens.length) return false;
      return tokens.every((t, i) => usageTokens[i].startsWith(t));
    });
    if (matches.length === 0) return null;
    return matches
      .map((c) => `  ${padUsage(c.usage, 38)}${c.help}`)
      .join('\n');
  }
}

/** Catat perintah ke riwayat device (`show history`), max 50 entri. */
function pushHistory(device, line) {
  if (!line.trim()) return;
  device.commandHistory = device.commandHistory || [];
  device.commandHistory.push(line);
  if (device.commandHistory.length > 50) device.commandHistory.shift();
}

/** Kumpulkan offset kolom tiap named group (butuh flag d saat regex dibuat dinamis). */
function collectArgIndices(regex, line, match) {
  // Regex dari JSON dibuat tanpa flag d; hitung manual dengan exec ulang ber-flag d.
  try {
    const reD = new RegExp(regex.source, 'd');
    const m2 = reD.exec(line);
    if (m2?.indices?.groups) return new Map(Object.entries(m2.indices.groups));
  } catch { /* fallback di bawah */ }
  return new Map();
}

/**
 * Kolom caret utk input yang tidak dikenal: panjang prefix valid terpanjang,
 * lalu lewati spasi (IOS menunjuk token pertama yang bermasalah).
 */
function longestValidPrefix(allowed, line) {
  let best = 0;
  for (const cmd of allowed) {
    const m = cmd.regexOpen.exec(line);
    if (m && m[0].length > best) best = m[0].length;
  }
  let caret = best;
  while (caret < line.length && line[caret] === ' ') caret++;
  return Math.min(caret, line.length);
}

/** Susun teks invalid input ala IOS: baris spasi + '^' + pesan (opsional diawali pesan semantik). */
export function invalidInputText(line, caret, semanticMessage = null) {
  const caretLine = `${' '.repeat(caret)}^\n% Invalid input detected at '^' marker.`;
  return semanticMessage ? `${caretLine}\n${semanticMessage}` : caretLine;
}

function padUsage(s, width) {
  s = String(s ?? '');
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}
