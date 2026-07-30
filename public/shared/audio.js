const DEFAULT_SOUNDS = {
  intro: 'intro.mp3',
  interlude: 'interlude.mp3',
  timer: 'timer.mp3',
  lock: 'lock.mp3',
  correct: 'correct.mp3',
  eliminating: 'eliminating.mp3',
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

/** Unmutes audio when a strict browser required muted autoplay first. */
export function activateAudio() {
  if (audioActivated) return;
  audioActivated = true;
  releaseMutedPending();
}

export function configureSounds(sounds) {
  soundFiles = { ...DEFAULT_SOUNDS, ...(sounds ?? {}) };
}

export function setMasterVolume(v) {
  masterVolume = v;
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
    } catch {
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
  } catch {
    pendingSfx = { name, loop, volume: targetVolume };
    return false;
  }

  mutedPending.add(audio);
  return true;
}

export async function playSound(name, { loop = false, volume = masterVolume } = {}) {
  const src = soundSrc(name);
  if (!src) return null;

  const audio = new Audio(src);
  const targetVolume = Math.max(0, Math.min(1, volume));
  audio.dataset.targetVolume = String(targetVolume);
  audio.volume = targetVolume;
  audio.loop = loop;

  if (loop) stopAllMusic();

  const started = await beginPlayback(audio, targetVolume, { name, loop });
  if (!started) return null;

  if (loop) musicTracks.add(audio);

  if (!loop) {
    audio.addEventListener('ended', () => audio.remove());
    pendingSfx = null;
  }

  return audio;
}

export async function replayPendingSfx() {
  if (!pendingSfx) return null;
  const { name, loop, volume } = pendingSfx;
  pendingSfx = null;
  return playSound(name, { loop, volume });
}
