// Pointer-based drag-and-drop + tap handling for cards. Works with mouse, pen and touch
// (HTML5 drag-and-drop does not fire on touch screens, so we use Pointer Events).

const DRAG_THRESHOLD = 6; // px before a press becomes a drag

/**
 * @param {HTMLElement} root  container holding draggable `.card[data-card]` and drop zones `[data-zone]`
 * @param {object} h handlers:
 *   enabled(): boolean
 *   dragSet(card): string[]            cards to move when `card` is dragged
 *   onTapCard(card)
 *   onTapZone(zone)
 *   onDrop(cards, zone, targetCard|null)
 *   canDrop(cards, zone): boolean       for highlighting
 */
export function attachDnD(root, h) {
  let press = null; // { id, card, x, y, el, dragging, ghost, cards, overZone }

  const zoneAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (!el || !root.contains(el)) return { zone: null, card: null };
    const z = el.closest('[data-zone]');
    const c = el.closest('.card[data-card]');
    return { zone: z ? z.dataset.zone : null, card: c ? c.dataset.card : null, zoneEl: z };
  };

  function clearHover() {
    root.querySelectorAll('.drop-hover').forEach((e) => e.classList.remove('drop-hover'));
  }

  function startDrag() {
    press.dragging = true;
    press.cards = h.dragSet(press.card);
    const ghost = document.createElement('div');
    ghost.className = 'ghost';
    for (const c of press.cards) {
      const src = root.querySelector(`.card[data-card="${c}"]`);
      if (!src) continue;
      src.classList.add('dragging-src');
      const clone = src.cloneNode(true);
      clone.classList.remove('selected', 'dragging-src', 'deal-in');
      ghost.appendChild(clone);
    }
    document.body.appendChild(ghost);
    press.ghost = ghost;
    document.body.style.cursor = 'grabbing';
  }

  function moveGhost(x, y) {
    if (press.ghost) press.ghost.style.transform = `translate(${x}px, ${y}px) translate(-50%, -60%)`;
    const { zone, zoneEl } = zoneAt(x, y);
    clearHover();
    if (zone && zoneEl && h.canDrop(press.cards, zone)) zoneEl.classList.add('drop-hover');
  }

  function end(e, cancelled) {
    if (!press) return;
    const p = press;
    press = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    clearHover();
    document.body.style.cursor = '';
    root.querySelectorAll('.dragging-src').forEach((el) => el.classList.remove('dragging-src'));
    if (p.ghost) p.ghost.remove();
    if (cancelled) return;
    if (p.dragging) {
      const { zone, card } = zoneAt(e.clientX, e.clientY);
      if (zone) h.onDrop(p.cards, zone, card && !p.cards.includes(card) ? card : null);
    } else {
      h.onTapCard(p.card);
    }
  }

  function onMove(e) {
    if (!press || e.pointerId !== press.id) return;
    const dx = e.clientX - press.x;
    const dy = e.clientY - press.y;
    if (!press.dragging && Math.hypot(dx, dy) > DRAG_THRESHOLD) startDrag();
    if (press.dragging) {
      e.preventDefault();
      moveGhost(e.clientX, e.clientY);
    }
  }
  function onUp(e) { if (press && e.pointerId === press.id) end(e, false); }
  function onCancel(e) { if (press && e.pointerId === press.id) end(e, true); }

  root.addEventListener('pointerdown', (e) => {
    if (press || !h.enabled()) return;
    if (e.button !== undefined && e.button > 0) return;
    const el = e.target.closest('.card[data-card]');
    if (!el || !root.contains(el)) return;
    e.preventDefault();
    press = { id: e.pointerId, card: el.dataset.card, x: e.clientX, y: e.clientY, el, dragging: false };
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  });

  // Taps on zone backgrounds (not on cards).
  root.addEventListener('click', (e) => {
    if (!h.enabled()) return;
    if (e.target.closest('.card[data-card]')) return;
    const z = e.target.closest('[data-zone]');
    if (z && root.contains(z)) h.onTapZone(z.dataset.zone);
  });

  // Keyboard: Enter/Space on a focused card toggles it, on a zone places the selection.
  root.addEventListener('keydown', (e) => {
    if (!h.enabled() || (e.key !== 'Enter' && e.key !== ' ')) return;
    const c = e.target.closest('.card[data-card]');
    const z = e.target.closest('[data-zone]');
    if (c) { e.preventDefault(); h.onTapCard(c.dataset.card); } else if (z) { e.preventDefault(); h.onTapZone(z.dataset.zone); }
  });

  // Prevent the long-press context menu on touch devices while handling cards.
  root.addEventListener('contextmenu', (e) => { if (e.target.closest('.card')) e.preventDefault(); });
}
