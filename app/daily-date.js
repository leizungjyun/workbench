import { localDate, validDate } from '../daily-model.js';
const el = (tag, text = '', cls = '') => Object.assign(document.createElement(tag), { textContent: text, className: cls });

// Picker navigation is local UI state; only choosing/clearing a date changes data.
export function dailyDateField({ label, value, disabled, change, icon }) {
  const wrap = el('div', '', 'daily-field daily-date-field');
  const caption = el('label', label), input = el('input'); input.type = 'date'; input.value = value; input.disabled = disabled;
  input.id = `daily-date-${crypto.randomUUID()}`; input.setAttribute('aria-label', label); caption.htmlFor = input.id;
  const controls = el('div', '', 'daily-date-controls'), toggle = el('button'); toggle.type = 'button'; toggle.disabled = disabled;
  toggle.title = `Choose ${label.toLowerCase()}`; toggle.setAttribute('aria-label', toggle.title); toggle.setAttribute('aria-expanded', 'false'); toggle.append(icon('calendar'));
  const picker = el('section', '', 'daily-date-picker'); picker.hidden = true; picker.setAttribute('aria-label', `${label} calendar`);
  picker.id = `${input.id}-calendar`; toggle.setAttribute('aria-controls', picker.id);
  const heading = el('div', '', 'daily-date-heading'), monthTitle = el('strong'); monthTitle.setAttribute('aria-live', 'polite');
  const button = (text, action, name = text) => { const b = el('button', text); b.type = 'button'; b.setAttribute('aria-label', name); b.onclick = action; return b; };
  const close = (focus = false) => { picker.hidden = true; toggle.setAttribute('aria-expanded', 'false'); if (focus) toggle.focus(); };
  let month;
  const choose = date => { input.value = date; change(date); close(true); };
  const move = amount => { month.setMonth(month.getMonth() + amount); render(); };
  heading.append(button('‹', () => move(-1), 'Previous month'), monthTitle, button('›', () => move(1), 'Next month'));
  const grid = el('div', '', 'daily-date-grid'), footer = el('div', '', 'daily-actions');
  footer.append(button('Today', () => choose(localDate())), button('Clear', () => choose('')), button('Close', () => close(true)));
  picker.append(heading, grid, footer);
  function render() {
    monthTitle.textContent = month.toLocaleDateString('en', { month: 'long', year: 'numeric' }); grid.replaceChildren();
    for (const day of ['M', 'T', 'W', 'T', 'F', 'S', 'S']) { const name = el('span', day, 'daily-date-weekday'); name.setAttribute('aria-hidden', 'true'); grid.append(name); }
    for (let i = 0; i < (month.getDay() + 6) % 7; i++) grid.append(el('span'));
    const end = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    for (let day = 1; day <= end; day++) {
      const date = localDate(new Date(month.getFullYear(), month.getMonth(), day, 12));
      const b = button(String(day), () => choose(date), date);
      b.setAttribute('aria-pressed', String(date === input.value));
      if (date === localDate()) b.setAttribute('aria-current', 'date'); grid.append(b);
    }
  }
  toggle.onclick = () => {
    if (!picker.hidden) return close();
    const date = validDate(input.value) ? input.value : localDate(); month = new Date(`${date.slice(0, 7)}-01T12:00:00`);
    render(); picker.hidden = false; toggle.setAttribute('aria-expanded', 'true');
  };
  input.oninput = () => { if (input.validity.valid && (!input.value || validDate(input.value))) change(input.value); };
  wrap.addEventListener('keydown', e => { if (e.key === 'Escape' && !picker.hidden) { e.preventDefault(); e.stopPropagation(); close(true); } });
  wrap.addEventListener('focusout', e => { if (!wrap.contains(e.relatedTarget)) close(); });
  controls.append(input, toggle); wrap.append(caption, controls, picker); return wrap;
}
