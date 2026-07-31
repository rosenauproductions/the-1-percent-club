import { connect, sendAction, setPlayerId } from '../shared/ws.js';
import { installErrorHandlers, mountQaWidget, showBoot, hideBoot } from '../shared/boot.js';
import {
  playSound,
  playSoundTimes,
  playTestTone,
  noteSoundCue,
  isAudioActivated,
  playEliminatingUntilStopped,
  stopPendingEliminating,
} from '../shared/audio.js';

installErrorHandlers('play');
mountQaWidget('play', { audioTools: true });
showBoot('Connecting to server…');

const STORAGE_KEY = 'club_player_v1';
const VOLUME_KEY = 'club_volume_ok_v1';
const main = document.getElementById('main');
const meta = document.getElementById('meta');

let state = null;
let playerId = null;
let playerName = '';
let joinError = '';
let tick = null;
let prevStatus = null;
let playedOutSound = false;
let lastPlaySoundAt = null;
/** Set only after they confirm they heard the test sound this visit. */
let volumeReady = false;
/** 'ask' = play sound · 'confirm' = did you hear it? */
let volumeGateStep = 'ask';

const params = new URLSearchParams(location.search);
const presetCode = (params.get('code') || '').toUpperCase();

function loadIdentity() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    playerId = data.playerId || null;
    playerName = data.name || '';
  } catch {
    // ignore
  }
}

function saveIdentity() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ playerId, name: playerName }),
  );
}

