/**
 * terminal.js — xterm.js + klien WebSocket.
 *
 * Editing baris dilakukan di klien (echo lokal): tiap keystroke ditampilkan
 * langsung; saat Enter, baris utuh dikirim ke server dieksekusi simulator.
 * Server membalas {type:'output'} + {type:'prompt'} — prompt digambar ulang
 * di baris baru. Riwayat perintah (↑/↓) juga di klien per sesi.
 */

export class NetTerm {
  constructor(container, { onCommand } = {}) {
    this.container = container;
    this.onCommand = onCommand;
    this.buffer = '';
    this.history = [];
    this.historyIdx = -1;
    this.currentPrompt = '';
    this.attachedDevice = null;

    this.term = new Terminal({
      fontFamily: '"Cascadia Mono", "JetBrains Mono", Menlo, Consolas, monospace',
      fontSize: window.innerWidth < 700 ? 12 : 13,
      lineHeight: 1.15,
      cursorBlink: true,
      convertEol: false,
      theme: {
        background: '#050a08',
        foreground: '#00ff9c',
        cursor: '#00ff9c',
        cursorAccent: '#050a08',
        selectionBackground: '#0f3d2e',
        black: '#050a08',
        green: '#00ff9c',
        cyan: '#22d3ee',
        yellow: '#fbbf24',
        red: '#f87171',
      },
    });
    this.fit = new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(container);
    this.fit.fit();

    window.addEventListener('resize', () => this.refit());

    this.term.onData((d) => this.handleKey(d));
  }

  /** Raw key handling: echo lokal, editing sederhana, history, shortcut. */
  handleKey(data) {
    switch (true) {
      case data === '\r': // Enter
        this.term.write('\r\n');
        const line = this.buffer;
        this.buffer = '';
        if (line.trim() !== '') {
          this.history.push(line);
        }
        this.historyIdx = -1;
        this.onCommand?.(line);
        break;
      case data === '\x7f': // Backspace
        if (this.buffer.length > 0) {
          this.buffer = this.buffer.slice(0, -1);
          this.term.write('\b \b');
        }
        break;
      case data === '\x03': // Ctrl+C
        this.term.write('^C\r\n');
        this.buffer = '';
        this.term.write(this.currentPrompt);
        break;
      case data === '\x1a': // Ctrl+Z = end (kirim sebagai control ke server)
        this.term.write('^Z\r\n');
        this.buffer = '';
        this.onCommand?.('\x1a');
        break;
      case data === '\x1b[A': // Up — history
        this.navigateHistory(-1);
        break;
      case data === '\x1b[B': // Down
        this.navigateHistory(1);
        break;
      case data === '\t':
        // Tab-completion belum di MVP; abaikan.
        break;
      default:
        if (data >= ' ' || data === '\t') {
          this.buffer += data;
          this.term.write(data);
        }
    }
  }

  navigateHistory(dir) {
    if (this.history.length === 0) return;
    let idx = this.historyIdx;
    if (dir < 0) idx = idx === -1 ? this.history.length - 1 : Math.max(0, idx - 1);
    else idx = idx === -1 ? -1 : Math.min(this.history.length - 1, idx + 1);
    if (dir > 0 && this.historyIdx !== -1 && idx === this.history.length - 1) {
      // turun melewati terakhir -> kosongkan baris
    }
    this.historyIdx = idx;
    const entry = idx === -1 ? '' : this.history[idx];
    // Hapus baris terlihat lalu tulis ulang (baris bisa lebih panjang dari entry).
    this.term.write('\r\x1b[K' + this.currentPrompt + entry);
    this.buffer = entry;
  }

  writeln(text) {
    this.term.write(text.replace(/\r?\n/g, '\r\n') + '\r\n');
  }

  writePrompt(prompt) {
    if (!prompt) return;
    this.currentPrompt = prompt;
    this.term.write(`\x1b[36m${prompt}\x1b[0m`);
  }

  /**
   * Bersihkan layar. keepPrompt=false dipakai saat attach device baru:
   * prompt lama tidak digambar ulang (server akan mengirim prompt baru).
   */
  clear(keepPrompt = true) {
    this.term.write('\x1b[2J\x1b[H');
    this.buffer = '';
    if (keepPrompt && this.currentPrompt) {
      this.writePrompt(this.currentPrompt);
    } else if (!keepPrompt) {
      this.currentPrompt = '';
    }
  }

  focus() { this.term.focus(); }
  get cols() { return this.term.cols; }

  /** Ukur ulang ukuran terminal setelah panelnya terlihat/di-resize. */
  refit() {
    try { this.fit.fit(); } catch { /* panel belum terlihat: abaikan */ }
  }

  /** Sisipkan teks pada posisi kursor (dipakai tombol cepat di layar sentuh). */
  insert(text) {
    if (!text) return;
    this.buffer += text;
    this.term.write(text);
    this.focus();
  }

  /** Kirim control char ('c' -> Ctrl+C, 'z' -> Ctrl+Z) seolah ditekan keyboard. */
  sendCtrl(ch) {
    const c = String(ch || '').toLowerCase().charAt(0);
    const code = c.charCodeAt(0) - 96; // a..z -> 1..26
    if (code >= 1 && code <= 26) this.handleKey(String.fromCharCode(code));
    this.focus();
  }
}
