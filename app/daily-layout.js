// Keep document order and focused controls intact while packing measured cards.
export class DailyCardLayout {
  constructor(container) {
    this.container = container;
    this.cards = [...container.children];
    this.columns = new Map();
    this.onFocusOut = event => {
      const card = event.target.closest('.daily-group');
      if (card && !card.contains(event.relatedTarget)) this.schedule(true);
    };
    this.onClick = event => {
      if (event.target.closest('button, summary, input[type=checkbox]')) this.schedule(true);
    };
    container.addEventListener('focusout', this.onFocusOut);
    container.addEventListener('click', this.onClick);
    this.observer = new ResizeObserver(() => this.schedule());
    this.observer.observe(container);
    this.cards.forEach(card => this.observer.observe(card));
    this.layout(true);
  }
  schedule(rebalance = false) {
    this.rebalance ||= rebalance;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      const force = this.rebalance; this.rebalance = false;
      this.layout(force);
    });
  }
  layout(force = false) {
    const container = this.container;
    const width = container.getBoundingClientRect().width;
    if (!container.isConnected || !width) return;
    const style = getComputedStyle(container);
    const count = Number(style.getPropertyValue('--daily-columns')) || 2;
    const gap = parseFloat(style.columnGap) || 12;
    const resized = width !== this.width || count !== this.count;
    this.width = width; this.count = count;
    if (count === 1) {
      container.classList.remove('daily-groups-positioned'); container.style.height = '';
      for (const card of this.cards) for (const name of ['width', 'left', 'top']) card.style[name] = '';
      this.columns.clear(); return;
    }
    const active = document.activeElement;
    const typing = container.contains(active) && active.matches('input, textarea, [contenteditable=true]');
    const retainColumns = typing && !force && !resized && this.columns.size === this.cards.length;
    const cardWidth = (width - gap * (count - 1)) / count;
    container.classList.add('daily-groups-positioned');
    // Set widths first so wrapped content is measured at its final width.
    for (const card of this.cards) card.style.width = `${cardWidth}px`;
    const bottoms = Array(count).fill(0);
    for (const card of this.cards) {
      const column = retainColumns ? this.columns.get(card) : bottoms.indexOf(Math.min(...bottoms));
      this.columns.set(card, column);
      card.style.left = `${column * (cardWidth + gap)}px`;
      card.style.top = `${bottoms[column]}px`;
      bottoms[column] += card.getBoundingClientRect().height + gap;
    }
    container.style.height = `${Math.max(0, ...bottoms) - (this.cards.length ? gap : 0)}px`;
  }
  destroy() {
    this.observer.disconnect(); cancelAnimationFrame(this.frame);
    this.container.removeEventListener('focusout', this.onFocusOut);
    this.container.removeEventListener('click', this.onClick);
  }
}