function money(n) {
  return `$${Number(n || 0).toLocaleString('en-US')}`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function me() {
  if (!playerId || !state) return null;
  return state.me || state.players?.find((p) => p.id === playerId) || null;
}

async function act(action, payload = {}) {
  try {
    const data = await sendAction(action, { ...payload, playerId });
    if (data?.playerId) {
      playerId = data.playerId;
      setPlayerId(playerId);
      saveIdentity();
      // reconnect with player id for filtered state
      connect('player', onState, { playerId });
    }
    joinError = '';
    return data;
  } catch (err) {
    joinError = err.message;
    render();
    throw err;
  }
}

function renderVolumeGate() {
  meta.textContent = 'Sound check';
  if (volumeGateStep === 'confirm') {
    main.innerHTML = `
      <div class="hero">
        <h1>THE <span class="pct">1%</span> CLUB</h1>
        <p class="volume-gate__copy">Can you hear that sound?</p>
      </div>
      <div class="card">
        <div class="stack">
          <button class="btn-primary big-btn" id="volumeHeardBtn" type="button">
            Yes — I heard it
          </button>
          <button class="btn-ghost big-btn" id="volumeReplayBtn" type="button">
            Play it again
          </button>
          <button class="btn-ghost big-btn" id="volumeNoBtn" type="button">
            No — turn up volume
          </button>
          <p class="muted volume-gate__hint">Set your phone volume to 100% and turn off silent/mute.</p>
          <p class="error" id="volumeGateError" style="display:none"></p>
        </div>
      </div>
    `;
    return;
  }

  main.innerHTML = `
    <div class="hero">
      <h1>THE <span class="pct">1%</span> CLUB</h1>
      <p class="volume-gate__copy">
        Can you hear this?
      </p>
      <p class="muted volume-gate__hint" style="margin-top:0.75rem">
        Turn your phone volume to <strong>100%</strong>, then tap play.
      </p>
    </div>
    <div class="card">
      <div class="stack">
        <button class="btn-primary big-btn" id="volumePlayBtn" type="button">
          Play sound
        </button>
        <p class="muted volume-gate__hint">You will confirm after it plays.</p>
        <p class="error" id="volumeGateError" style="display:none"></p>
      </div>
    </div>
  `;
}

function showVolumeGateError(message) {
  const errEl = document.getElementById('volumeGateError');
  if (!errEl) return;
  errEl.style.display = message ? 'block' : 'none';
  errEl.textContent = message || '';
}

async function playVolumeTest(button) {
  showVolumeGateError('');
  if (button) {
    button.disabled = true;
    button.textContent = 'Playing…';
  }
  try {
    const ok = await playTestTone();
    if (!ok && !isAudioActivated()) {
      throw new Error('Browser blocked sound — check silent/mute, then try again');
    }
    volumeGateStep = 'confirm';
    render();
  } catch (err) {
    if (button) {
      button.disabled = false;
      button.textContent = button.id === 'volumeReplayBtn' ? 'Play it again' : 'Play sound';
    }
    showVolumeGateError(err.message || 'Could not play sound');
  }
}

function renderJoin() {
  main.innerHTML = `
    <div class="hero">
      <h1>THE 1% CLUB</h1>
      <p>Enter your name to take a seat</p>
      <p class="muted volume-gate__reminder">Keep device volume at 100%</p>
    </div>
    <div class="card">
      <div class="stack">
        <label class="field">Your name
          <input id="nameInput" type="text" maxlength="18" placeholder="Alex" value="${escapeHtml(playerName)}" autocomplete="nickname" />
        </label>
        <p class="muted">Game code on TV: <strong>${escapeHtml(state?.joinCode || presetCode || '————')}</strong></p>
        ${joinError ? `<p class="error">${escapeHtml(joinError)}</p>` : ''}
        <button class="btn-primary big-btn" id="joinBtn" ${state?.lobbyOpen === false ? 'disabled' : ''}>
          ${state?.lobbyOpen === false ? 'Lobby closed' : 'Join game'}
        </button>
      </div>
    </div>
  `;
}

function renderWaiting() {
  const p = me();
  main.innerHTML = `
    <div class="hero">
      <div class="status-pill">SEATED</div>
      <h1 style="margin-top:1rem">${escapeHtml(p?.name || '')}</h1>
      <p>Waiting for the host to start…</p>
      <p class="muted" style="margin-top:0.75rem">${state.players?.length || 0} contestants · Stake ${money(1000)}</p>
    </div>
  `;
}

function renderOut() {
  const p = me();
  const isEliminated = p?.status === 'out';
  const label =
    p?.status === 'cashed'
      ? `Cashed out · ${money(p.winnings)}`
      : p?.status === 'took10k'
        ? `Took the money · ${money(p.winnings)}`
        : p?.status === 'winner'
          ? `Winner · ${money(p.winnings)}`
          : 'Eliminated';
  const pill =
    p?.status === 'winner' || p?.status === 'took10k' || p?.status === 'cashed' ? 'win' : 'out';

  document.body.classList.toggle('is-eliminated', isEliminated);

  main.innerHTML = `
    <div class="out-screen ${isEliminated ? 'out-screen--eliminated' : ''}">
      ${
        isEliminated
          ? `<div class="elim-spotlight" aria-hidden="true">
               <div class="elim-spotlight__beam"></div>
               <div class="elim-spotlight__glow"></div>
               <div class="elim-spotlight__pool"></div>
             </div>`
          : ''
      }
      <div class="hero out-screen__content">
        <div class="status-pill ${pill}">${escapeHtml(label)}</div>
        <h1 style="margin-top:1rem">${escapeHtml(p?.name || '')}</h1>
        <p class="muted">${
          isEliminated
            ? "The blue light is on you — you're out."
            : 'Watch the big screen'
        }</p>
        <p class="muted" style="margin-top:0.75rem">Jackpot ${money(state.jackpot)}</p>
      </div>
    </div>
  `;
}

let answerDraft = '';
let answeringViewKey = '';

function answeringKey() {
  const p = me();
  return `${state?.phase}:${state?.questionIndex}:${state?.myAnswer?.locked || state?.answers?.[playerId]?.locked || false}:${!!p?.hasPass}:${!!p?.usedPass}:${joinError}`;
}

function updateTimerOnly() {
  const el = document.getElementById('answerTimer');
  if (!el || !state?.timerEndsAt) return;
  const secs = Math.max(0, Math.ceil((state.timerEndsAt - Date.now()) / 1000));
  el.textContent = String(secs);
  el.classList.toggle('warn', secs <= 5);
}

function renderAnswering() {
  const q = state.currentQuestion;
  const ans = state.myAnswer || state.answers?.[playerId];
  const secs = state.timerEndsAt
    ? Math.max(0, Math.ceil((state.timerEndsAt - Date.now()) / 1000))
    : null;
  const p = me();
  const usedPass = !!p?.usedPass;
  const hasPass = !!p?.hasPass && !usedPass;
  const isOnePercent = state.questionIndex === 14;
  const canUsePass = hasPass && !isOnePercent && !ans?.locked;
  const showPassBtn = !usedPass && !ans?.locked;

  if (ans?.locked) {
    answerDraft = '';
    answeringViewKey = '';
    main.innerHTML = `
      <div class="pct">${q?.percent}%</div>
      <p class="prompt">${escapeHtml(q?.prompt || '')}</p>
      <div class="card" style="text-align:center">
        <h2>Locked in</h2>
        <p style="font-size:1.25rem;font-weight:800;margin:0">
          ${ans.usedPass ? 'PASS' : escapeHtml(ans.text || '')}
        </p>
        <p class="muted" style="margin-top:0.75rem">Hang tight for the reveal</p>
      </div>
    `;
    return;
  }

  if (state.phase === 'question') {
    answeringViewKey = '';
    const isOnePercent = q?.percent === 1 || state.questionIndex === 14;
    main.innerHTML = `
      <div class="pct">${q?.percent ?? '?'}%</div>
      <div class="hero" style="margin-top:1rem">
        <h1>${isOnePercent ? 'Finalist' : 'Host time'}</h1>
        <p class="muted">${
          isOnePercent
            ? "You're still in for the 1% question. Listen to the host — it starts when they hit Start."
            : 'Listen to the host. The question appears when they start the timer.'
        }</p>
      </div>
    `;
    return;
  }

  // Keep the input mounted — only refresh the countdown while typing
  const key = answeringKey();
  const existing = document.getElementById('answerInput');
  if (existing && answeringViewKey === key) {
    updateTimerOnly();
    const err = document.getElementById('answerError');
    if (err) {
      err.textContent = joinError || '';
      err.style.display = joinError ? 'block' : 'none';
    }
    return;
  }

  // Preserve whatever they already typed across rare full rebuilds
  if (existing) answerDraft = existing.value;
  answeringViewKey = key;

  main.innerHTML = `
    <div class="pct">${q?.percent}%</div>
    <p class="prompt">${escapeHtml(q?.prompt || '')}</p>
    <div class="timer ${secs !== null && secs <= 5 ? 'warn' : ''}" id="answerTimer">${secs ?? '—'}</div>
    <div class="card">
      <div class="stack">
        <label class="field">Your answer
          <input id="answerInput" type="text" inputmode="text" maxlength="80" placeholder="Type your answer" autocomplete="off" enterkeyhint="done" />
        </label>
        <p class="error" id="answerError" style="display:${joinError ? 'block' : 'none'}">${escapeHtml(joinError || '')}</p>
        <button class="btn-primary big-btn" id="lockBtn">Lock in</button>
        ${
          showPassBtn
            ? `<button class="btn-ghost big-btn ${canUsePass ? '' : 'pass-btn--locked'}" id="passBtn" type="button">
                Use PASS (−$1,000 to jackpot)
               </button>
               <p class="pass-hint" id="passHint">${
                 canUsePass
                   ? 'Saves you this round. Stake goes into the jackpot.'
                   : isOnePercent
                     ? "Can't use a pass on the 1% question."
                     : "Available starting at the 50% question."
               }</p>`
            : usedPass
              ? `<p class="pass-hint">Pass already used.</p>`
              : ''
        }
      </div>
    </div>
  `;
  const input = document.getElementById('answerInput');
  if (input) {
    input.value = answerDraft;
    input.addEventListener('input', () => {
      answerDraft = input.value;
    });
    // Focus once when the pad appears, not on every tick
    input.focus({ preventScroll: true });
  }
}

function renderCashout() {
  const eligible = me()?.hasPass && !me()?.usedPass && me()?.status === 'active';
  const decided = state.cashoutDecisions?.[playerId];
  main.innerHTML = `
    <div class="hero">
      <h1>Before 30%</h1>
      <p>Leave now with $1,000?</p>
    </div>
    <div class="card">
      ${
        !eligible
          ? `<p class="muted">You already used your pass — you must continue.</p>`
          : decided !== undefined
            ? `<p class="muted">You chose: <strong>${decided ? 'LEAVE with $1,000' : 'STAY'}</strong></p>`
            : `<div class="stack">
                <button class="btn-gold big-btn" id="leaveBtn">Leave with $1,000</button>
                <button class="btn-primary big-btn" id="stayBtn">Stay in the game</button>
              </div>`
      }
    </div>
  `;
}

function renderFinalChoice() {
  if (me()?.status !== 'active') {
    renderOut();
    return;
  }
  const decided = state.finalDecisions?.[playerId];
  main.innerHTML = `
    <div class="hero">
      <h1>$10k or 1%?</h1>
      <p>Jackpot is ${money(state.jackpot)}</p>
    </div>
    <div class="card">
      ${
        decided !== undefined
          ? `<p class="muted">You chose: <strong>${decided ? 'TAKE $10,000' : 'GO FOR 1%'}</strong></p>`
          : `<div class="stack">
              <button class="btn-gold big-btn" id="take10kBtn">Take share of $10,000</button>
              <button class="btn-primary big-btn" id="go1Btn">Attempt the 1% question</button>
            </div>`
      }
    </div>
  `;
}

function renderSolo() {
  if (me()?.status !== 'active') {
    renderOut();
    return;
  }
  main.innerHTML = `
    <div class="hero">
      <h1>You're the last one</h1>
      <p>Jackpot ${money(state.jackpot)}</p>
    </div>
    <div class="card stack">
      <button class="btn-gold big-btn" id="solo10k">Take $10,000</button>
      <button class="btn-primary big-btn" id="solo1">Go for 1%</button>
    </div>
  `;
}

function renderWatch() {
  const q = state.currentQuestion;
  main.innerHTML = `
    <div class="hero">
      <div class="status-pill">${escapeHtml(state.phase.replace('_', ' '))}</div>
      ${q ? `<div class="pct" style="margin-top:1rem">${q.percent}%</div>` : ''}
      <p class="muted" style="margin-top:1rem">Follow along on the TV</p>
      <p class="muted">Jackpot ${money(state.jackpot)}</p>
    </div>
  `;
}

function render() {
  // Must hear + confirm each visit (also unlocks iOS audio).
  if (!volumeReady || !isAudioActivated()) {
    renderVolumeGate();
    return;
  }

  const p = me();
  if (!p || (p.status !== 'out' && state?.phase !== 'eliminating')) {
    document.body.classList.remove('is-eliminated', 'elim-searching');
  }
  syncEliminationUi(p);

  meta.textContent = p
    ? `${p.name} · ${p.status}${p.hasPass && !p.usedPass ? ' · PASS' : ''}`
    : state?.phase === 'lobby'
      ? `Code ${state.joinCode}`
      : 'Not seated';

  if (!p) {
    if (state?.phase === 'lobby') renderJoin();
    else {
      main.innerHTML = `<div class="hero"><h1>Game in progress</h1><p class="muted">Wait for the next lobby</p></div>`;
    }
    return;
  }

  // Hold / lighting — stay until lit or safe; host starts Show eliminated
  if (state.phase === 'eliminating') {
    const elim = state.elimination || {};
    if (p.status === 'out' || elim.revealedIds?.includes(p.id)) {
      renderOut();
      return;
    }
    const pending = elim.stage === 'pending';
    const sting = elim.stage === 'sting' || elim.stage === 'clean_sting';
    main.innerHTML = `
      <div class="hero">
        <div class="status-pill">${
          pending ? 'TIME UP' : sting ? 'SEARCHING' : 'HOLDING'
        }</div>
        <h1 style="margin-top:1rem">${escapeHtml(p.name)}</h1>
        <p class="muted">${
          pending
            ? 'Watch the TV — host will show who is right and wrong'
            : sting
              ? 'Blue lights are scanning…'
              : elim.wrongIds?.includes(p.id)
                ? 'Waiting for the blue light…'
                : 'You survived this round — hang tight'
        }</p>
      </div>
    `;
    return;
  }

  if (['out', 'cashed', 'took10k', 'winner'].includes(p.status)) {
    renderOut();
    return;
  }

  if (p.status !== 'active') {
    renderOut();
    return;
  }

  switch (state.phase) {
    case 'lobby':
      renderWaiting();
      break;
    case 'intro':
      main.innerHTML = `<div class="hero"><h1>Here we go</h1><p class="muted">Watch the intro on the TV</p></div>`;
      break;
    case 'question':
    case 'answering':
      renderAnswering();
      break;
    case 'cashout_offer':
      renderCashout();
      break;
    case 'final_choice':
      renderFinalChoice();
      break;
    case 'solo_offer':
      renderSolo();
      break;
    case 'left_count':
      main.innerHTML = `
        <div class="hero">
          <div class="status-pill">STILL IN</div>
          <h1 style="margin-top:1rem">${state.players.filter((x) => x.status === 'active').length} left</h1>
          <p class="muted">Watch the TV</p>
        </div>`;
      break;
    case 'prize_pot':
      main.innerHTML = `
        <div class="hero">
          <div class="status-pill">PRIZE POT</div>
          <h1 style="margin-top:1rem">${money(state.jackpot)}</h1>
          <p class="muted">Watch the TV</p>
        </div>`;
      break;
    case 'reveal':
    case 'finale':
    case 'game_end':
      renderWatch();
      if (['finale', 'game_end'].includes(state.phase)) renderOut();
      break;
    default:
      renderWatch();
  }
}

main.addEventListener('click', async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;

  try {
    if (t.id === 'volumePlayBtn' || t.id === 'volumeReplayBtn') {
      await playVolumeTest(t);
      return;
    }
    if (t.id === 'volumeHeardBtn') {
      volumeReady = true;
      volumeGateStep = 'ask';
      try {
        sessionStorage.setItem(VOLUME_KEY, '1');
      } catch {
        // ignore
      }
      render();
      return;
    }
    if (t.id === 'volumeNoBtn') {
      volumeGateStep = 'ask';
      volumeReady = false;
      render();
      // After re-render, show tip on the ask screen
      queueMicrotask(() => {
        showVolumeGateError('Turn volume to 100%, turn off silent mode, then play again.');
      });
      return;
    }
    if (t.id === 'joinBtn') {
      const name = document.getElementById('nameInput')?.value?.trim() || '';
      playerName = name;
      await act('join', { name, playerId });
      return;
    }
    if (t.id === 'lockBtn') {
      const text = document.getElementById('answerInput')?.value || answerDraft || '';
      answerDraft = text;
      await act('submit_answer', { text });
      return;
    }
    if (t.id === 'passBtn') {
      const p = me();
      if (state.questionIndex === 14) {
        joinError = "Can't use a pass on the 1% question.";
        answeringViewKey = '';
        render();
        return;
      }
      if (!p?.hasPass || p?.usedPass) {
        joinError = "Can't use until the 50% question.";
        answeringViewKey = '';
        render();
        return;
      }
      joinError = '';
      await act('use_pass');
      return;
    }
    if (t.id === 'leaveBtn') {
      await act('cashout_decide', { leave: true });
      return;
    }
    if (t.id === 'stayBtn') {
      await act('cashout_decide', { leave: false });
      return;
    }
    if (t.id === 'take10kBtn') {
      await act('final_decide', { take10k: true });
      return;
    }
    if (t.id === 'go1Btn') {
      await act('final_decide', { take10k: false });
      return;
    }
    if (t.id === 'solo10k') {
      await act('solo_decide', { take10k: true });
      return;
    }
    if (t.id === 'solo1') {
      await act('solo_decide', { take10k: false });
      return;
    }
  } catch {
    // shown via joinError
  }
});

