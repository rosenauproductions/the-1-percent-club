import {
  connect,
  sendAction,
  sendActionWithRetry,
  setPlayerId,
  ensureConnected,
  sendPing,
  onWsOpen,
  onWsPong,
} from '../shared/ws.js?v=presence1';
import { installErrorHandlers, mountQaWidget, showBoot, hideBoot } from '../shared/boot.js';
import {
  playSoundTimes,
  playTestTone,
  noteSoundCue,
  isAudioActivated,
  stopPendingEliminating,
} from '../shared/audio.js';
import { scanSpotlightId } from '../shared/elimScan.js';
import { formatMoney, stakeFromState } from '../shared/money.js';

installErrorHandlers('play');
mountQaWidget('play', { audioTools: true });
showBoot('Connecting to server…');

const STORAGE_KEY = 'club_player_v1';
const VOLUME_KEY = 'club_volume_ok_v1';
const HEARTBEAT_MS = 18000;
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
let wakeLock = null;
let heartbeatTimer = null;
let connectedFlashTimer = null;
/** When true, next pong shows a brief “Connected” confirmation. */
let expectConnectedFlash = false;

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

function money(n, opts) {
  return formatMoney(n, state?.setup, opts);
}

function stake() {
  return stakeFromState(state);
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

async function act(action, payload = {}, { retry = false } = {}) {
  try {
    ensureConnected();
    const send = retry ? sendActionWithRetry : sendAction;
    const data = await send(action, { ...payload, playerId });
    if (data?.playerId) {
      playerId = data.playerId;
      setPlayerId(playerId);
      saveIdentity();
      // reconnect with player id for filtered state
      connect('player', onState, { playerId });
      syncHeartbeat();
    }
    joinError = '';
    return data;
  } catch (err) {
    joinError = err.message;
    render();
    throw err;
  }
}

/** Hold screen wake lock while seated in a live game (not pre-join lobby / game end). */
function shouldHoldWakeLock() {
  if (!playerId || !state) return false;
  const p = me();
  if (!p) return false;
  if (state.phase === 'game_end') return false;
  return true;
}

async function requestWakeLock() {
  try {
    if (!('wakeLock' in navigator)) return;
    if (document.visibilityState !== 'visible') return;
    if (wakeLock) return;
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {
    // unsupported / permission denied — fail soft
  }
}

function releaseWakeLock() {
  const lock = wakeLock;
  wakeLock = null;
  if (!lock) return;
  try {
    lock.release();
  } catch {
    // ignore
  }
}

function syncWakeLock() {
  if (shouldHoldWakeLock()) requestWakeLock();
  else releaseWakeLock();
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function syncHeartbeat() {
  if (!playerId) {
    stopHeartbeat();
    return;
  }
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    if (playerId) sendPing();
  }, HEARTBEAT_MS);
}

/** Ensure WS + immediate presence ping (resume / Still here). */
function beatNow({ flash = false } = {}) {
  if (flash) {
    expectConnectedFlash = true;
    setTimeout(() => {
      expectConnectedFlash = false;
    }, 5000);
  }
  ensureConnected();
  syncWakeLock();
}

function showConnectedFlash() {
  let el = document.getElementById('presenceFlash');
  if (!el) {
    el = document.createElement('div');
    el.id = 'presenceFlash';
    el.className = 'presence-flash';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = 'Connected';
  el.classList.add('is-visible');
  if (connectedFlashTimer) clearTimeout(connectedFlashTimer);
  connectedFlashTimer = setTimeout(() => {
    el.classList.remove('is-visible');
  }, 1600);
}

function renderPresenceControls() {
  const show = !!playerId && !!me();
  let bar = document.getElementById('presenceBar');
  if (!show) {
    bar?.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'presenceBar';
    bar.className = 'presence-bar';
    bar.innerHTML = `<button type="button" class="btn-ghost presence-bar__btn" id="stillHereBtn">Still here</button>`;
    document.body.appendChild(bar);
  }
}

function hapticPulse() {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(12);
    }
  } catch {
    // unsupported / blocked
  }
}

