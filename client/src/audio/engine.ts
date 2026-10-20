import type { AudioChannel, SoundEffectType } from "../../../shared/protocol.ts";
import { AUDIO_CHANNELS } from "../../../shared/protocol.ts";
import { sliderToVolume } from "../../../shared/audio.ts";

/**
 * The browser's sound system. Every sound goes through its own gain (and optional filter) into one of
 * three channel gains — music, environment, interface — whose levels each player sets for themselves
 * (stored in this browser). Browsers only allow audio after the user interacts with the page, so the
 * context starts on the first click or key press; anything asked to play before that waits.
 */
export type AudioSettings = Record<AudioChannel, number> & { muted: boolean };

const KEY = "mesa.audio";
const DEFAULTS: AudioSettings = { music: 0.5, environment: 0.5, interface: 0.5, muted: false };

export function readAudioSettings(): AudioSettings {
  try {
    const v = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
    for (const c of AUDIO_CHANNELS) v[c] = Math.min(1, Math.max(0, Number(v[c]) || 0));
    v.muted = !!v.muted;
    return v;
  } catch {
    return { ...DEFAULTS };
  }
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  settings = readAudioSettings();
  #channels = new Map<AudioChannel, GainNode>();
  #waiting: (() => void)[] = [];
  #listeners = new Set<() => void>();
  /** server clock − local clock, in ms. */
  #clockOffset = 0;

  constructor() {
    const unlock = () => {
      this.#start();
      if (this.ctx?.state === "running") {
        window.removeEventListener("pointerdown", unlock, true);
        window.removeEventListener("keydown", unlock, true);
      }
    };
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("keydown", unlock, true);
  }

  get locked(): boolean {
    return this.ctx?.state !== "running";
  }

  /** Run now if audio is allowed, otherwise as soon as the user interacts with the page. */
  whenReady(fn: () => void): void {
    if (!this.locked) fn();
    else this.#waiting.push(fn);
  }

  /** Whether something is waiting for the first interaction (to hint the user). */
  get hasWaiting(): boolean {
    return this.locked && this.#waiting.length > 0;
  }

  #start(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      for (const c of AUDIO_CHANNELS) {
        const g = this.ctx.createGain();
        g.connect(this.ctx.destination);
        this.#channels.set(c, g);
      }
      this.#applyVolumes(0);
    }
    if (this.ctx.state !== "running") {
      this.ctx.resume().then(() => this.#flush());
    } else this.#flush();
  }

  #flush(): void {
    const fns = this.#waiting.splice(0);
    for (const fn of fns) fn();
  }

  channel(c: AudioChannel): GainNode {
    return this.#channels.get(c)!;
  }

  // -------------------------------------------------------------------------
  // Volumes

  onChange(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  setVolume(c: AudioChannel, slider: number): void {
    this.settings[c] = Math.min(1, Math.max(0, slider));
    this.#save();
  }

  setMuted(muted: boolean): void {
    this.settings.muted = muted;
    this.#save();
  }

  #save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.settings));
    } catch {
      // Private mode: applies to this visit only.
    }
    this.#applyVolumes(0.1);
    for (const fn of this.#listeners) fn();
  }

  #applyVolumes(seconds: number): void {
    if (!this.ctx) return;
    for (const c of AUDIO_CHANNELS) {
      const v = this.settings.muted ? 0 : sliderToVolume(this.settings[c]);
      const g = this.#channels.get(c)!.gain;
      g.cancelScheduledValues(this.ctx.currentTime);
      g.setTargetAtTime(v, this.ctx.currentTime, Math.max(0.001, seconds / 3));
    }
  }

  // -------------------------------------------------------------------------
  // Server clock

  setClockOffset(ms: number): void {
    this.#clockOffset = ms;
  }

  serverNow(): number {
    return Date.now() + this.#clockOffset;
  }

  // -------------------------------------------------------------------------
  // One-off sounds

  /** Fire-and-forget sound (dice, notifications, the GM's soundboard via `playAudio`). */
  playOnce(src: string, opts: { volume?: number; channel?: AudioChannel; loop?: boolean } = {}): void {
    this.whenReady(() => {
      const t = new Track(this, src, opts.channel ?? "interface");
      t.onEnded = () => t.dispose();
      t.play({ offset: 0, volume: opts.volume ?? 1, loop: !!opts.loop });
    });
  }
}

/**
 * One playing file: an <audio> element (streams and seeks without decoding everything up front)
 * routed through a gain, an optional effect, and a channel.
 */
export class Track {
  readonly src: string;
  readonly el: HTMLAudioElement;
  onEnded: (() => void) | null = null;
  #engine: AudioEngine;
  #source: MediaElementAudioSourceNode;
  #gain: GainNode;
  #effect: { type: SoundEffectType; intensity: number; nodes: AudioNode[]; output: AudioNode } | null = null;
  #channel: AudioChannel;
  #stopTimer: ReturnType<typeof setTimeout> | null = null;
  disposed = false;