main.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target?.id === 'answerInput') {
    document.getElementById('lockBtn')?.click();
  }
  if (e.key === 'Enter' && e.target?.id === 'nameInput') {
    document.getElementById('joinBtn')?.click();
  }
});

let lastFlashCurrentId = null;

function syncEliminationUi(p) {
  const elim = state?.elimination;
  const searching =
    state?.phase === 'eliminating' &&
    (elim?.stage === 'sting' || elim?.stage === 'clean_sting') &&
    p?.status === 'active';
  const amLit = !!(
    p &&
    (p.status === 'out' || elim?.revealedIds?.includes(p.id) || elim?.currentId === p.id)
  );
  const flashMe =
    state?.phase === 'eliminating' &&
    elim?.stage === 'lighting' &&
    p &&
    elim.currentId === p.id;

  document.body.classList.toggle('elim-searching', !!searching);
  document.body.classList.toggle('is-eliminated', !!(amLit && p?.status === 'out'));

  // Quick blue flash when this phone is lit wrong
  if (flashMe && elim.currentId !== lastFlashCurrentId) {
    lastFlashCurrentId = elim.currentId;
    document.body.classList.remove('elim-flash');
    // reflow so animation restarts
    void document.body.offsetWidth;
    document.body.classList.add('elim-flash');
    window.setTimeout(() => {
      document.body.classList.remove('elim-flash');
    }, 500);
  }
  if (!flashMe && elim?.stage !== 'lighting') {
    lastFlashCurrentId = null;
  }
}

