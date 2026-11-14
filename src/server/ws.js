/**
 * ws.js — WebSocket handler: sesi CLI interaktif tiap koneksi.
 *
 * Protokol JSON:
 *   client -> server : {type:'attach', deviceId, clientId?} | {type:'input', line}
 *   server -> client : {type:'attached',...} | {type:'output', text, prompt}
 *                      | {type:'quests', data} | {type:'netstate', ...}
 *                      | {type:'notify', text} | {type:'lab-topology', data}
 *
 * Virtual Lab Pribadi: perintah `lab ...` (lihat simulator/lab.js) ditangani
 * SEBELUM parser — dunia sesi (ws.labState.world) terpisah dari lab utama,
 * sehingga tiap pemain bisa membangun topologinya sendiri tanpa mengganggu
 * lab utama, quest, dan pemain lain.
 */

import { refreshOperStatus, linkStatuses } from '../simulator/network.js';
import { executeLabCommand } from '../simulator/lab.js';

export function initWebSocket(wss, appState) {
  const { world, parser, quests, labStore } = appState;

  wss.on('connection', (ws) => {
    let attachedId = null;
    ws.labState = { active: false, world: null, lastSpec: null, savedName: null, clientId: 'anon' };

    /** Dunia yang aktif untuk klien ini: lab pribadi atau lab utama. */
    const worldFor = () => (ws.labState.active && ws.labState.world ? ws.labState.world : world);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === 'attach') {
        if (msg.clientId) ws.labState.clientId = String(msg.clientId).slice(0, 64);
        const W = worldFor();
        const dev = W.devices.get(msg.deviceId);
        if (!dev) {
          ws.send(JSON.stringify({ type: 'error', text: `Device '${msg.deviceId}' tidak ditemukan.` }));
          return;
        }
        attachedId = dev.id;
        // Satu pemain MVP: sesi CLI baru selalu mulai dari user EXEC.
        dev.setMode('user');
        refreshOperStatus(W);
        const welcome = buildWelcome(dev);
        ws.send(JSON.stringify({
          type: 'attached',
          deviceId: dev.id,
          hostname: dev.hostname,
          deviceType: dev.type,
          role: dev.role,
          welcome,
          prompt: dev.prompt,
        }));
        sendQuests(ws, quests);
        sendNetState(ws, W);
        return;
      }

      if (msg.type === 'reset') {
        onReset?.(wss);
        return;
      }

      if (msg.type === 'input' && attachedId) {
        const line = String(msg.line ?? '');

        // ---- Virtual Lab Pribadi: `lab ...` ditangani di luar parser ----
        if (/^lab(\s|$)/i.test(line.trim())) {
          handleLabCommand(ws, attachedId, line);
          return;
        }

        const W = worldFor();
        const dev = W.devices.get(attachedId);
        if (!dev) {
          ws.send(JSON.stringify({ type: 'error', text: 'Perangkat tidak ada di kanvas aktif.' }));
          return;
        }
        const beforeHost = dev.hostname;
        const res = parser.execute(dev, line, W);
        refreshOperStatus(W);

        // Riwayat perintah dicatat oleh parser (lihat pushHistory) — dipakai `show history`.

        // Saat sesi telnet/FTP aktif, prompt = prompt sesi (res.prompt).
        const effPrompt = res.prompt || dev.prompt;
        const out = [];
        if (res.syslog?.length) out.push(...res.syslog);
        if (res.output) out.push(res.output);

        // Caret line harus sejajar dengan baris yang di-echo klien (prompt + perintah).
        let text = out.join('\n');
        text = alignCaretToPrompt(text, effPrompt);

        ws.send(JSON.stringify({
          type: 'output',
          text,
          prompt: effPrompt,
          echo: line, // klien memakainya utk caret alignment
        }));

        // Health check quest SELALU terhadap lab utama (quest = materi utama;
        // lab pribadi adalah playground bebas yang tidak menyelesaikan quest).
        const justCompleted = quests.verifyAll(world);
        sendQuests(ws, quests);
        sendNetStateFor(wss); // tiap klien menerima netstate dunianya sendiri
        for (const q of justCompleted) {
          broadcast(wss).send(JSON.stringify({
            type: 'notify',
            kind: 'quest-complete',
            text: `Quest selesai: ${q.title} (+${q.xp} XP)`,
          }));
        }
        if (dev.hostname !== beforeHost) {
          // Hostname berubah — semua sesi yang menempel di device ini ikut berubah.
          ws.send(JSON.stringify({ type: 'hostname-changed', hostname: dev.hostname, deviceType: dev.type }));
        }
        return;
      }
    });

    /** Eksekusi perintah `lab ...` + respons topologi terbaru ke klien. */
    function handleLabCommand(ws, currentAttachedId, line) {
      const res = executeLabCommand(ws.labState, line, world, { store: labStore });
      if (res.error) {
        ws.send(JSON.stringify({
          type: 'output',
          text: `^ \n% ${res.error}`,
          prompt: currentAttachedId ? (worldFor().devices.get(currentAttachedId)?.prompt ?? 'lab> ') : 'lab> ',
          echo: line,
        }));
        return;
      }
      const attachedDev = worldFor().devices.get(currentAttachedId);
      ws.send(JSON.stringify({
        type: 'output',
        text: res.output,
        prompt: res.exitLab ? 'lab utama> ' : (attachedDev?.prompt ?? 'lab> '),
        echo: line,
      }));
      if (res.topology) {
        ws.send(JSON.stringify({ type: 'lab-topology', data: res.topology }));
        sendNetState(ws, ws.labState.world);
      }
      if (res.exitLab) {
        // Perangkat yang sedang di-attach mungkin tidak ada di lab utama.
        if (currentAttachedId && !world.devices.get(currentAttachedId)) {
          attachedId = null;
          ws.send(JSON.stringify({ type: 'detached', reason: 'lab-exited' }));
        } else if (currentAttachedId) {
          sendNetState(ws, world);
        }
      }
      if (res.worldChanged && !res.topology && ws.labState.active) {
        sendNetState(ws, ws.labState.world);
      }
    }
  });
}

