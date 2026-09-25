'use strict';

// Speech-to-text worker. main.js runs this as an Electron utility process so a
// transcription never stalls the main process. Whisper runs locally through
// transformers.js: the model is downloaded once into the cache dir main passes
// in, and nothing you say leaves this computer.

const dns = require('dns');

// Some routers take ~15 s to answer IPv6 lookups, which trips fetch's 10 s
// connect timeout while downloading the model. Ask for IPv4 first and only fall
// back to a full lookup when a host has no IPv4 address.
const lookup = dns.lookup;
dns.lookup = function (host, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  else if (typeof opts === 'number') opts = { family: opts };
  opts = opts || {};
  if (opts.family) return lookup.call(dns, host, opts, cb);
  lookup.call(dns, host, { ...opts, family: 4 }, (err, addr, family) =>
    (err ? lookup.call(dns, host, opts, cb) : cb(null, addr, family)));
};

const post = (msg) => process.parentPort.postMessage(msg);

let asr = null; // Promise<pipeline> for asrModel
let asrModel = '';

function load(model, cacheDir) {
  if (asr && asrModel === model) return asr;
  asrModel = model;
  const files = new Map(); // file -> { loaded, total }, for one overall percentage
  let lastPost = 0;
  asr = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = cacheDir;
    return pipeline('automatic-speech-recognition', model, {
      dtype: 'q8',
      progress_callback: (p) => {
        if (p.status !== 'progress' || !p.total) return;
        files.set(p.file, p);
        const now = Date.now();
        if (now - lastPost < 250) return;
        lastPost = now;
        let loaded = 0;
        let total = 0;
        for (const f of files.values()) { loaded += f.loaded; total += f.total; }
        post({ type: 'progress', loaded, total });
      },
    });
  })();
  // A failed download shouldn't stick — let the next request try again.
  asr.catch(() => { asr = null; asrModel = ''; });
  return asr;
}

process.parentPort.on('message', async ({ data }) => {
  const { id, audio, model, language, cacheDir } = data || {};
  try {
    const transcribe = await load(model, cacheDir);
    const pcm = audio instanceof Float32Array ? audio : new Float32Array(audio || []);
    const out = await transcribe(pcm, {
      language: language || 'english',
      task: 'transcribe',
      chunk_length_s: 30, // longer takes are split into 30 s windows
      stride_length_s: 5,
    });
    post({ id, ok: true, text: String((out && out.text) || '').trim() });
  } catch (err) {
    post({ id, ok: false, error: String(err && err.message ? err.message : err) });
  }
});
