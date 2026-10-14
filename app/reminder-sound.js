const preferenceKey = 'workbench-calendar-sound';
export class ReminderSound {
  constructor() {
    this.enabled = this.readPreference();
    const unlock = event => { if (event.isTrusted && this.enabled) this.unlock(); };
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
    window.addEventListener('storage', event => { if (event.key === preferenceKey) this.enabled = this.readPreference(); });
  }
  readPreference() { try { return localStorage.getItem(preferenceKey) !== 'off'; } catch { return true; } }
  supported() { return !!(window.AudioContext || window.webkitAudioContext); }
  text() {
    if (!this.supported()) return 'Reminder sound is unavailable in this browser.';
    return this.enabled ? 'Reminder sound is on. Use Test reminder sound to check audio; interact with the app after opening it to allow playback.' : 'Reminder sound is muted.';
  }
  toggle() {
    this.enabled = !this.enabled;
    try { localStorage.setItem(preferenceKey, this.enabled ? 'on' : 'off'); } catch { /* Keep the preference for this tab. */ }
    if (this.enabled) this.unlock();
  }
  unlock() {
    if (!this.supported()) return Promise.resolve(false);
    try {
      if (!this.context || this.context.state === 'closed') this.context = new (window.AudioContext || window.webkitAudioContext)();
      return this.context.resume().then(() => this.context.state === 'running').catch(() => false);
    } catch { return Promise.resolve(false); }
  }
  play() {
    if (!this.enabled || this.context?.state !== 'running') return false;
    try {
      const context = this.context, start = context.currentTime;
      // A short two-note chime; envelopes avoid clicks and nodes release after playback.
      for (const [offset, frequency] of [[0, 660], [0.24, 880]]) {
        const oscillator = context.createOscillator(), gain = context.createGain(), time = start + offset;
        oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(frequency, time);
        gain.gain.setValueAtTime(0, time); gain.gain.linearRampToValueAtTime(0.16, time + 0.02); gain.gain.exponentialRampToValueAtTime(0.001, time + 0.36);
        oscillator.connect(gain); gain.connect(context.destination);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
        oscillator.start(time); oscillator.stop(time + 0.4);
      }
      return true;
    } catch { return false; }
  }
  async test() { return await this.unlock() && this.play(); }
}