async function playOutSting() {
  playedOutSound = true;
  // Must already be unlocked from volume gate / QA — play() outside gesture fails on iOS otherwise
  await playSound('youre_out', { volume: 1 });
}

function handlePlayerSoundCue(cue) {
  if (!cue || cue.at === lastPlaySoundAt) return;
  lastPlaySoundAt = cue.at;
  noteSoundCue(cue);

  // Pending hold — eliminating in 1× or 3× bursts until host shows who is out
  if (cue.name === 'eliminating') {
    const vol = typeof cue.volume === 'number' ? cue.volume : 1;
    const times = cue.times || state?.elimination?.pendingLoops || 1;
    if (cue.loop) {
      playEliminatingUntilStopped({ times, volume: vol }).catch(() => {});
      return;
    }
    playSoundTimes('eliminating', times, { volume: vol }).catch(() => {});
    return;
  }

  // thump — phones carry it loud (gain ~300%); TV soft at 20%
  if (cue.name === 'thump') {
    stopPendingEliminating();
    const times = cue.times || 1;
    playSoundTimes('thump', times, { volume: 1, gain: 3 }).catch(() => {});
    return;
  }

  if (cue.audience === 'display') {
    return;
  }

  // After all wrongs shown — room eliminate sting (not per-player)
  if (cue.name === 'eliminate') {
    stopPendingEliminating();
    playSound('eliminate', { volume: 1 }).catch(() => {});
  }
}

function maybePlayOutSound(p) {
  if (!p) return;
  if (p.status === 'active') {
    playedOutSound = false;
    prevStatus = 'active';
    return;
  }
  if (p.status === 'out' && prevStatus !== 'out' && !playedOutSound) {
    playOutSting().catch(() => {});
  }
  prevStatus = p.status;
}

function onState(next) {
  const prevPhase = state?.phase;
  state = next;
  hideBoot();
  if (
    prevPhase === 'eliminating' &&
    (next.phase === 'left_count' || next.phase === 'prize_pot' || next.phase === 'reveal') &&
    !next.soundCue
  ) {
    stopPendingEliminating();
  }
  if (next.soundCue) noteSoundCue(next.soundCue);
  const p = me();
  syncEliminationUi(p);
  handlePlayerSoundCue(next.soundCue);
  maybePlayOutSound(p);
  render();
  if (tick) clearInterval(tick);
  if (state.phase === 'answering') tick = setInterval(updateTimerOnly, 200);
}

loadIdentity();
connect('player', onState, { playerId });

setTimeout(() => {
  if (!state) {
    showBoot(`Still connecting… Try <code>${location.origin}/</code>`, { error: true });
  }
}, 4000);
