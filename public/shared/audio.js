const DEFAULT_SOUNDS = {
  intro: 'intro.mp3',
  interlude: 'interlude.mp3',
  timer: 'timer.mp3',
  lock: 'lock.mp3',
  correct: 'correct.mp3',
  eliminating: 'eliminating.mp3',
  thump: 'thump.mp3',
  eliminate: 'eliminate.mp3',
  youre_out: 'youre-out.mp3',
  pass: 'pass.mp3',
  jackpot: 'jackpot.mp3',
  // Finale uses intro bed (win.mp3 unused)
  win: 'intro.mp3',
};

let soundFiles = { ...DEFAULT_SOUNDS };
let masterVolume = 0.7;
const musicTracks = new Set();
/** Active one-shot timer bed (for early-lock seek). */
let timerTrack = null;
/** When true, timer may play the last ~3s ending sting. */
let timerAllowEnding = false;
let timerBodyLoopCleanup = null;
/** Last ~3 seconds of timer.mp3 are an ending sting — loop the body until then. */
export const TIMER_STING_SEC = 3;
let audioActivated = false;
let pendingSfx = null;
const mutedPending = new Set();
let audioCtx = null;
let lastPlayResult = 'idle';
let lastCueSeen = null;
const listeners = new Set();

function notify() {
  for (const fn of listeners) {
    try {
      fn(getAudioDebug());
    } catch {
      // ignore
    }
  }
}

export function onAudioDebug(fn) {
  listeners.add(fn);
  fn(getAudioDebug());
  return () => listeners.delete(fn);
}

export function getAudioDebug() {
  return {
    activated: audioActivated,
    ctxState: audioCtx?.state || 'none',
    masterVolume,
    lastPlayResult,
    lastCueSeen,
  };
}

export function noteSoundCue(cue) {
  if (!cue) return;
  lastCueSeen = `${cue.name} @ ${cue.at}`;
  notify();
}

export function isAudioActivated() {
  return audioActivated;
}

export function isMusicPlaying() {
  return musicTracks.size > 0;
}

function unmuteElement(audio) {
  audio.muted = false;
  const vol = Number(audio.dataset.targetVolume);
  if (!Number.isNaN(vol)) {
    audio.volume = Math.max(0, Math.min(1, vol));
  }
}

function releaseMutedPending() {
  for (const audio of mutedPending) {
    unmuteElement(audio);
  }
  mutedPending.clear();
  for (const audio of musicTracks) {
    if (audio.muted) unmuteElement(audio);
  }
}

/**
 * Unlock mobile audio inside a user gesture.
 * iOS/Safari need a real play() (and usually AudioContext.resume) before later SFX work.
 */
export async function activateAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === 'suspended') await audioCtx.resume();
    }
  } catch (err) {
    lastPlayResult = `ctx fail: ${err?.message || err}`;
  }

  // Near-silent prime so later HTMLAudioElement.play() is allowed
  try {
    const src = soundSrc('lock');
    if (src) {
      const primer = new Audio(src);
      primer.volume = 0.01;
      await primer.play();
      primer.pause();
      primer.currentTime = 0;
    }
  } catch (err) {
    lastPlayResult = `unlock fail: ${err?.message || err}`;
    notify();
    return false;
  }

  audioActivated = true;
  releaseMutedPending();
  lastPlayResult = `unlocked (ctx ${audioCtx?.state || 'n/a'})`;
  notify();
  await replayPendingSfx();
  return true;
}

export function configureSounds(sounds) {
  soundFiles = { ...DEFAULT_SOUNDS, ...(sounds ?? {}) };
}

export function setMasterVolume(v) {
  masterVolume = v;
  notify();
}

function soundSrc(name) {
  const file = soundFiles[name] ?? DEFAULT_SOUNDS[name];
  if (!file) return null;
  const safe = file.replace(/^.*[/\\]/, '');
  return `/sounds/${safe}`;
}

export function stopAllMusic() {
  if (timerBodyLoopCleanup) {
    timerBodyLoopCleanup();
    timerBodyLoopCleanup = null;
  }
  timerAllowEnding = false;
  // Timer bed plays asMusic:false (tracked separately) — must pause, not only null.
  if (timerTrack) {
    timerTrack.pause();
    timerTrack.currentTime = 0;
    timerTrack = null;
  }
  for (const audio of musicTracks) {
    audio.pause();
    audio.currentTime = 0;
  }
  musicTracks.clear();
}

/**
 * Jump the playing timer bed to the last N seconds (everyone locked early,
 * or the answer window is truly winding down).
 * @param {number} [secondsFromEnd=3]
 */
export function seekTimerToEnd(secondsFromEnd = 3) {
  const audio = timerTrack;
  if (!audio) return false;
  timerAllowEnding = true;
  if (timerBodyLoopCleanup) {
    timerBodyLoopCleanup();
    timerBodyLoopCleanup = null;
  }
  const fromEnd = Math.max(0.5, Number(secondsFromEnd) || TIMER_STING_SEC);
  const apply = () => {
    const dur = audio.duration;
    if (!Number.isFinite(dur) || dur <= 0) return false;
    audio.currentTime = Math.max(0, dur - fromEnd);
    return true;
  };
  if (audio.readyState >= 1 && Number.isFinite(audio.duration)) {
    return apply();
  }
  audio.addEventListener('loadedmetadata', () => apply(), { once: true });
  return true;
}

/**
 * Loop everything except the last TIMER_STING_SEC until seekTimerToEnd()
 * (or the countdown naturally hits the ending window).
 */
