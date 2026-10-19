import './scheduling-conflicts.css';
const el = (tag, text = '', cls = '') => { const node = document.createElement(tag); node.textContent = text; if (cls) node.className = cls; return node; };
export const scheduleTime = (instant, timeZone) => new Date(instant).toLocaleTimeString('en-GB', { timeZone, hour: '2-digit', minute: '2-digit' });
export class SchedulingConflicts {
  constructor(studentName = () => 'Student') { this.studentName = studentName; this.reset(); }
  reset() { this.reviewed = null; this.token = null; if (this.checkbox) { this.checkbox.checked = false; this.checkbox.disabled = true; } }
  render(checked) {
    const token = checked.acknowledgement || null;
    if (token !== this.token) this.reviewed = null;
    this.token = token;
    const panel = el('section', '', 'scheduling-conflicts'); panel.setAttribute('aria-label', 'Scheduling conflicts');
    if (!checked.conflicts.length) { panel.append(el('p', 'No conflicts detected.', 'schedule-clear')); return panel; }
    panel.append(el('h4', `${checked.conflicts.length} scheduling conflict${checked.conflicts.length === 1 ? '' : 's'}`));
    const list = el('ul');
    for (const conflict of checked.conflicts) {
      const row = el('li', '', 'schedule-conflict');
      const source = conflict.type === 'event' ? 'Your Calendar' : `${conflict.participantName || this.studentName()} · Class`;
      const copy = el('div'); copy.append(el('span', source, 'schedule-conflict-source'), el('strong', conflict.title));
      const date = instant => new Date(instant).toLocaleDateString('en-GB', { timeZone: checked.timeZone, day: 'numeric', month: 'short', year: 'numeric' });
      const time = `${date(conflict.start)} · ${scheduleTime(conflict.start, checked.timeZone)}–${date(conflict.end) !== date(conflict.start) ? `${date(conflict.end)} · ` : ''}${scheduleTime(conflict.end, checked.timeZone)}`;
      row.append(copy, el('span', time, 'schedule-conflict-time')); list.append(row);
    }
    const label = el('label', '', 'schedule-conflict-ack'), checkbox = el('input'); checkbox.type = 'checkbox';
    checkbox.checked = !!token && this.reviewed === token; checkbox.disabled = !token;
    checkbox.onchange = () => { this.reviewed = checkbox.checked ? this.token : null; };
    this.checkbox = checkbox; label.append(checkbox, el('span', 'Save despite these conflicts')); panel.append(list, label); return panel;
  }
  accepted(checked) { return !checked.conflicts.length || (!!checked.acknowledgement && this.reviewed === checked.acknowledgement); }
}
export function participantAvailability(checked) {
  const list = el('div', '', 'schedule-participant-status'); list.setAttribute('aria-label', 'Participant timetable status');
  for (const participant of checked.participants || []) {
    const classCount = participant.conflicts.filter(c => c.type === 'class').length;
    list.append(el('p', `${participant.name}: ${participant.incomplete ? 'availability incomplete' : 'timetable checked'} · ${classCount ? `${classCount} class conflict${classCount === 1 ? '' : 's'}` : 'no class conflicts'}`));
  }
  return list;
}
