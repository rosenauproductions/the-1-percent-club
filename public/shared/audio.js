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
  win: 'win.mp3',
};

let soundFiles = { ...DEFAULT_SOUNDS };
let masterVolume = 0.7;
const musicTracks = new Set();
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
  for (const audio of musicTracks) {
    audio.pause();
    audio.currentTime = 0;
  }
  musicTracks.clear();
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

export async function playSound(
  name,
  { loop = false, volume = masterVolume, asMusic = loop } = {},
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

  const started = await beginPlayback(audio, targetVolume, { name, loop });
  if (!started) return null;

  if (asMusic) musicTracks.add(audio);

  if (!loop) {
    audio.addEventListener('ended', () => {
      musicTracks.delete(audio);
      audio.remove();
    });
    pendingSfx = null;
  }

  lastPlayResult = `${name} ok @ ${Math.round(targetVolume * 100)}%`;
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
