import { ReminderSound } from './reminder-sound.js';
import { dueEvents, reminderKey } from '../calendar-model.js';
const el = (tag, text = '') => { const node = document.createElement(tag); node.textContent = text; return node; };
export class CalendarReminders {
  constructor({ api, parent, notice }) {
    Object.assign(this, { api, parent, notice }); this.delivered = new Set(); this.sound = new ReminderSound();
    this.interval = setInterval(() => this.check(), 15000);
    window.addEventListener('focus', () => this.check());
    window.addEventListener('pageshow', () => this.check());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.check(); });
    this.check();
  }
  permissionText() {
    if (!('Notification' in window)) return 'System notifications are unavailable; in-app alerts remain active.';
    return Notification.permission === 'granted' ? 'System notifications enabled.' : Notification.permission === 'denied' ? 'System notifications blocked; in-app alerts remain active.' : 'System notifications are optional.';
  }
  async enable() {
    if (!('Notification' in window)) { this.notice(this.permissionText()); return; }
    try { await Notification.requestPermission(); this.notice(this.permissionText()); } catch { this.notice('System notifications could not be enabled. In-app alerts remain active.'); }
  }
  async check() {
    if (this.checking) return; this.checking = true;
    try {
      const deliver = async () => {
        // Read inside the lock so deleted or rescheduled events cannot use a stale snapshot.
        const { document } = await this.api('/api/calendar');
        const receiptKey = `fieldnotes-calendar-reminders:${document.id}`;
        let receipts; try { receipts = JSON.parse(localStorage.getItem(receiptKey)) || {}; } catch { receipts = {}; }
        if (!receipts || typeof receipts !== 'object' || Array.isArray(receipts)) receipts = {};
        const active = new Set(document.events.map(reminderKey));
        for (const key of Object.keys(receipts)) if (!active.has(key)) delete receipts[key];
        for (const event of dueEvents(document.events)) {
          const key = reminderKey(event); if (receipts[key] || this.delivered.has(key)) continue;
          receipts[key] = true; this.delivered.add(key);
          try { localStorage.setItem(receiptKey, JSON.stringify(receipts)); } catch { /* In-memory receipts still prevent repeats in this tab. */ }
          this.show(event);
        }
        try { localStorage.setItem(receiptKey, JSON.stringify(receipts)); } catch { /* optional storage */ }
      };
      if (navigator.locks) await navigator.locks.request('fieldnotes:calendar-reminders', deliver);
      else if (!document.hidden) await deliver();
    } catch { /* Retry on the next tick; a transient read failure must not stop reminders. */ }
    finally { this.checking = false; }
  }
  show(event) {
    const row = el('article'); row.className = 'calendar-reminder'; row.setAttribute('role', 'alert');
    row.append(el('strong', event.title), el('span', `Starts ${new Date(event.start).toLocaleString()}${event.location ? ` · ${event.location}` : ''}`));
    const dismiss = el('button', 'Dismiss'); dismiss.type = 'button'; dismiss.setAttribute('aria-label', `Dismiss reminder for ${event.title}`); dismiss.onclick = () => row.remove(); row.append(dismiss); this.parent.append(row);
    const played = this.sound.play();
    if (this.sound.enabled && !played) {
      const play = el('button', 'Play alert sound'); play.type = 'button'; play.onclick = async () => { if (!await this.sound.test()) this.notice('Audio playback is unavailable or blocked. Check your browser and device sound settings.'); }; row.append(play);
    }
    if ('Notification' in window && Notification.permission === 'granted') try {
      const notification = new Notification(event.title, { body: row.querySelector('span').textContent, tag: reminderKey(event), silent: !this.sound.enabled || played }); notification.onclick = () => { window.focus(); notification.close(); }; setTimeout(() => notification.close(), 60000);
    } catch { /* The in-app alert remains visible. */ }
  }
}