/** Netstate dikirim per klien: lab pribadi menerima dunianya sendiri. */
function sendNetStateFor(wss) {
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    const W = client.labState?.active && client.labState.world ? client.labState.world : null;
    if (W) sendNetState(client, W);
  }
}

function broadcast(wss) {
  return {
    send: (data) => {
      for (const client of wss.clients) {
        if (client.readyState === 1) client.send(data);
      }
    },
  };
}

/**
 * Geser baris caret (spasi + '^') sebanyak panjang prompt, karena klien
 * men-echo prompt+perintah di baris yang sama; caret output muncul di baris
 * baru yang mulai dari kolom 0.
 */
function alignCaretToPrompt(text, prompt) {
  if (!text || !text.includes("'^' marker")) return text;
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => /^\s+\^$/.test(l));
  if (idx === -1) return text;
  const spaces = lines[idx].length - 1; // jumlah spasi sebelum '^'
  lines[idx] = ' '.repeat(prompt.length + spaces) + '^';
  return lines.join('\n');
}

function sendQuests(target, quests) {
  target.send(JSON.stringify({ type: 'quests', data: quests.snapshot() }));
}

function sendNetState(target, W) {
  target.send(JSON.stringify({
    type: 'netstate',
    links: linkStatuses(W),
    devices: [...W.devices.values()].map((d) => d.toSummary()),
  }));
}

/** Banner "masuk console" ala kabel console/telnet + MOTD bila dipasang. */
function buildWelcome(dev) {
  const typeLabel = dev.isRouter ? 'Router' : dev.isSwitch ? 'Switch' : 'PC';
  const lines = [
    `Connecting to ${dev.hostname} (${typeLabel}) ...`,
    'Trying 127.0.0.1 ...',
    '',
    'Escape character is \'^]\'.',
    '',
  ];
  if (dev.bannerMotd) {
    lines.push(dev.bannerMotd, '');
  }
  lines.push(
    dev.isPc
      ? 'NetQuest PC Console. Ketik `?` untuk daftar perintah.'
      : `${dev.hostname} con0 is now available`,
    '',
    'Press RETURN to get started.',
    '',
  );
  return lines.join('\r\n');
}
