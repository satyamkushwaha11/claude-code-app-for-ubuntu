'use strict';

// Voice for the chat composer: record from the mic (main transcribes it with a
// local Whisper model — see stt-worker.js) and read replies aloud through the
// system speech engine (speech-dispatcher on Linux).

const SILENCE_MS = 1800; // hands-free: this long a pause after speech ends the take
const MAX_TAKE_MS = 120000;

/** Records one take from the mic. stop() hands back 16 kHz mono samples. */
class MicRecorder {
  /** onLevel(0..1) drives the button's meter; onSilence fires once a pause
   *  follows some speech, or when the take runs too long. */
  constructor({ onLevel, onSilence } = {}) {
    this.onLevel = onLevel;
    this.onSilence = onSilence;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream);
    this.rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.rec.start(250);

    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.ctx.createMediaStreamSource(this.stream).connect(this.analyser);
    this.startedAt = Date.now();
    this.lastVoice = this.startedAt;
    this.heardMs = 0; // time spent clearly above the room's noise floor
    this.peak = 0;
    this.noise = null;
    const buf = new Float32Array(this.analyser.fftSize);
    // A timer rather than requestAnimationFrame so hands-free stop still works
    // while the window is in the background.
    this.timer = setInterval(() => this._tick(buf), 50);
  }

  _tick(buf) {
    this.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    this.peak = Math.max(this.peak, rms);
    // Follow the noise floor down quickly and up slowly; speech sits well above it.
    this.noise = this.noise == null ? rms : rms < this.noise ? rms : this.noise + (rms - this.noise) * 0.01;
    const now = Date.now();
    if (rms > Math.max(0.012, this.noise * 3)) {
      this.heardMs += 50;
      this.lastVoice = now;
    }
    if (this.onLevel) this.onLevel(Math.min(1, rms * 8));
    const paused = this.heardMs >= 300 && now - this.lastVoice > SILENCE_MS;
    if ((paused || now - this.startedAt > MAX_TAKE_MS) && this.onSilence) {
      const cb = this.onSilence;
      this.onSilence = null; // once
      cb();
    }
  }

  _release() {
    clearInterval(this.timer);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx) this.ctx.close().catch(() => {});
  }

  /** Finish the take → Float32Array at 16 kHz (what Whisper expects), or null
   *  when the mic picked up nothing at all (muted or unplugged). */
  async stop() {
    const rec = this.rec;
    const stopped = new Promise((resolve) => { rec.onstop = resolve; });
    if (rec.state !== 'inactive') rec.stop();
    await stopped;
    this._release();
    if (this.peak < 0.003) return null;
    const blob = new Blob(this.chunks, { type: rec.mimeType || 'audio/webm' });
    const ac = new AudioContext({ sampleRate: 16000 });
    try {
      const decoded = await ac.decodeAudioData(await blob.arrayBuffer());
      return decoded.getChannelData(0);
    } finally {
      ac.close().catch(() => {});
    }
  }

  cancel() {
    try { if (this.rec && this.rec.state !== 'inactive') this.rec.stop(); } catch (_) { /* ignore */ }
    this._release();
  }
}