function syncChoiceSelection(selectedLetter) {
  const letter = String(selectedLetter || '').toUpperCase();
  document.querySelectorAll('.choice-btn[data-choice]').forEach((btn) => {
    const isSel = btn.dataset.choice === letter;
    btn.classList.toggle('is-selected', isSel);
    btn.setAttribute('aria-pressed', isSel ? 'true' : 'false');
  });
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
      <p class="muted" style="margin-top:0.75rem">${state.players?.length || 0} contestants · Stake ${money(stake())}</p>
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
let submitInFlight = null;

function answeringKey() {
  const p = me();
  const mode = state?.currentQuestion?.answerType || 'abc';
  const usedPass = !!(state?.myAnswer?.usedPass || state?.answers?.[playerId]?.usedPass);
  return `${state?.phase}:${state?.questionIndex}:${usedPass}:${!!p?.hasPass}:${!!p?.usedPass}:${joinError}:${mode}`;
}

function updateTimerOnly() {
  const el = document.getElementById('answerTimer');
  if (!el || !state?.timerEndsAt) return;
  const secs = Math.max(0, Math.ceil((state.timerEndsAt - Date.now()) / 1000));
  el.textContent = String(secs);
  el.classList.toggle('warn', secs <= 5);
}

function currentAnswerText() {
  const ans = state?.myAnswer || state?.answers?.[playerId];
  if (answerDraft) return answerDraft;
  if (ans?.usedPass) return '';
  return String(ans?.text || '');
}

function renderAnswering() {
  const q = state.currentQuestion;
  const ans = state.myAnswer || state.answers?.[playerId];
  const secs = state.timerEndsAt
    ? Math.max(0, Math.ceil((state.timerEndsAt - Date.now()) / 1000))
    : null;
  const p = me();
  const usedPass = !!p?.usedPass || !!ans?.usedPass;
  const hasPass = !!p?.hasPass && !usedPass;
  const isOnePercent = state.questionIndex === 14;
  const canUsePass = hasPass && !isOnePercent;
  const showPassBtn = !usedPass;

  // Pass is final — show confirmation once used
  if (ans?.usedPass || usedPass) {
    answerDraft = '';
    answeringViewKey = '';
    main.innerHTML = `
      <div class="pct">${q?.percent}%</div>
      <p class="prompt">${escapeHtml(q?.prompt || '')}</p>
      <div class="card" style="text-align:center">
        <h2>Pass used</h2>
        <p style="font-size:1.25rem;font-weight:800;margin:0">PASS</p>
        <p class="muted" style="margin-top:0.75rem">Hang tight for the reveal</p>
      </div>
    `;
    return;
  }

  if (state.phase === 'question') {
    answeringViewKey = '';
    const isOnePercentQ = q?.percent === 1 || state.questionIndex === 14;
    main.innerHTML = `
      <div class="pct">${q?.percent ?? '?'}%</div>
      <div class="hero" style="margin-top:1rem">
        <h1>${isOnePercentQ ? 'Finalist' : 'Host time'}</h1>
        <p class="muted">${
          isOnePercentQ
            ? "You're still in for the 1% question. Listen to the host — it starts when they hit Start."
            : 'Listen to the host. The question appears when they start the timer.'
        }</p>
      </div>
    `;
    return;
  }

  // Keep the pad mounted — only refresh the countdown / selection while choosing
  const key = answeringKey();
  const existingChoices = document.getElementById('choicePad');
  if (existingChoices && answeringViewKey === key) {
    updateTimerOnly();
    const selected = currentAnswerText().toUpperCase();
    if (selected) answerDraft = selected;
    syncChoiceSelection(selected);
    const err = document.getElementById('answerError');
    if (err) {
      err.textContent = joinError || '';
      err.style.display = joinError ? 'block' : 'none';
    }
    return;
  }

  answeringViewKey = key;

  // Prefer local draft, else server's last submitted answer
  if (!answerDraft && ans?.text && !ans?.usedPass) {
    answerDraft = String(ans.text).toUpperCase();
  }

  const answerType = q?.answerType || 'abc';
  const letterModes = { ab: ['A', 'B'], abc: ['A', 'B', 'C'], abcd: ['A', 'B', 'C', 'D'] };
  const choiceLetters = letterModes[answerType] || letterModes.abc;
  const choiceLabels = Array.isArray(q?.choices) ? q.choices : [];
  const selectedLetter = currentAnswerText().toUpperCase();

  const answerControls = `<div class="choice-pad" id="choicePad" role="group" aria-label="Answer choices">
        ${choiceLetters
          .map((letter, i) => {
            const selected = selectedLetter === letter ? ' is-selected' : '';
            const label = choiceLabels[i] ? String(choiceLabels[i]) : '';
            return `<button type="button" class="choice-btn${selected}${label ? ' choice-btn--labeled' : ''}" data-choice="${letter}" aria-pressed="${selectedLetter === letter ? 'true' : 'false'}">
              <span class="choice-btn__letter">${letter}</span>
              ${label ? `<span class="choice-btn__label">${escapeHtml(label)}</span>` : ''}
            </button>`;
          })
          .join('')}
      </div>
      <p class="muted choice-pad__hint">Choose your answer — you can change it until the timer runs out.</p>
      <p class="error" id="answerError" style="display:${joinError ? 'block' : 'none'}">${escapeHtml(joinError || '')}</p>`;

  main.innerHTML = `
    <div class="pct">${q?.percent}%</div>
    <p class="prompt">${escapeHtml(q?.prompt || '')}</p>
    <div class="timer ${secs !== null && secs <= 5 ? 'warn' : ''}" id="answerTimer">${secs ?? '—'}</div>
    <div class="card">
      <div class="stack">
        ${answerControls}
        ${
          showPassBtn
            ? `<button class="pass-btn ${canUsePass ? '' : 'pass-btn--locked'}" id="passBtn" type="button" aria-disabled="${canUsePass ? 'false' : 'true'}">
                <span class="pass-btn__eyebrow">SAFETY NET</span>
                <span class="pass-btn__title">USE PASS</span>
                <span class="pass-btn__sub">−${money(stake(), { short: true })} to jackpot · skip this question</span>
               </button>
               <p class="pass-hint" id="passHint">${
                 canUsePass
                   ? 'Saves you this round. Stake goes into the jackpot.'
                   : isOnePercent
                     ? "Can't use a pass on the 1% question."
                     : "Available starting at the 50% question."
               }</p>`
            : ''
        }
      </div>
    </div>
  `;
  // Letter pad only — no free-text focus
}

function renderPassBriefing() {
  const p = me();
  const hasPass = !!p?.hasPass && !p?.usedPass;
  main.innerHTML = `
    <div class="hero pass-granted">
      <div class="status-pill win">PASS UNLOCKED</div>
      <img
        class="pass-granted__art"
        src="/images/pass-available-example.png"
        alt="Example of the USE PASS button on your phone"
      />
      <h1>You have a PASS</h1>
      <p class="muted">${
        hasPass
          ? `One free escape on a later question. Using it puts ${money(stake())} in the jackpot.`
          : 'Listen to the host — passes are being explained.'
      }</p>
      <p class="muted" style="margin-top:0.75rem">Hang tight for the 50% question.</p>
    </div>
  `;
}

function renderCashout() {
  const eligible = me()?.hasPass && !me()?.usedPass && me()?.status === 'active';
  const decided = state.cashoutDecisions?.[playerId];
  main.innerHTML = `
    <div class="hero">
      <h1>Before 30%</h1>
      <p>Leave now with ${money(stake())}?</p>
    </div>
    <div class="card">
      ${
        !eligible
          ? `<p class="muted">You already used your pass — you must continue.</p>`
          : decided !== undefined
            ? `<p class="muted">You chose: <strong>${decided ? `LEAVE with ${money(stake())}` : 'STAY'}</strong></p>`
            : `<div class="stack">
                <button class="btn-gold big-btn" id="leaveBtn">Leave with ${money(stake())}</button>
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
  const awaiting = !!state._awaitingOnePercent;
  const offer = money(Math.floor((Number(state.jackpot) || 0) / 2));
  main.innerHTML = `
    <div class="hero">
      <h1>Half the pot or 1%?</h1>
      <p>Pot ${money(state.jackpot)} · offer ${offer}</p>
    </div>
    <div class="card">
      ${
        awaiting
          ? `<p class="muted">You’re in for the 1%. Wait for the host to start the question.</p>`
          : decided !== undefined
            ? `<p class="muted">You chose: <strong>${decided ? `TAKE ${offer}` : 'GO FOR 1%'}</strong></p>
               <p class="muted" style="margin-top:0.5rem">Waiting for the host…</p>`
            : `<div class="stack">
                <button class="btn-gold big-btn" id="take10kBtn">Take share of ${offer}</button>
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
  const decided = state.soloDecision;
  const offer = money(Math.floor((Number(state.jackpot) || 0) / 2));
  main.innerHTML = `
    <div class="hero">
      <h1>You're the last one</h1>
      <p>Pot ${money(state.jackpot)} · offer ${offer}</p>
    </div>
    <div class="card stack">
      ${
        decided === 'one_percent'
          ? `<p class="muted" style="text-align:center">You chose the 1%. Wait for the host to start.</p>`
          : decided === '10k'
            ? `<p class="muted" style="text-align:center">You took the offer.</p>`
            : `<button class="btn-gold big-btn" id="solo10k">Take ${offer}</button>
               <button class="btn-primary big-btn" id="solo1">Go for 1%</button>`
      }
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
    document.body.classList.remove(
      'is-eliminated',
      'elim-searching',
      'elim-scanning',
      'elim-scan-hit',
      'elim-scan-miss',
    );
  }
  syncEliminationUi(p);
  ensureScanTick();

  meta.textContent = p
    ? `${p.name} · ${p.status}${p.hasPass && !p.usedPass ? ' · PASS' : ''}`
    : state?.phase === 'lobby'
      ? `Code ${state.joinCode}`
      : 'Not seated';

  renderPresenceControls();

  if (!p) {
    releaseWakeLock();
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
    const scanning = elim.stage === 'scanning';
    const sting = elim.stage === 'sting';
    main.innerHTML = `
      <div class="hero">
        <div class="status-pill">${
          pending ? 'TIME UP' : scanning || sting ? 'SEARCHING' : 'HOLDING'
        }</div>
        <h1 style="margin-top:1rem">${escapeHtml(p.name)}</h1>
        <p class="muted">${
          pending
            ? 'Watch the TV — host will show wrong players'
            : scanning
              ? 'Blue lights are scanning…'
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
    case 'pass_briefing':
      renderPassBriefing();
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
    case 'eliminated_count':
      main.innerHTML = `
        <div class="hero">
          <div class="status-pill">OUT</div>
          <h1 style="margin-top:1rem">${state.reveal?.eliminated ?? 0} eliminated</h1>
          <p class="muted">Watch the TV</p>
        </div>`;
      break;
    case 'left_count':
      main.innerHTML = `
        <div class="hero">
          <div class="status-pill">STILL IN</div>
          <h1 style="margin-top:1rem">${state.players.filter((x) => x.status === 'active').length} remain</h1>
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

async function submitChoice(text) {
  const letter = String(text || '').toUpperCase();
  if (!letter || state?.phase !== 'answering') return;
  // Optimistic UI + cancel superseded in-flight submits of older letters
  answerDraft = letter;
  joinError = '';
  syncChoiceSelection(letter);
  hapticPulse();
  ensureConnected();

  const token = Symbol(letter);
  submitInFlight = token;
  try {
    await act('submit_answer', { text: letter }, { retry: true });
  } catch {
    // shown via joinError
  } finally {
    if (submitInFlight === token) submitInFlight = null;
  }
}

async function submitPass() {
  const p = me();
  if (state?.phase !== 'answering') return;
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
  hapticPulse();
  ensureConnected();
  const passEl = document.getElementById('passBtn');
  passEl?.classList.add('is-pressed');
  try {
    await act('use_pass', {}, { retry: true });
  } catch {
    // shown via joinError
  } finally {
    passEl?.classList.remove('is-pressed');
  }
}

/** Resolve actionable control from any nested tap target (letter spans, etc.). */
function actionTargetFromEvent(e) {
  const el = e.target;
  if (!(el instanceof Element)) return null;
  const choice = el.closest('[data-choice]');
  if (choice && main.contains(choice)) return { type: 'choice', el: choice, letter: choice.dataset.choice };
  const pass = el.closest('#passBtn');
  if (pass && main.contains(pass) && !pass.classList.contains('pass-btn--locked')) {
    return { type: 'pass', el: pass };
  }
  return null;
}

// Immediate pressed feedback on pointer/touch (before click fires)
main.addEventListener(
  'pointerdown',
  (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const action = actionTargetFromEvent(e);
    if (!action) return;
    if (action.type === 'choice') {
      action.el.classList.add('is-pressed');
      const letter = String(action.letter || '').toUpperCase();
      answerDraft = letter;
      syncChoiceSelection(letter);
    } else if (action.type === 'pass') {
      action.el.classList.add('is-pressed');
    }
  },
  { passive: true },
);

main.addEventListener(
  'pointerup',
  (e) => {
    document.querySelectorAll('.choice-btn.is-pressed, .pass-btn.is-pressed').forEach((btn) => {
      btn.classList.remove('is-pressed');
    });
  },
  { passive: true },
);

main.addEventListener(
  'pointercancel',
  () => {
    document.querySelectorAll('.choice-btn.is-pressed, .pass-btn.is-pressed').forEach((btn) => {
      btn.classList.remove('is-pressed');
    });
  },
  { passive: true },
);

main.addEventListener('click', async (e) => {
  const t = e.target;
  if (!(t instanceof Element)) return;

  // Answer / pass — resolve via closest so child spans register
  const answerAction = actionTargetFromEvent(e);
  if (answerAction?.type === 'choice') {
    e.preventDefault();
    await submitChoice(answerAction.letter);
    return;
  }
  if (answerAction?.type === 'pass') {
    e.preventDefault();
    await submitPass();
    return;
  }

  const btn = t.closest('button, [id]');
  const id = btn?.id || (t instanceof HTMLElement ? t.id : '');

  try {
    if (id === 'volumePlayBtn' || id === 'volumeReplayBtn') {
      await playVolumeTest(btn || t);
      return;
    }
    if (id === 'volumeHeardBtn') {
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
    if (id === 'volumeNoBtn') {
      volumeGateStep = 'ask';
      volumeReady = false;
      render();
      // After re-render, show tip on the ask screen
      queueMicrotask(() => {
        showVolumeGateError('Turn volume to 100%, turn off silent mode, then play again.');
      });
      return;
    }
    if (id === 'joinBtn') {
      const name = document.getElementById('nameInput')?.value?.trim() || '';
      playerName = name;
      await act('join', { name, playerId });
      return;
    }
    if (id === 'lockBtn') {
      // Legacy free-text lock — packs are multiple-choice only now
      const text = answerDraft || '';
      await act('submit_answer', { text }, { retry: true });
      return;
    }
    if (id === 'leaveBtn') {
      await act('cashout_decide', { leave: true });
      return;
    }
    if (id === 'stayBtn') {
      await act('cashout_decide', { leave: false });
      return;
    }
    if (id === 'take10kBtn') {
      await act('final_decide', { take10k: true });
      return;
    }
    if (id === 'go1Btn') {
      await act('final_decide', { take10k: false });
      return;
    }
    if (id === 'solo10k') {
      await act('solo_decide', { take10k: true });
      return;
    }
    if (id === 'solo1') {
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
let scanTick = null;

function ensureScanTick() {
  const scanning =
    state?.phase === 'eliminating' && state.elimination?.stage === 'scanning';
  if (scanning) {
    if (!scanTick) {
      scanTick = setInterval(() => {
        syncEliminationUi(me());
      }, 100);
    }
  } else if (scanTick) {
    clearInterval(scanTick);
    scanTick = null;
  }
}

function syncEliminationUi(p) {
  const elim = state?.elimination;
  // Everyone still in flashes during search — correct answers included (suspense)
  const scanning =
    state?.phase === 'eliminating' &&
    elim?.stage === 'scanning' &&
    !!p &&
    p.status !== 'out' &&
    !elim?.revealedIds?.includes(p.id);
  const spot = scanning ? scanSpotlightId(elim, state.players) : null;
  const onMe = !!(scanning && spot && spot === p.id);
  const searching =
    state?.phase === 'eliminating' &&
    elim?.stage === 'sting' &&
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

  document.body.classList.toggle('elim-scanning', !!scanning);
  document.body.classList.toggle('elim-scan-hit', !!onMe);
  document.body.classList.toggle('elim-scan-miss', !!(scanning && !onMe));
  document.body.classList.toggle('elim-searching', !!searching && !scanning);
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
  // /play stays silent on personal out — room sting is TV-only
  playedOutSound = true;
}

function handlePlayerSoundCue(cue) {
  if (!cue || cue.at === lastPlaySoundAt) return;
  lastPlaySoundAt = cue.at;
  noteSoundCue(cue);

  // Phones: only blue-light search (eliminating) + thump. Everything else is TV-only.
  if (cue.name === 'eliminating') {
    stopPendingEliminating();
    const times = cue.times || state?.elimination?.stingTimes || 1;
    const vol = typeof cue.volume === 'number' ? cue.volume : 1;
    playSoundTimes('eliminating', times, { volume: vol }).catch(() => {});
    return;
  }

  if (cue.name === 'thump') {
    stopPendingEliminating();
    const times = cue.times || 1;
    playSoundTimes('thump', times, { volume: 1 }).catch(() => {});
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
  const prevQ = state?.questionIndex;
  state = next;
  hideBoot();
  if (next.phase !== 'answering' || next.questionIndex !== prevQ) {
    answerDraft = '';
    answeringViewKey = '';
  }
  if (
    prevPhase === 'eliminating' &&
    (next.phase === 'eliminated_count' ||
      next.phase === 'left_count' ||
      next.phase === 'prize_pot' ||
      next.phase === 'reveal') &&
    !next.soundCue
  ) {
    stopPendingEliminating();
  }
  if (next.phase !== 'eliminating') {
    document.body.classList.remove('elim-scanning', 'elim-scan-hit', 'elim-scan-miss');
  }
  if (next.soundCue) noteSoundCue(next.soundCue);
  const p = me();
  syncEliminationUi(p);
  handlePlayerSoundCue(next.soundCue);
  maybePlayOutSound(p);
  syncWakeLock();
  syncHeartbeat();
  render();
  if (tick) clearInterval(tick);
  if (state.phase === 'answering') tick = setInterval(updateTimerOnly, 200);
}

loadIdentity();
connect('player', onState, { playerId });
syncHeartbeat();

onWsOpen(() => {
  if (playerId) sendPing();
});

onWsPong(() => {
  if (expectConnectedFlash) {
    expectConnectedFlash = false;
    showConnectedFlash();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    beatNow();
  }
});

window.addEventListener('online', () => {
  beatNow();
});

document.addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof Element)) return;
  if (t.id === 'stillHereBtn' || t.closest('#stillHereBtn')) {
    e.preventDefault();
    beatNow({ flash: true });
  }
});

setTimeout(() => {
  if (!state) {
    showBoot(`Still connecting… Try <code>${location.origin}/</code>`, { error: true });
  }
}, 4000);
