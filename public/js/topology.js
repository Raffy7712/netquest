/**
 * topology.js — visualisasi topologi dengan vis-network.
 * Layout fixed (koordinat dari data/topology.json), fisika dimatikan agar
 * lab tidak "melenting". Status link (up/down) diperbarui dari event WS.
 * Node memakai ikon perangkat gaya Packet Tracer (icons.js).
 */

import { iconDataUri, TYPE_LABEL } from './icons.js';

export class TopologyView {
  constructor(container, { onNodeClick } = {}) {
    this.container = container;
    this.onNodeClick = onNodeClick;
    this.network = null;
    this.nodes = null;
    this.edges = null;
    this.edgeByLink = new Map(); // "aDevice:aIf|bDevice:bIf" -> edge id
    this.types = new Map();      // deviceId -> tipe (utk ikon header konsol)
  }

  async load() {
    const res = await fetch('/api/topology');
    const topo = await res.json();
    return this.build(topo);
  }

  /** Bangun ulang graf dari topologi mana pun (lab utama / lab pribadi). */
  async build(topo) {
    // Hancurkan graf lama agar edge id & edgeByLink ter-reset bersih.
    if (this.network) {
      this.network.destroy();
      this.network = null;
      this.edgeByLink = new Map();
    }

    const nodeData = topo.nodes.map((n) => {
      const dev = topo.devices?.find((d) => d.id === n.id);
      this.types.set(n.id, n.type);
      return {
        id: n.id,
        label: n.label,
        x: n.x,
        y: n.y,
        shape: 'image',
        image: {
          unselected: iconDataUri(n.type),
          selected: iconDataUri(n.type, { selected: true }),
        },
        size: 30,
        fixed: true,
        physics: false,
        font: { color: '#c9e8d8', size: 13, face: 'monospace', vadjust: 34 },
        title: buildTooltip(n, dev),
      };
    });

    const edgeData = topo.links.map((l, idx) => {
      const key = linkKey(l);
      this.edgeByLink.set(key, idx);
      return {
        id: idx,
        from: l.a.device,
        to: l.b.device,
        color: { color: '#00ff9c', highlight: '#ffffff' },
        width: 2.5,
        dashes: false,
        label: '',
        font: { size: 9, color: '#6b8f7d', face: 'monospace' },
        selectionWidth: 0,
      };
    });

    this.nodes = new vis.DataSet(nodeData);
    this.edges = new vis.DataSet(edgeData);

    const options = {
      autoResize: true,
      physics: { enabled: false },
      interaction: {
        hover: true,
        dragNodes: false,
        dragView: true,
        zoomView: true,
        tooltipDelay: 120,
      },
    };

    this.network = new vis.Network(this.container, { nodes: this.nodes, edges: this.edges }, options);
    // Ekspos instance utk debugging/integrasi (aman; dipakai test & future fitur).
    this.container.__visNetwork = this.network;
    this.network.on('click', (params) => {
      if (params.nodes.length > 0) this.onNodeClick?.(params.nodes[0]);
    });
    // Muat seluruh lab ke pandangan (layout fixed, fisika mati).
    this.network.fit({ animation: false });
    // Re-fit saat orientasi/ukuran layar berubah (mis. rotasi ponsel).
    window.addEventListener('orientationchange', () => setTimeout(() => this.network.fit(), 250));

    // Status link awal dari device summary (adminUp kedua ujung = up).
    this.updateLinkStatuses(topo.devices || []);
    return topo;
  }

  /** Perbarui warna link dari daftar status {a, b, up} dari server. */
  applyNetState(netstate) {
    this.updateLinkStatuses(netstate.devices || [], netstate.links || []);
  }

  updateLinkStatuses(devices, links = null) {
    const devMap = new Map(devices.map((d) => [d.id, d]));
    const update = (linkId, up) => {
      this.edges.update({
        id: linkId,
        color: { color: up ? '#00ff9c' : '#f87171', highlight: up ? '#ffffff' : '#f87171' },
        dashes: !up,
      });
    };
    if (links && links.length) {
      for (const ls of links) {
        // format "deviceId:interface"
        const [aDev, aIf] = ls.a.split(':');
        const [bDev, bIf] = ls.b.split(':');
        const key = `${aDev}|${aIf}|${bDev}|${bIf}`;
        const id = this.edgeByLink.get(key);
        if (id !== undefined) update(id, ls.up);
      }
    }
  }

  highlight(deviceId) {
    // Tanpa focus(): layout fixed harus tetap terlihat utuh; cukup seleksi.
    if (!deviceId || !this.nodes?.get(deviceId)) return;
    this.network.selectNodes([deviceId], false);
  }

  /** Tipe perangkat (utk ikon di header konsol). */
  nodeType(deviceId) {
    return this.types.get(deviceId) || 'pc';
  }
}

function linkKey(l) {
  return `${l.a.device}|${l.a.interface}|${l.b.device}|${l.b.interface}`;
}

/** Tooltip polos multi-baris (vis-network merender string sbg teks). */
function buildTooltip(node, dev) {
  if (!dev) return node.label;
  const typeLabel = TYPE_LABEL[dev.type] || dev.type;
  const lines = [`${dev.hostname} (${typeLabel})`];
  for (const [name, i] of Object.entries(dev.interfaces)) {
    lines.push(`${name}: ${i.ip ?? '-'} ${i.adminUp ? '(up)' : '(shutdown)'}`);
  }
  return lines.join('\n');
}