/** Whisper marks silence and noise with tags like "[BLANK_AUDIO]" — drop those. */
function cleanTranscript(text) {
  return String(text || '')
    .replace(/\[[^\]]*\]|\((?:silence|music|noise|inaudible)[^)]*\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Markdown → something worth hearing: no symbols, links read as their text. */
function speakable(line) {
  return String(line)
    .replace(/`([^`]{1,40})`/g, '$1') // short inline code reads fine…
    .replace(/`[^`]*`/g, ' ') // …long snippets don't
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*>\s?/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[*_~#<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Automatic voice: read each line in the language its script suggests. The
// system default can be anything (espeak-ng's is Afrikaans), so never rely on it.
const SCRIPT_LANGS = [
  [/[\u0900-\u097F]/, (l) => (l === 'marathi' ? 'mr' : 'hi')],
  [/[\u0980-\u09FF]/, () => 'bn'],
  [/[\u0A00-\u0A7F]/, () => 'pa'],
  [/[\u0A80-\u0AFF]/, () => 'gu'],
  [/[\u0B80-\u0BFF]/, () => 'ta'],
  [/[\u0C00-\u0C7F]/, () => 'te'],
  [/[\u0600-\u06FF]/, (l) => (l === 'urdu' ? 'ur' : 'ar')],
  [/[\u3040-\u30FF]/, () => 'ja'],
  [/[\u4E00-\u9FFF]/, (l) => (l === 'japanese' ? 'ja' : 'cmn')],
  [/[\u0400-\u04FF]/, () => 'ru'],
];
const LATIN_LANGS = { spanish: 'es', french: 'fr', german: 'de', portuguese: 'pt', italian: 'it' };

let voiceCache = null; // espeak-ng alone offers thousands of voices
if (typeof speechSynthesis !== 'undefined') {
  speechSynthesis.addEventListener('voiceschanged', () => { voiceCache = null; });
}
function allVoices() {
  if (typeof speechSynthesis === 'undefined') return [];
  if (!voiceCache || !voiceCache.length) voiceCache = speechSynthesis.getVoices();
  return voiceCache;
}

/** The chosen voice by name, else one for the text's language (base voices,
 *  not espeak's "+Variant" ones; US English for English). */
function pickVoice(name, text, speechLang) {
  const voices = allVoices();
  const chosen = name && voices.find((v) => v.name === name);
  if (chosen) return chosen;
  let code = LATIN_LANGS[speechLang] || 'en';
  for (const [re, pick] of SCRIPT_LANGS) {
    if (re.test(text || '')) { code = pick(speechLang); break; }
  }
  const lang = (v) => String(v.lang || '').toLowerCase();
  const base = voices.filter((v) => !v.name.includes('+'));
  return (code === 'en' && base.find((v) => lang(v) === 'en-us')) ||
    base.find((v) => lang(v) === code || lang(v).startsWith(code + '-')) ||
    voices.find((v) => lang(v).startsWith(code)) ||
    base.find((v) => lang(v).startsWith('en')) ||
    null;
}

/** Reads streamed reply text aloud a sentence at a time, skipping code blocks
 *  and tables. feed() takes text deltas; flush() at the end of a block. */
class Speaker {
  constructor({ onChange, prefs } = {}) {
    this.onChange = onChange;
    this.prefs = prefs || (() => ({}));
    this.buf = '';
    this.inFence = false;
    this.timer = null;
  }

  static get available() { return typeof speechSynthesis !== 'undefined'; }

  get speaking() { return Speaker.available && (speechSynthesis.speaking || speechSynthesis.pending); }

  feed(text) {
    this.buf += text;
    this._drain(false);
  }

  flush() { this._drain(true); }

  stop() {
    this.buf = '';
    this.inFence = false;
    if (Speaker.available) speechSynthesis.cancel();
    this._changed();
  }

  /** Speak a one-off line (e.g. the Settings "Test" button). */
  say(text) { this._say(text); }

  _drain(final) {
    let nl;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      this._line(this.buf.slice(0, nl));
      this.buf = this.buf.slice(nl + 1);
    }
    if (final) {
      if (this.buf) this._line(this.buf);
      this.buf = '';
      this.inFence = false;
      return;
    }
    // Start on finished sentences of the line still streaming in, rather than
    // waiting for the whole paragraph. ("1." and "e.g." aren't sentence ends.)
    if (this.inFence || /^\s*[`~|]/.test(this.buf)) return;
    let m;
    while ((m = this.buf.match(/^[\s\S]*?[^\s.!?]{2}[.!?]["')\]]?(?=\s)/))) {
      this._say(m[0]);
      this.buf = this.buf.slice(m[0].length);
    }
  }

  _line(line) {
    if (/^\s*(```|~~~)/.test(line)) { this.inFence = !this.inFence; return; }
    if (this.inFence || /^\s*\|/.test(line)) return; // code and tables are for reading
    this._say(line);
  }

  _say(text) {
    if (!Speaker.available) return;
    const clean = speakable(text);
    if (!clean || !/[\p{L}\p{N}]/u.test(clean)) return;
    const p = this.prefs();
    const u = new SpeechSynthesisUtterance(clean);
    const v = pickVoice(p.voice, clean, p.language);
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = Number(p.rate) || 1;
    speechSynthesis.speak(u);
    this._changed();
    // speechSynthesis has no reliable "queue drained" event — poll until quiet.
    if (!this.timer) {
      this.timer = setInterval(() => {
        if (this.speaking) return;
        clearInterval(this.timer);
        this.timer = null;
        this._changed();
      }, 400);
    }
  }

  _changed() {
    if (this.onChange) this.onChange(this.speaking);
  }
}

module.exports = { MicRecorder, Speaker, cleanTranscript, allVoices };
