/**
 * icons.js — ikon perangkat gaya Cisco Packet Tracer (SVG murni, tanpa aset luar).
 * Dipakai untuk: node vis-network (data URI), legend, dan header konsol.
 */

const GREY = { edge: '#5b6b77', topA: '#f4f8fa', topB: '#c5d1da', sideA: '#aebcc7', sideB: '#8494a1' };
const ARROW = '#1565c0';

function defs(id) {
  return `
  <defs>
    <linearGradient id="${id}t" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="${GREY.topA}"/><stop offset="1" stop-color="${GREY.topB}"/>
    </linearGradient>
    <linearGradient id="${id}s" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="${GREY.sideA}"/><stop offset="1" stop-color="${GREY.sideB}"/>
    </linearGradient>
    <linearGradient id="${id}c" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="#2f7fc4"/><stop offset="1" stop-color="#174f86"/>
    </linearGradient>
  </defs>`;
}

/** Router PT: "puck" abu-abu dengan 4 panah biru menyilang (atas-bawah-kiri-kanan). */
function routerSvg(selected) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="76" height="54" viewBox="0 0 96 68">
  ${defs('rt')}
  ${selected ? '<rect x="1.5" y="1.5" width="93" height="65" rx="16" fill="none" stroke="#00ff9c" stroke-width="3" opacity="0.95"/>' : ''}
  <path d="M8 27 v18 a40 16 0 0 0 80 0 v-18" fill="url(#rts)" stroke="${GREY.edge}" stroke-width="1.6"/>
  <ellipse cx="48" cy="27" rx="40" ry="16" fill="url(#rtt)" stroke="${GREY.edge}" stroke-width="1.6"/>
  <ellipse cx="48" cy="27" rx="34" ry="12.5" fill="none" stroke="${GREY.edge}" stroke-width="0.8" opacity="0.35"/>
  <g fill="${ARROW}">
    <rect x="25" y="25.4" width="46" height="3.2"/>
    <polygon points="17,27 27,21.8 27,32.2"/>
    <polygon points="79,27 69,21.8 69,32.2"/>
    <rect x="46.4" y="15" width="3.2" height="24"/>
    <polygon points="48,10 43,19.4 53,19.4"/>
    <polygon points="48,44 43,34.6 53,34.6"/>
  </g>
</svg>`;
}

/** Switch PT: kotak membulat dengan 4 panah (kiri → kanan, kanan → kiri). */
function switchSvg(selected) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="76" height="50" viewBox="0 0 96 62">
  ${defs('sw')}
  ${selected ? '<rect x="1.5" y="1.5" width="93" height="59" rx="16" fill="none" stroke="#00ff9c" stroke-width="3" opacity="0.95"/>' : ''}
  <path d="M8 20 v22 a10 10 0 0 0 10 10 h60 a10 10 0 0 0 10 -10 v-22" fill="url(#sws)" stroke="${GREY.edge}" stroke-width="1.6"/>
  <rect x="8" y="8" width="80" height="32" rx="10" fill="url(#swt)" stroke="${GREY.edge}" stroke-width="1.6"/>
  <g fill="${ARROW}">
    <rect x="26" y="15" width="15" height="3.2"/><polygon points="46,16.6 38,11.8 38,21.4"/>
    <rect x="26" y="27" width="15" height="3.2"/><polygon points="46,28.6 38,23.8 38,33.4"/>
    <rect x="55" y="15" width="15" height="3.2"/><polygon points="50,16.6 58,11.8 58,21.4"/>
    <rect x="55" y="27" width="15" height="3.2"/><polygon points="50,28.6 58,23.8 58,33.4"/>
  </g>
</svg>`;
}

/** PC PT: monitor layar biru + casing + keyboard. */
function pcSvg(selected) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="62" height="58" viewBox="0 0 80 74">
  ${defs('pc')}
  ${selected ? '<rect x="1.5" y="1.5" width="77" height="71" rx="12" fill="none" stroke="#00ff9c" stroke-width="3" opacity="0.95"/>' : ''}
  <rect x="4" y="6" width="54" height="40" rx="4" fill="url(#pct)" stroke="${GREY.edge}" stroke-width="1.8"/>
  <rect x="9" y="11" width="44" height="30" fill="url(#pcc)"/>
  <path d="M9 11 L20 11 L14 41 L9 41 Z" fill="#ffffff" opacity="0.12"/>
  <path d="M24 46 h16 l4 7 h-24 z" fill="url(#pcs)" stroke="${GREY.edge}" stroke-width="1.4"/>
  <rect x="13" y="53" width="38" height="5" rx="2" fill="url(#pcs)" stroke="${GREY.edge}" stroke-width="1.4"/>
  <rect x="60" y="6" width="16" height="52" rx="2.5" fill="url(#pct)" stroke="${GREY.edge}" stroke-width="1.8"/>
  <rect x="64" y="11" width="8" height="1.8" fill="${GREY.sideB}"/>
  <rect x="64" y="15" width="8" height="1.8" fill="${GREY.sideB}"/>
  <rect x="64" y="19" width="8" height="1.8" fill="${GREY.sideB}"/>
  <circle cx="68" cy="52" r="2" fill="#37c871"/>
  <rect x="4" y="61" width="52" height="9" rx="2.5" fill="url(#pct)" stroke="${GREY.edge}" stroke-width="1.4"/>
  <path d="M8 65.5 h44 M8 65.5 v2 M52 65.5 v2" stroke="${GREY.sideB}" stroke-width="1"/>
</svg>`;
}

const BUILDERS = { router: routerSvg, switch: switchSvg, pc: pcSvg };

/** SVG markup inline (untuk legend / header — unik per id gradien sudah suffixed). */
export function iconSvg(type, { selected = false } = {}) {
  return (BUILDERS[type] || pcSvg)(selected);
}

/** Data URI untuk dipakai sebagai gambar node vis-network / <img>. */
export function iconDataUri(type, { selected = false } = {}) {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(iconSvg(type, { selected }));
}

/** Nama tipe perangkat dalam bahasa Indonesia utk label. */
export const TYPE_LABEL = { router: 'Router', switch: 'Switch', pc: 'PC' };
