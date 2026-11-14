/**
 * quest.js — panel quest: render kartu NPC, objektif, XP.
 * Data terbaru datang dari event WS {type:'quests'} setiap kali state berubah.
 */

let latest = null;

export function renderQuests(data, { onUpdated } = {}) {
  latest = data;
  const listEl = document.getElementById('quest-list');
  const xpEl = document.getElementById('xp-badge');
  const btn = document.getElementById('btn-quest-toggle');

  xpEl.textContent = `XP ${data.xp}`;
  const doneCount = data.quests.filter((q) => q.completed).length;
  btn.textContent = `Quests (${doneCount}/${data.quests.length})`;
  const tabCount = document.getElementById('tab-quest-count');
  if (tabCount) tabCount.textContent = `${doneCount}/${data.quests.length}`;

  listEl.innerHTML = '';
  for (const q of data.quests) {
    const card = document.createElement('div');
    card.className = 'quest-card' + (q.completed ? ' completed' : '');

    const objectives = q.objectives
      .map(
        (o) => `<li class="${o.done ? 'done' : ''}">
          <span class="mark">${o.done ? '☑' : '☐'}</span><span>${escapeHtml(o.text)}</span></li>`
      )
      .join('');

    card.innerHTML = `
      <div class="quest-card-top">
        <span class="quest-title">${q.completed ? '✔ ' : ''}${escapeHtml(q.title)}</span>
        <span class="quest-xp">+${q.xp} XP</span>
      </div>
      <div class="quest-npc">🧑‍💼 ${escapeHtml(q.npc.name)} — ${escapeHtml(q.npc.role)}</div>
      <div class="quest-dialog">${escapeHtml(q.dialog)}</div>
      <ul class="quest-objectives">${objectives}</ul>
    `;
    listEl.appendChild(card);
  }
  onUpdated?.(data);
}

/** Saat quest baru selesai, buka panel & scroll ke kartunya.
 *  Panel dibuka lewat event agar app.js yang mengatur tab (mobile) / overlay (desktop). */
export function celebrateQuest(completedTitle) {
  window.dispatchEvent(new CustomEvent('netquest:open-quest'));
  const list = document.getElementById('quest-list');
  const firstCard = list.querySelector('.quest-card.completed');
  if (firstCard) firstCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
