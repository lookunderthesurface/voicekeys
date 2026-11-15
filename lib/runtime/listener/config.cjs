// Every tunable in one place, with units and why it has that value.
//
// Blocks are 100 ms of 16 kHz mono audio throughout: the recognizer, the keyword spotter and
// all the timers below are expressed in blocks or seconds, never in samples.

const SR = 16000;                  // Hz, what both models expect
const BLOCK = 1600;                // 100 ms of audio per block
const BLOCK_SECONDS = BLOCK / SR;
const FRAME = 512;                 // recorder frame size; PvRecorder needs a small frame
const CHUNK_SAMPLES = 2560;        // what the KWS encoder accepts per decode

const HISTORY_SECONDS = 6.0;       // audio kept behind the detection point
const PRE_ROLL_SECONDS = 2.0;      // audio kept before the keyword (lag + first words)

const NOISE_FLOOR = 0.006;         // never treat quieter than this as speech
const PEAK_RATIO = 0.18;           // gate = max(NOISE_FLOOR, peak * PEAK_RATIO)
const MIN_SPEECH = 0.45;           // seconds of speech before an utterance has started

const PAUSE_CHECK = 1.0;           // silence before committing the transcript (show + send-word check)
const PAUSE_MIN_INTERVAL = 1.5;    // never run that check more often than this
const SEND_DELAY = 0.35;           // grace between hearing "over" and sending
const AUTO_SEND = 120.0;           // safety only: never send just because of a pause
const MAX_UTTER = 120.0;           // hard cap on one utterance
const NO_SPEECH_TIMEOUT = 8.0;     // woken but silent: drop back to idle (Alexa-like)

const PARTIAL_WINDOW = 15.0;       // decode at most this much recent audio
const PARTIAL_INTERVAL = 1.5;      // seconds between live transcript updates
const LISTEN_KEEPALIVE = 3.0;      // "still capturing" heartbeat for the card

const VERIFY_SECONDS = 1.6;        // audio re-read to confirm the wake word
const REJECT_COOLDOWN = 2.0;       // stay quiet this long after a rejected detection

const DEFAULT_SEND_WORDS = 'over,欧沃,欧文,完毕,发送,结束';
const SEND_ECHOES = ['哦', '喔', '噢', '欧', '嗷', 'oh', 'o'];

function num(name, fallback) {
  const raw = process.env[name];
  const value = Number(raw);
  return raw === undefined || raw === '' || Number.isNaN(value) ? fallback : value;
}

function blocksFor(seconds) {
  return Math.round(seconds / BLOCK_SECONDS);
}

class Settings {
  constructor({ kwsDir, keywordsFile, asrDir, wav = '', device = '', extraWords = [] }) {
    this.kwsDir = kwsDir;
    this.keywordsFile = keywordsFile;
    this.asrDir = asrDir;
    this.wav = wav;
    this.device = device;
    this.wakeWords = (process.env.WAKE_WORDS || '')
      .split(',')
      .map((word) => word.trim())
      .filter(Boolean)
      .concat(extraWords);
    this.kwsThreshold = num('KWS_THRESHOLD', 0.3);
      // 每个词可以有独立阈值：唤醒词要稳，结束词要灵（识别更容易）。
      this.keywordThresholds = (() => {
        const map = { default: this.kwsThreshold };
        for (const word of this.wakeWords) map[word] = this.kwsThreshold;
        for (const word of (process.env.VOICE_END_WORDS || '').split(',').map((w) => w.trim()).filter(Boolean)) {
          map[word] = num('KWS_THRESHOLD_END', 0.15);
        }
        for (const word of (process.env.VOICE_COMMAND_WORDS || '').split(',').map((w) => w.trim()).filter(Boolean)) {
          map[word] = num('KWS_THRESHOLD_COMMAND', 0.12);
        }
        return map;
      })();
    this.kwsScore = num('KWS_SCORE', 1.0);
    this.kwsThreads = num('KWS_THREADS', 1);
    this.asrThreads = num('ASR_THREADS', 4);
    this.asrLanguage = process.env.ASR_LANGUAGE || '';
    this.sendWords = (process.env.VOICE_SEND_WORDS || DEFAULT_SEND_WORDS)
      .split(',')
      .map((word) => word.trim().toLowerCase())
      .filter(Boolean);
    this.verify = process.env.VOICE_VERIFY_WAKE !== '0';
  }

  get tokensFile() {
    return `${this.kwsDir}/tokens.txt`;
  }
}

module.exports = {
  SR, BLOCK, BLOCK_SECONDS, FRAME, CHUNK_SAMPLES,
  HISTORY_SECONDS, PRE_ROLL_SECONDS,
  NOISE_FLOOR, PEAK_RATIO, MIN_SPEECH,
  PAUSE_CHECK, PAUSE_MIN_INTERVAL, SEND_DELAY, AUTO_SEND, MAX_UTTER, NO_SPEECH_TIMEOUT,
  PARTIAL_WINDOW, PARTIAL_INTERVAL, LISTEN_KEEPALIVE,
  VERIFY_SECONDS, REJECT_COOLDOWN,
  SEND_ECHOES,
  Settings, blocksFor,
};