  constructor(engine: AudioEngine, src: string, channel: AudioChannel) {
    const ctx = engine.ctx!;
    this.#engine = engine;
    this.src = src;
    this.#channel = channel;
    this.el = new Audio();
    this.el.preload = "auto";
    this.el.src = src;
    this.el.addEventListener("ended", () => this.onEnded?.());
    this.#source = ctx.createMediaElementSource(this.el);
    this.#gain = ctx.createGain();
    this.#gain.gain.value = 0;
    this.#source.connect(this.#gain);
    this.#route();
  }

  /** Seconds, once the file's metadata is known. */
  duration(): Promise<number> {
    if (Number.isFinite(this.el.duration)) return Promise.resolve(this.el.duration);
    return new Promise(resolve => {
      const done = () => resolve(Number.isFinite(this.el.duration) ? this.el.duration : NaN);
      this.el.addEventListener("loadedmetadata", done, { once: true });
      this.el.addEventListener("error", done, { once: true });
    });
  }

  get playing(): boolean {
    return !this.el.paused && !this.el.ended;
  }

  async play({ offset, volume, loop, fade = 0 }: { offset: number; volume: number; loop: boolean; fade?: number }): Promise<void> {
    if (this.#stopTimer) clearTimeout(this.#stopTimer);
    this.#stopTimer = null;
    this.el.loop = loop;
    if (offset > 0) {
      await this.duration();
      const d = this.el.duration;
      this.el.currentTime = Number.isFinite(d) && d > 0 ? (loop ? offset % d : Math.min(offset, d)) : offset;
    }
    this.fade(volume, fade, 0);
    try {
      await this.el.play();
    } catch {
      // Autoplay refused or the file is missing; nothing more to do.
    }
  }

  /** Ramp the track's own volume to `volume` over `ms`. */
  fade(volume: number, ms: number, from?: number): void {
    const ctx = this.#engine.ctx!;
    const g = this.#gain.gain;
    const now = ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(from ?? g.value, now);
    if (ms > 0) g.linearRampToValueAtTime(volume, now + ms / 1000);
    else g.setValueAtTime(volume, now);
  }

  /** Fade out, then stop and release the element. */
  stop(fadeMs = 0): void {
    if (this.disposed) return;
    this.onEnded = null;
    this.fade(0, fadeMs);
    if (this.#stopTimer) clearTimeout(this.#stopTimer);
    this.#stopTimer = setTimeout(() => this.dispose(), fadeMs + 20);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.el.pause();
    this.el.removeAttribute("src");
    this.el.load();
    this.#source.disconnect();
    this.#gain.disconnect();
    for (const n of this.#effect?.nodes ?? []) n.disconnect();
  }

  /** Put a filter between the track and its channel (null = none). Intensity 1–10. */
  setEffect(type: SoundEffectType | null, intensity = 5): void {
    if ((this.#effect?.type ?? null) === type && (this.#effect?.intensity ?? 5) === intensity) return;
    this.#gain.disconnect();
    for (const n of this.#effect?.nodes ?? []) n.disconnect();
    this.#effect = type ? makeEffect(this.#engine.ctx!, type, intensity) : null;
    this.#route();
  }

  #route(): void {
    const out = this.#engine.channel(this.#channel);
    if (!this.#effect) {
      this.#gain.connect(out);
      return;
    }
    this.#gain.connect(this.#effect.nodes[0]);
    this.#effect.output.connect(out);
  }
}

/** Build a filter graph: input = nodes[0], output = `output`. */
function makeEffect(ctx: AudioContext, type: SoundEffectType, intensity: number): { type: SoundEffectType; intensity: number; nodes: AudioNode[]; output: AudioNode } {
  const i = Math.min(10, Math.max(1, intensity));
  if (type === "lowpass" || type === "highpass") {
    const f = ctx.createBiquadFilter();
    f.type = type;
    // Stronger = lower cut-off for lowpass (more muffled), higher for highpass (thinner).
    f.frequency.value = type === "lowpass" ? 8000 / Math.pow(2, i / 2) : 50 * Math.pow(2, i * 0.7);
    return { type, intensity, nodes: [f], output: f };
  }
  // Reverb: dry signal plus a convolution with a decaying-noise impulse; longer tail when stronger.
  const input = ctx.createGain();
  const output = ctx.createGain();
  const conv = ctx.createConvolver();
  const wet = ctx.createGain();
  wet.gain.value = i / 10;
  const seconds = 0.4 + i * 0.3;
  const len = Math.floor(ctx.sampleRate * seconds);
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    for (let n = 0; n < len; n++) data[n] = (Math.random() * 2 - 1) * Math.pow(1 - n / len, 3);
  }
  conv.buffer = ir;
  input.connect(output);
  input.connect(conv);
  conv.connect(wet);
  wet.connect(output);
  return { type, intensity, nodes: [input, conv, wet, output], output };
}

export const audio = new AudioEngine();