function attachTimerBodyLoop(audio) {
  if (timerBodyLoopCleanup) {
    timerBodyLoopCleanup();
    timerBodyLoopCleanup = null;
  }
  timerAllowEnding = false;

  const onTimeUpdate = () => {
    if (timerAllowEnding || timerTrack !== audio) return;
    const dur = audio.duration;
    if (!Number.isFinite(dur) || dur <= TIMER_STING_SEC + 0.25) return;
    const bodyEnd = dur - TIMER_STING_SEC;
    if (audio.currentTime >= bodyEnd - 0.04) {
      try {
        audio.currentTime = 0.05;
      } catch {
        // ignore seek errors mid-buffer
      }
    }
  };

  audio.addEventListener('timeupdate', onTimeUpdate);
  timerBodyLoopCleanup = () => {
    audio.removeEventListener('timeupdate', onTimeUpdate);
  };
}

async function beginPlayback(audio, targetVolume, { name, loop }) {
  if (audioActivated) {
    try {
      await audio.play();
      return true;
    } catch (err) {
      lastPlayResult = `${name} blocked: ${err?.message || err}`;
      notify();
      return false;
    }
  }

  audio.muted = false;
  audio.volume = targetVolume;
  try {
    await audio.play();
    audioActivated = true;
    releaseMutedPending();
    return true;
  } catch {
    audio.muted = true;
    audio.volume = 0;
  }

  try {
    await audio.play();
  } catch (err) {
    pendingSfx = { name, loop, volume: targetVolume };
    lastPlayResult = `${name} pending: ${err?.message || err}`;
    notify();
    return false;
  }

  mutedPending.add(audio);
  return true;
}

/**
 * Optional Web Audio gain boost (e.g. gain: 3 ≈ 300% for quiet mobile SFX).
 * HTMLAudioElement.volume caps at 1; gain can go higher.
 */
function applyGainBoost(audio, gain) {
  const g = Number(gain);
  if (!Number.isFinite(g) || g <= 1) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    const source = audioCtx.createMediaElementSource(audio);
    const gainNode = audioCtx.createGain();
    gainNode.gain.value = Math.min(4, g);
    source.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    // Element volume stays at 1; GainNode provides the boost
    audio.volume = 1;
    audio.dataset.gainBoost = String(gainNode.gain.value);
  } catch {
    // Already wired or unsupported — keep element volume
  }
}

export async function playSound(
  name,
  { loop = false, volume = masterVolume, asMusic = loop, gain = 1 } = {},
) {
  const src = soundSrc(name);
  if (!src) {
    lastPlayResult = `${name}: missing file`;
    notify();
    return null;
  }

  const audio = new Audio(src);
  const targetVolume = Math.max(0, Math.min(1, volume));
  audio.dataset.targetVolume = String(targetVolume);
  audio.volume = targetVolume;
  audio.loop = loop;

  if (asMusic) stopAllMusic();
  applyGainBoost(audio, gain);

  const started = await beginPlayback(audio, audio.volume, { name, loop });
  if (!started) return null;

  if (asMusic) musicTracks.add(audio);

  if (name === 'timer' && !loop) {
    timerTrack = audio;
    attachTimerBodyLoop(audio);
    audio.addEventListener(
      'ended',
      () => {
        if (timerTrack === audio) timerTrack = null;
        if (timerBodyLoopCleanup) {
          timerBodyLoopCleanup();
          timerBodyLoopCleanup = null;
        }
      },
      { once: true },
    );
  }

  if (!loop) {
    audio.addEventListener('ended', () => {
      musicTracks.delete(audio);
      audio.remove();
    });
    pendingSfx = null;
  }

  const boost = audio.dataset.gainBoost ? ` ×${audio.dataset.gainBoost}` : '';
  lastPlayResult = `${name} ok @ ${Math.round(targetVolume * 100)}%${boost}`;
  notify();
  return audio;
}

export async function replayPendingSfx() {
  if (!pendingSfx) return null;
  const { name, loop, volume } = pendingSfx;
  pendingSfx = null;
  return playSound(name, { loop, volume });
}

/** Wait until a one-shot sound finishes (for chained eliminating.mp3 plays). */
export async function playSoundUntilEnded(name, options = {}) {
  const audio = await playSound(name, { ...options, loop: false, asMusic: false });
  if (!audio) return null;
  await new Promise((resolve) => {
    const done = () => resolve();
    audio.addEventListener('ended', done, { once: true });
    audio.addEventListener('error', done, { once: true });
    setTimeout(done, 8000);
  });
  return audio;
}

/** Play a sound N times back-to-back. */
export async function playSoundTimes(name, times, options = {}) {
  const n = Math.max(1, Math.min(8, Number(times) || 1));
  for (let i = 0; i < n; i++) {
    await playSoundUntilEnded(name, options);
  }
}

/** Audible confirmation for volume-gate / QA test (thump + eliminating). */
export async function playTestTone() {
  await activateAudio();
  if (!audioActivated) return false;
  await playSoundUntilEnded('thump', { volume: 1 });
  await playSoundUntilEnded('eliminating', { volume: 1 });
  return true;
}

/** Cancel token for pending eliminating bed (1× or 3× cycles until host shows). */
let pendingElimToken = 0;

export function stopPendingEliminating() {
  pendingElimToken += 1;
  stopAllMusic();
}

/**
 * Loop eliminating.mp3 in bursts of `times` (1 or 3) until stopPendingEliminating().
 */
export async function playEliminatingUntilStopped(options = {}) {
  const times = Math.max(1, Math.min(3, Number(options.times) || 1));
  const volume = options.volume ?? 0.55;
  const token = ++pendingElimToken;
  stopAllMusic();
  while (token === pendingElimToken) {
    await playSoundTimes('eliminating', times, { volume });
    if (token !== pendingElimToken) break;
  }
}
