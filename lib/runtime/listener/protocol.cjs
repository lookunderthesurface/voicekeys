// Protocol: the only lines the daemon reacts to.
//
// Diagnostics must never reuse an event prefix. A stray "[wake] ..." line was once parsed as
// a detection and left the UI showing "listening" forever.
const KW = 'kw';             // [kw] <wake word>       detected and verified
const PARTIAL = 'partial';   // [partial] <text>       live transcript
const LISTEN = 'listen';     // [listen] <seconds>     keepalive: still capturing
const UTTER = 'utter';       // [utter] <text>         utterance finished, send it
const CANCEL = 'cancel';     // [cancel] <reason>      woke up but nothing was said
const FALSE = 'false';       // [false] <heard>        spotter fired, verifier rejected
const SLACK = 'slack';       // [slack] <heard>        accepted with one edited syllable
const MODEL = 'model';       // [model] {json}         which model files were loaded
const INFO = 'info';         // [info] <text>
const DIAG = 'diag';         // [diag] <json>
const HEAR = 'hear';         // [hear] <text|(empty)>

function emit(kind, value = '') {
  process.stdout.write(`[${kind}] ${value}\n`);
}

function emitJson(kind, payload) {
  emit(kind, JSON.stringify(payload));
}

function diag(payload) {
  emitJson(DIAG, payload);
}

function fail(message) {
  process.stderr.write(`[fatal] ${message}\n`);
  process.exit(1);
}

module.exports = {
  KW, PARTIAL, LISTEN, UTTER, CANCEL, FALSE, SLACK, MODEL, INFO, DIAG, HEAR,
  emit, emitJson, diag, fail,
};
