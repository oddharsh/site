// nav-sound.js — synthesized XP-flavored Web Audio chimes, loaded lazily on
// first playback once the visitor enables sounds in the taskbar tray.

var W = window as Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext };
var ctx: AudioContext | null = null;

function ac(): AudioContext | null {
  if (!ctx) {
    try {
      var AudioCtor = W.AudioContext || W.webkitAudioContext;
      if (!AudioCtor) return null;
      ctx = new AudioCtor();
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended" && ctx.resume) void ctx.resume();
  return ctx;
}

// One decaying partial: fast attack, exponential tail (a struck note, not a beep).
function partial(c: AudioContext, freq: number, t0: number, dur: number, peak: number, type: OscillatorType) {
  var o = c.createOscillator(),
    g = c.createGain();
  o.type = type || "sine";
  o.frequency.value = freq;
  o.connect(g);
  g.connect(c.destination);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak || 0.1, t0 + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

// Struck-bell timbre: fundamental + inharmonic overtones, the glassy chime
// character XP's notification sounds have (a flat sine beep does not).
function bell(c: AudioContext, base: number, t0: number, dur: number, peak: number) {
  partial(c, base, t0, dur, peak, "sine");
  partial(c, base * 2.01, t0, dur * 0.7, peak * 0.5, "sine");
  partial(c, base * 2.76, t0, dur * 0.5, peak * 0.3, "sine");
  partial(c, base * 5.18, t0, dur * 0.28, peak * 0.12, "triangle");
}

var voices: Record<string, (c: AudioContext, t: number) => void> = {
  // notification ding: a quick bright chime up a fourth
  open: (c, t) => {
    bell(c, 784, t, 0.45, 0.07);
    bell(c, 1047, t + 0.045, 0.6, 0.085);
  },
  // dismissal: a softer chime down
  close: (c, t) => {
    bell(c, 659, t, 0.4, 0.06);
    bell(c, 494, t + 0.05, 0.5, 0.05);
  },
  // critical-stop: a low dissonant pair with a little grit
  error: (c, t) => {
    partial(c, 196, t, 0.3, 0.075, "sine");
    partial(c, 207, t, 0.32, 0.05, "triangle");
    partial(c, 98, t, 0.34, 0.05, "sine");
  },
  // task-complete fanfare: a rising major arpeggio landing on a held octave
  tada: (c, t) => {
    [523, 659, 784].forEach((f, i) => {
      bell(c, f, t + i * 0.09, 0.32, 0.07);
    });
    bell(c, 1047, t + 0.27, 0.85, 0.09);
  },
};

export function play(name: string) {
  var c = ac();
  if (c && voices[name]) voices[name](c, c.currentTime);
}
