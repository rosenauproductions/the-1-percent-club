import { connect, sendAction } from '../shared/ws.js';
import {
  activateAudio,
  playSound,
  playSoundTimes,
  setMasterVolume,
  configureSounds,
  isAudioActivated,
  stopAllMusic,
  playEliminatingUntilStopped,
  stopPendingEliminating,
  seekTimerToEnd,
  TIMER_STING_SEC,
} from '../shared/audio.js';
import { installErrorHandlers, mountQaWidget, showBoot, hideBoot } from '../shared/boot.js';
import { scanSpotlightId } from '../shared/elimScan.js';
import { formatMoney, normalizeCurrency } from '../shared/money.js';

installErrorHandlers('display');
mountQaWidget('display');
showBoot('Connecting to server…');

const main = document.getElementById('main');
const jackpotEl = document.getElementById('jackpot');
const aliveEl = document.getElementById('aliveCount');
const tapHint = document.getElementById('tapHint');

let state = null;
let lastSoundAt = null;
let timerInterval = null;
let scanTick = null;
/** Seek into timer ending sting once per answer window. */
let timerEndSeeked = false;

function currency() {
  return normalizeCurrency(state?.setup?.currency);
}

function money(n, opts) {
  return formatMoney(n, currency(), opts);
}

function syncScanSeats() {
  if (!state?.players?.length) return;
  const elim = state.elimination;
  if (state.phase !== 'eliminating' || elim?.stage !== 'scanning') return;
  for (const p of state.players) {
    const el = main.querySelector(`.seat[data-player-id="${CSS.escape(p.id)}"]`);
    if (!el) continue;
    el.className = `seat ${seatClass(p)}`;
  }
}

function ensureScanTick() {
  const scanning =
    state?.phase === 'eliminating' && state.elimination?.stage === 'scanning';
  if (scanning) {
    if (!scanTick) {
      scanTick = setInterval(() => {
        syncScanSeats();
      }, 100);
    }
  } else if (scanTick) {
    clearInterval(scanTick);
    scanTick = null;
  }
}

function seatClass(p) {
  if (!p) return 'empty';
  if (p.status === 'winner') return 'winner';
  if (p.status === 'cashed' || p.status === 'took10k') return p.status;
  const elim = state?.elimination;
  // Just lit — bright blue flash, then settles to out
  if (elim?.stage === 'lighting' && elim.currentId === p.id) {
    return 'flash-out';
  }
  if (p.status === 'out' || elim?.revealedIds?.includes(p.id)) return 'out';
  // Blue-light search hops seat-to-seat during eliminating.mp3
  if (elim?.stage === 'scanning' && p.status === 'active') {
    const spot = scanSpotlightId(elim, state.players);
    return spot === p.id ? 'searching searching--hit' : 'searching searching--miss';
  }
  // Only the next target pulses during thump sting (one-at-a-time)
  if (
    elim?.stage === 'sting' &&
    p.status === 'active' &&
    elim.stingTargetId === p.id
  ) {
    return 'searching searching--hit';
  }
  if (p.usedPass) return 'pass';
  return 'active';
}

function renderSeatGrid(players, { fillTo = 0 } = {}) {
  const count = Math.max(players.length, fillTo);
  const cols =
    count > 60 ? 12 : count > 40 ? 10 : count > 20 ? 8 : Math.max(5, Math.ceil(Math.sqrt(Math.max(count, 1))));
  const seats = [];
  for (let i = 0; i < count; i++) {
    const p = players[i];
    seats.push(
      `<div class="seat ${seatClass(p)}" data-player-id="${p ? escapeHtml(p.id) : ''}" title="${p ? escapeHtml(p.name) : ''}">${p ? escapeHtml(p.name) : ''}</div>`,
    );
  }
  return `<div class="seat-grid" style="grid-template-columns: repeat(${cols}, 1fr)">${seats.join('')}</div>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let lanOrigin = null;

async function resolveLanOrigin() {
  if (lanOrigin) return lanOrigin;
  const host = location.hostname;
  if (host && host !== 'localhost' && host !== '127.0.0.1') {
    lanOrigin = location.origin;
    return lanOrigin;
  }
  try {
    const info = await fetch('/api/info').then((r) => r.json());
    lanOrigin = info.primary || location.origin;
  } catch {
    lanOrigin = location.origin;
  }
  return lanOrigin;
}

function playUrl() {
  return `${lanOrigin || location.origin}/play/`;
}

function qrSrc(code) {
  const url = `${playUrl()}?code=${encodeURIComponent(code)}`;
  return `/api/qr?size=320&data=${encodeURIComponent(url)}`;
}

function secondsLeft() {
  if (!state?.timerEndsAt) return null;
  return Math.max(0, Math.ceil((state.timerEndsAt - Date.now()) / 1000));
}

function startTimerTick() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (state?.phase !== 'answering') return;
    const secs = secondsLeft();
    // Play the timer ending sting only when the countdown is truly winding down
    if (
      secs !== null &&
      secs > 0 &&
      secs <= TIMER_STING_SEC &&
      !timerEndSeeked
    ) {
      timerEndSeeked = true;
      seekTimerToEnd(Math.max(0.5, secs));
    }
    if (!updateDisplayAnsweringLive() && !(secs != null && secs <= 0)) render();
  }, 200);
}

/** Patch timer / lock counts without remounting the board image. */
function updateDisplayAnsweringLive() {
  if (!state || state.phase !== 'answering') return false;
  const secs = secondsLeft();
  const total = answerSecondsTotal();
  const badge = document.getElementById('pctTimerBadge');
  const el = document.getElementById('tvTimer');
  const lock =
    document.querySelector('.image-board__locks') ||
    document.querySelector('.lock-progress');
  const boardImg =
    document.querySelector('.image-board__img') ||
    document.querySelector('.question-image');

  if (!badge && !el && !lock && !boardImg) return false;

  if (badge) {
    if (secs != null && secs <= 0) {
      badge.remove();
    } else {
      const progress = secs == null ? 1 : Math.max(0, secs) / total;
      badge.style.setProperty('--progress', progress.toFixed(4));
      badge.classList.toggle('pct-timer--warn', secs !== null && secs <= 5);
      const secsEl = document.getElementById('tvTimer');
      if (secsEl) secsEl.textContent = String(secs ?? '—');
    }
  }
  if (el && !badge) {
    el.textContent = String(secs ?? '—');
    el.classList.toggle('warn', secs !== null && secs <= 5);
  }
  if (lock && !lock.classList.contains('elim-status')) {
    const active = state.players.filter((p) => p.status === 'active').length;
    const locked = Object.values(state.answers || {}).filter((a) => a.locked).length;
    lock.textContent = `${locked} / ${active} locked in`;
  }
  return true;
}

let displayQuestionKey = '';

function displayQuestionKeyFor(s) {
  const q = s?.currentQuestion;
  return `${s?.phase}:${s?.questionIndex}:${q?.image || ''}:${q?.percent ?? ''}`;
}

async function renderLobby() {
  const players = state.players || [];
  await resolveLanOrigin();
  main.innerHTML = `
    <div class="lobby">
      <div class="lobby-join">
        <h2>JOIN ON YOUR PHONE</h2>
        <div class="join-code">${escapeHtml(state.joinCode)}</div>
        <img class="qr-image" src="${qrSrc(state.joinCode)}" alt="Join QR code" width="220" height="220" />
        <div class="join-url">${escapeHtml(playUrl())}</div>
        <p class="contestant-count">${players.length} contestant${players.length === 1 ? '' : 's'}</p>
      </div>
      <div class="side-grid">
        ${renderSeatGrid(players, { fillTo: Math.max(20, Math.min(100, players.length + 4)) })}
      </div>
    </div>
  `;
}

function renderIntro() {
  main.innerHTML = `
    <div class="center-phase">
      <h1>THE <span class="pct">1%</span> CLUB</h1>
      <p>${state.players.length} contestants · ${money(state.players.length * 1000)} at stake</p>
      <p>15 questions. Only the sharpest make it to the final 1%.</p>
    </div>
  `;
}

function renderChoices(choices) {
  if (!choices?.length) return '';
  return `<div class="q-choices">
    ${choices
      .map((text, i) => {
        const letter = String.fromCharCode(65 + i);
        return `<div class="q-choice">
          <span class="q-choice__letter">${letter}</span>
          <span class="q-choice__text">${escapeHtml(text)}</span>
        </div>`;
      })
      .join('')}
  </div>`;
}

function imageTransformStyle(t) {
  if (!t || typeof t !== 'object') return '';
  const scale = Number(t.scale);
  const x = Number(t.x);
  const y = Number(t.y);
  if (![scale, x, y].every((n) => Number.isFinite(n))) return '';
  return `transform: translate(${x}%, ${y}%) scale(${scale}); transform-origin: center center;`;
}

/** Full-bleed show graphic — sits behind the gold stage bezel at 95%. */
function renderFullBleedBoard({ src, transform = null, overlay = '' }) {
  if (!src) {
    main.innerHTML = `<div class="center-phase"><h1>Missing board image</h1></div>`;
    return;
  }
  main.innerHTML = `
    <div class="image-board">
      <div class="image-board__frame">
        <img class="image-board__img" src="${escapeHtml(src)}" alt="" style="${imageTransformStyle(transform)}" />
      </div>
      ${overlay ? `<div class="image-board__overlay">${overlay}</div>` : ''}
    </div>
  `;
}

function isImageBoardQuestion(q = state?.currentQuestion) {
  return !!(q?.hidePrompt || q?.image);
}

function answerSecondsTotal() {
  return state?.setup?.answerSeconds || 30;
}

/** LED-ring badge: only while host-started countdown is running. Hidden before start and at 0. */
function renderPctTimerBadge({ percent, secs, totalSecs, answering }) {
  if (!answering) return '';
  if (secs != null && secs <= 0) return '';
  const total = Math.max(1, Number(totalSecs) || 30);
  const left = secs != null ? Math.max(0, secs) : total;
  const progress = left / total;
  const warn = secs != null && secs <= 5;
  return `
    <div class="pct-timer pct-timer--live ${warn ? 'pct-timer--warn' : ''}"
         style="--progress:${progress.toFixed(4)}"
         id="pctTimerBadge"
         data-total="${total}">
      <div class="pct-timer__leds" aria-hidden="true"></div>
      <div class="pct-timer__face">
        <div class="pct-timer__percent">${escapeHtml(String(percent ?? '?'))}%</div>
        <div class="pct-timer__secs" id="tvTimer">${secs ?? '—'}</div>
      </div>
    </div>
  `;
}

function renderQuestion() {
  const q = state.currentQuestion;
  const secs = secondsLeft();
  const active = state.players.filter((p) => p.status === 'active');
  const locked = Object.values(state.answers || {}).filter((a) => a.locked).length;
  const answering = state.phase === 'answering';
  const key = displayQuestionKeyFor(state);

  // Keep the board image mounted while only locks / timer change
  if (answering && displayQuestionKey === key && updateDisplayAnsweringLive()) {
    return;
  }
  displayQuestionKey = key;

  // Brand hold only when we truly have no board image yet
  const hostHold = !answering && !!q?.promptHidden && !q?.image;
  const imageOnly = isImageBoardQuestion(q);
  const hasImage = !!q?.image && !hostHold;
  const hasChoices =
    !hostHold && !imageOnly && Array.isArray(q?.choices) && q.choices.length > 0;

  if (hostHold) {
    main.innerHTML = `
      <div class="question-layout">
        <div class="question-panel host-hold">
          <h1 class="host-hold__brand">THE <span class="pct">1%</span> CLUB</h1>
        </div>
        <div class="side-grid">${renderSeatGrid(state.players)}</div>
      </div>
    `;
    return;
  }

  if (imageOnly && hasImage) {
    const overlay = `
      ${renderPctTimerBadge({
        percent: q.percent,
        secs,
        totalSecs: answerSecondsTotal(),
        answering,
      })}
      ${
        answering
          ? `<div class="image-board__locks">${locked} / ${active.length} locked in</div>`
          : ''
      }
    `;
    renderFullBleedBoard({
      src: q.image,
      transform: q.imageTransform,
      overlay,
    });
    return;
  }

  main.innerHTML = `
    <div class="question-layout">
      <div class="question-panel" id="questionPanel">
        <div class="pct-badge">${q?.percent ?? '?'}%<small>OF PEOPLE GOT THIS RIGHT</small></div>
        <div class="question-flow ${hasImage ? 'question-flow--has-image' : ''}" data-image-layout="stack">
          <p class="prompt q-area-prompt">${escapeHtml(q?.prompt ?? '')}</p>
          ${
            hasImage
              ? `<div class="question-image-wrap q-area-image"><img class="question-image" src="${escapeHtml(q.image)}" alt="" style="${imageTransformStyle(q.imageTransform)}" /></div>`
              : ''
          }
          ${hasChoices ? `<div class="q-area-choices">${renderChoices(q.choices)}</div>` : '<div class="q-area-choices"></div>'}
          <div class="q-area-meta">
            ${
              answering
                ? `<div class="timer ${secs !== null && secs <= 5 ? 'warn' : ''}" id="tvTimer">${secs ?? '—'}</div>
            <div class="lock-progress">${locked} / ${active.length} locked in</div>`
                : ''
            }
          </div>
        </div>
      </div>
      <div class="side-grid">${renderSeatGrid(state.players)}</div>
    </div>
  `;

  if (hasImage) {
    requestAnimationFrame(() => syncQuestionImageLayout());
    const img = main.querySelector('.question-image');
    img?.addEventListener('load', () => syncQuestionImageLayout(), { once: true });
  }
}

/** Stack image between prompt & choices when tall enough; otherwise image on the left. */
function syncQuestionImageLayout() {
  const panel = document.getElementById('questionPanel');
  const flow = panel?.querySelector('.question-flow--has-image');
  if (!panel || !flow) return;

  // Measure in stack mode first
  flow.dataset.imageLayout = 'stack';
  const img = flow.querySelector('.question-image');
  const imgWrap = flow.querySelector('.q-area-image');
  if (!img || !imgWrap) return;

  const panelH = panel.clientHeight;
  const panelW = panel.clientWidth;
  const promptH = flow.querySelector('.q-area-prompt')?.offsetHeight || 0;
  const choicesH = flow.querySelector('.q-area-choices')?.offsetHeight || 0;
  const metaH = flow.querySelector('.q-area-meta')?.offsetHeight || 0;
  const gaps = 48;
  const leftover = panelH - promptH - choicesH - metaH - gaps;

  // Ideal image height if shown at up to ~90% panel width
  const natW = img.naturalWidth || 800;
  const natH = img.naturalHeight || 600;
  const maxW = panelW * 0.9;
  const renderedH = Math.min(leftover, (natH / natW) * maxW);

  const canStack =
    leftover >= 140 &&
    renderedH >= 100 &&
    leftover >= panelH * 0.22 &&
    panelH >= panelW * 0.72;

  flow.dataset.imageLayout = canStack ? 'stack' : 'side';
}

function renderEliminating() {
  const elim = state.elimination || {};
  const pending = elim.stage === 'pending';
  const scanning = elim.stage === 'scanning';
  const sting = elim.stage === 'sting' || scanning;
  const q = state.currentQuestion;
  const imageOnly = isImageBoardQuestion(q);
  const hasImage = !!q?.image;
  const hasChoices =
    !imageOnly && Array.isArray(q?.choices) && q.choices.length > 0;
  const outCount = elim.revealedCount || 0;
  const leftCount = state.players.filter((p) => p.status === 'active').length;
  const showTally = !pending && !scanning && outCount > 0;
  let statusLine = '';
  if (pending) statusLine = 'Waiting for the host…';
  else if (sting) statusLine = 'Blue lights scanning…';
  else if (showTally) statusLine = `${outCount} out · ${leftCount} left`;

  // During the search / thump, show seats beside the board so the light can hop
  if (imageOnly && hasImage && !(scanning || elim.stage === 'sting')) {
    renderFullBleedBoard({
      src: q.image,
      transform: q.imageTransform,
      overlay: statusLine
        ? `<div class="image-board__locks elim-status ${sting ? 'elim-status--scan' : ''}">${escapeHtml(statusLine)}</div>`
        : '',
    });
    return;
  }

  if (imageOnly && hasImage && (scanning || elim.stage === 'sting')) {
    main.innerHTML = `
      <div class="question-layout question-layout--elim">
        <div class="question-panel question-panel--board">
          <div class="elim-board-wrap">
            <img class="elim-board-img" src="${escapeHtml(q.image)}" alt="" style="${imageTransformStyle(q.imageTransform)}" />
            ${
              statusLine
                ? `<div class="image-board__locks elim-status elim-status--scan">${escapeHtml(statusLine)}</div>`
                : ''
            }
          </div>
        </div>
        <div class="side-grid">${renderSeatGrid(state.players)}</div>
      </div>
    `;
    return;
  }

  // Keep the question on screen the entire blue-light beat (TV show style).
  main.innerHTML = `
    <div class="question-layout question-layout--elim">
      <div class="question-panel" id="questionPanel">
        <div class="pct-badge">${q?.percent ?? '?'}%<small>OF PEOPLE GOT THIS RIGHT</small></div>
        <div class="question-flow ${hasImage ? 'question-flow--has-image' : ''}" data-image-layout="stack">
          <p class="prompt q-area-prompt">${escapeHtml(q?.prompt ?? '')}</p>
          ${
            hasImage
              ? `<div class="question-image-wrap q-area-image"><img class="question-image" src="${escapeHtml(q.image)}" alt="" style="${imageTransformStyle(q.imageTransform)}" /></div>`
              : ''
          }
          ${hasChoices ? `<div class="q-area-choices">${renderChoices(q.choices)}</div>` : '<div class="q-area-choices"></div>'}
          <div class="q-area-meta">
            <div class="elim-status ${sting ? 'elim-status--scan' : ''}">${escapeHtml(statusLine)}</div>
          </div>
        </div>
      </div>
      <div class="side-grid">${renderSeatGrid(state.players)}</div>
    </div>
  `;

  if (hasImage) {
    requestAnimationFrame(() => syncQuestionImageLayout());
    const img = main.querySelector('.question-image');
    img?.addEventListener('load', () => syncQuestionImageLayout(), { once: true });
  }
}

function renderEliminatedCount() {
  const out = Number(
    state.reveal?.eliminated ??
      state.elimination?.wrongIds?.length ??
      state.players.filter((p) => p.status === 'out').length,
  );
  main.innerHTML = `
    <div class="left-count-board">
      <div class="left-count-board__value">${Number.isFinite(out) ? out : 0}</div>
      <div class="left-count-board__label">eliminated</div>
      <p class="left-count-board__sub">players out this round</p>
    </div>
  `;
}

function renderLeftCount() {
  const left = state.players.filter((p) => p.status === 'active').length;
  main.innerHTML = `
    <div class="left-count-board">
      <div class="left-count-board__value">${left}</div>
      <div class="left-count-board__label">remain</div>
      <p class="left-count-board__sub">contestants still in the game</p>
    </div>
  `;
}

let potAnimToken = 0;
/** @type {string|null} */
let potAnimKey = null;

function renderPrizePot() {
  const to = Number(state.jackpot) || 0;
  const from = Number.isFinite(Number(state.prevJackpot))
    ? Number(state.prevJackpot)
    : to;
  // clear_sound / extra broadcasts re-enter render while still on prize_pot —
  // don't rebuild the board or restart the count-up.
  const key = `${state.lastAction?.at ?? 'x'}:${from}->${to}`;
  if (main.querySelector('.prize-pot') && potAnimKey === key) {
    return;
  }
  potAnimKey = key;

  const signs = Array.from({ length: 36 }, (_, i) => {
    const left = 4 + ((i * 17) % 92);
    const delay = ((i * 0.11) % 2.4).toFixed(2);
    const dur = (2.4 + (i % 5) * 0.35).toFixed(2);
    const size = 1.1 + (i % 6) * 0.35;
    return `<span class="prize-pot__sign" style="left:${left}%;animation-delay:${delay}s;animation-duration:${dur}s;font-size:${size}em">${currency() === 'dollars' ? '$' : '★'}</span>`;
  }).join('');

  main.innerHTML = `
    <div class="prize-pot">
      <div class="prize-pot__glow"></div>
      <div class="prize-pot__ring"></div>
      <div class="prize-pot__signs" aria-hidden="true">${signs}</div>
      <div class="prize-pot__amount" id="prizePotAmount">${escapeHtml(money(from))}</div>
      <div class="prize-pot__label">PRIZE POT</div>
    </div>
  `;

  const el = document.getElementById('prizePotAmount');
  if (el && from !== to) {
    animateMoney(el, from, to, 2200);
  } else if (el) {
    el.textContent = money(to);
  }
}

function animateMoney(el, from, to, durationMs) {
  const token = ++potAnimToken;
  const start = performance.now();
  const delta = to - from;
  const tick = (now) => {
    if (token !== potAnimToken) return;
    const t = Math.min(1, (now - start) / durationMs);
    const eased = 1 - (1 - t) ** 3;
    el.textContent = money(Math.round(from + delta * eased));
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function renderAnswerReveal() {
  const r = state.reveal;
  const accepted = (r?.accepted || []).slice(0, 3).join(' / ');
  const q = state.currentQuestion;
  const solutionSrc = q?.solutionImage || q?.image;
  const solutionTransform = q?.solutionImage
    ? q.solutionImageTransform || q.imageTransform
    : q?.imageTransform;

  // Full show boards already include the answer art — fill the stage.
  if (isImageBoardQuestion(q) && solutionSrc) {
    renderFullBleedBoard({
      src: solutionSrc,
      transform: solutionTransform,
    });
    return;
  }

  main.innerHTML = `
    <div class="reveal-layout reveal-layout--answer-only">
      <div class="pct-badge" style="align-self:center">${r?.percent ?? '?'}%</div>
      ${
        solutionSrc
          ? `<div class="question-image-wrap question-image-wrap--reveal"><img class="question-image" src="${escapeHtml(solutionSrc)}" alt="" style="${imageTransformStyle(solutionTransform)}" /></div>`
          : ''
      }
      <div class="answer-banner">
        <div class="answer-banner__label">CORRECT ANSWER</div>
        <div class="answer-banner__value">${escapeHtml(accepted)}</div>
      </div>
    </div>
  `;
}

function renderReveal() {
  const r = state.reveal;
  const accepted = (r?.accepted || []).slice(0, 3).join(' / ');
  const leftCount = state.players.filter((p) => p.status === 'active').length;
  const outCount = r?.eliminated ?? state.players.filter((p) => p.status === 'out').length;
  const q = state.currentQuestion;
  main.innerHTML = `
    <div class="reveal-layout">
      <div class="pct-badge" style="align-self:center">${r?.percent ?? '?'}%</div>
      ${
        q?.image
          ? `<div class="question-image-wrap question-image-wrap--reveal"><img class="question-image" src="${escapeHtml(q.image)}" alt="" style="${imageTransformStyle(q.imageTransform)}" /></div>`
          : ''
      }
      <div class="answer-banner">
        <div class="answer-banner__label">CORRECT ANSWER</div>
        <div class="answer-banner__value">${escapeHtml(accepted)}</div>
      </div>
      <div class="reveal-stats">
        <div class="out">${outCount} out</div>
        <div class="in">${leftCount} left</div>
      </div>
      <div class="side-grid" style="flex:1;min-height:0">${renderSeatGrid(state.players)}</div>
    </div>
  `;
}

function renderPassBriefing() {
  main.innerHTML = `
    <div class="center-phase">
      <h1>YOU NOW HAVE A <span class="pct">PASS</span></h1>
      <p>One free escape. Using it puts ${money(1000)} into the prize pot.</p>
      <img
        class="pass-example-art"
        src="/images/pass-available-example.png"
        alt="USE PASS button example"
      />
      <p>Listen to the host — then the 50% question.</p>
      <div class="side-grid" style="width:70%;max-height:40%">${renderSeatGrid(state.players.filter((p) => p.status === 'active'))}</div>
    </div>
  `;
}

function renderCashout() {
  main.innerHTML = `
    <div class="center-phase">
      <h1>TAKE THE <span class="pct">${money(1000)}</span>?</h1>
      <p>Players who still have their pass may leave with ${money(1000)} before the 30% question.</p>
      <div class="side-grid" style="width:70%;max-height:40%">${renderSeatGrid(state.players.filter((p) => p.status === 'active'))}</div>
    </div>
  `;
}

function renderFinalChoice() {
  const active = state.players.filter((p) => p.status === 'active');
  const offer = Math.floor((Number(state.jackpot) || 0) / 2);
  main.innerHTML = `
    <div class="center-phase">
      <h1>TAKE <span class="pct">${money(offer)}</span> OR GO FOR <span class="pct">1%</span>?</h1>
      <p>${active.length} finalist${active.length === 1 ? '' : 's'} · pot ${money(state.jackpot)} · offer is half</p>
      <p>Anyone who stays faces the 1% question — one player or a full table.</p>
      <div class="side-grid" style="width:70%;max-height:40%">${renderSeatGrid(active)}</div>
    </div>
  `;
}

function renderSolo() {
  const solo = state.players.find((p) => p.status === 'active');
  const offer = Math.floor((Number(state.jackpot) || 0) / 2);
  main.innerHTML = `
    <div class="center-phase">
      <h1>ONE LEFT</h1>
      <p><strong>${escapeHtml(solo?.name ?? '')}</strong> — take ${money(offer)} (half the pot) or face the 1% question?</p>
      <p>Prize pot: ${money(state.jackpot)}</p>
    </div>
  `;
}

function renderFinale() {
  const winners = state.players.filter(
    (p) =>
      p.status === 'winner' ||
      p.status === 'took10k' ||
      p.status === 'cashed' ||
      (p.winnings > 0 && p.status === 'out'),
  );
  const big = winners.filter((p) => p.status === 'winner');
  main.innerHTML = `
    <div class="center-phase">
      <h1>${big.length ? 'WELCOME TO THE <span class="pct">1%</span> CLUB' : 'GAME OVER'}</h1>
      <p>Final jackpot: ${money(state.jackpot)}</p>
      <ul class="winner-list">
        ${winners
          .map((p) => {
            let tag = '';
            if (p.status === 'took10k') tag = ` (took ${money(p.winnings)})`;
            else if (p.status === 'cashed') tag = ' (cashed out)';
            else if (p.status === 'out') tag = ` (kept ${money(1000, { short: true })} bonus)`;
            return `<li>${escapeHtml(p.name)} · ${money(p.winnings)}${tag}</li>`;
          })
          .join('') || '<li>Nobody survived</li>'}
      </ul>
    </div>
  `;
}

function renderGameEnd() {
  main.innerHTML = `
    <div class="center-phase">
      <h1>No one got to the <span class="pct">1%</span> question</h1>
      <p>The jackpot of ${money(state.jackpot)} goes unclaimed.</p>
    </div>
  `;
}

function render() {
  if (!state) return;
  jackpotEl.textContent = money(state.jackpot);
  aliveEl.textContent = String(state.players.filter((p) => p.status === 'active').length);
  document.body.classList.toggle('prize-pot-mode', state.phase === 'prize_pot');
  if (state.phase !== 'prize_pot') potAnimKey = null;
  document.body.classList.toggle(
    'left-count-mode',
    state.phase === 'left_count' || state.phase === 'eliminated_count',
  );

  const imageBoard =
    isImageBoardQuestion(state.currentQuestion) &&
    !!state.currentQuestion?.image &&
    (state.phase === 'answering' ||
      state.phase === 'question' ||
      state.phase === 'eliminating' ||
      state.phase === 'answer_reveal');
  document.body.classList.toggle('image-board-mode', imageBoard);

  switch (state.phase) {
    case 'lobby':
      renderLobby();
      break;
    case 'intro':
      renderIntro();
      break;
    case 'pass_briefing':
      renderPassBriefing();
      break;
    case 'question':
    case 'answering':
      renderQuestion();
      break;
    case 'eliminating':
      renderEliminating();
      break;
    case 'eliminated_count':
      renderEliminatedCount();
      break;
    case 'left_count':
      renderLeftCount();
      break;
    case 'answer_reveal':
      renderAnswerReveal();
      break;
    case 'prize_pot':
      renderPrizePot();
      break;
    case 'reveal':
      renderReveal();
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
    case 'finale':
      renderFinale();
      break;
    case 'game_end':
      renderGameEnd();
      break;
    default:
      // Fallback if a deploy races ahead of cached clients
      if (state.phase === 'eliminated_count') {
        renderEliminatedCount();
      } else if (state.phase === 'left_count') {
        renderLeftCount();
      } else {
        main.innerHTML = `<div class="center-phase"><h1>${escapeHtml(state.phase)}</h1></div>`;
      }
  }
}

async function handleSoundCue(cue) {
  if (!cue || cue.at === lastSoundAt) return;
  lastSoundAt = cue.at;

  // Phone-only cues — TV stays silent; server timer advances
  if (cue.audience === 'play') {
    return;
  }

  if (cue.name === 'timer_seek') {
    const fromEnd = cue.secondsFromEnd ?? TIMER_STING_SEC;
    timerEndSeeked = true;
    if (!seekTimerToEnd(fromEnd)) {
      stopAllMusic();
      await playSound('timer', { asMusic: false });
      seekTimerToEnd(fromEnd);
    }
    return;
  }

  // Only bed / phase music stops the previous track.
  const looping = cue.name === 'interlude' || cue.loop === true;
  const replacesMusic =
    looping ||
    cue.name === 'intro' ||
    cue.name === 'timer' ||
    cue.name === 'thump' ||
    cue.name === 'eliminating' ||
    cue.name === 'eliminate' ||
    cue.name === 'correct' ||
    cue.name === 'win' ||
    cue.name === 'jackpot';
  if (replacesMusic) stopAllMusic();
  // jackpot sting at full TV presence for the pot board
  if (cue.name === 'jackpot') {
    await playSound('jackpot', { volume: 0.85 });
    return;
  }

  // thump.mp3 on TV before each wrong blue light — advances the sting
  if (cue.name === 'thump') {
    stopPendingEliminating();
    const times = cue.times || state?.elimination?.stingTimes || 1;
    await playSoundTimes('thump', times, { volume: 0.85 });
    try {
      await sendAction('elim_sting_done');
    } catch {
      // server fallback timer will advance
    }
    return;
  }

  // Show wrongs — eliminating.mp3 × 1–3 on TV, then advance to thumps / boards
  if (cue.name === 'eliminating') {
    stopPendingEliminating();
    const vol = typeof cue.volume === 'number' ? cue.volume : 0.65;
    const times = cue.times || state?.elimination?.stingTimes || 1;
    if (cue.loop) {
      playEliminatingUntilStopped({ times, volume: vol }).catch(() => {});
      return;
    }
    await playSoundTimes('eliminating', times, { volume: vol });
    try {
      await sendAction('elim_sting_done');
    } catch {
      // server fallback timer will advance
    }
    return;
  }

  // After all wrongs shown — eliminate.mp3 once over the left-count board
  if (cue.name === 'eliminate') {
    stopPendingEliminating();
    await playSound('eliminate', { volume: 0.65 });
    return;
  }

  const setupIntro =
    typeof state?.setup?.introVolume === 'number' ? state.setup.introVolume : 0.75;
  const volume =
    typeof cue.volume === 'number'
      ? cue.volume
      : cue.name === 'intro'
        ? setupIntro
        : undefined;
  await playSound(cue.name, {
    loop: looping,
    asMusic: looping || cue.name === 'intro',
    ...(volume != null ? { volume } : {}),
  });
  // Don't clear looping intro — host is talking over it until Begin questions
  if (!looping) {
    try {
      await sendAction('clear_sound');
    } catch {
      // ignore
    }
  }
}

function onState(next) {
  const prevPhase = state?.phase;
  state = next;
  hideBoot();
  setMasterVolume(next.setup?.masterVolume ?? 0.7);
  configureSounds(next.setup?.sounds);
  // Stop question / eliminating beds on phase changes
  if (
    prevPhase === 'answering' &&
    (next.phase === 'eliminating' || next.phase === 'reveal')
  ) {
    stopAllMusic();
  }
  if (
    prevPhase === 'eliminating' &&
    (next.phase === 'left_count' || next.phase === 'prize_pot' || next.phase === 'reveal')
  ) {
    // thump / eliminate cues handle stop; clean round has no cue — stop here
    if (!next.soundCue) stopPendingEliminating();
  }
  // Intro only before Q1 — later question holds stay silent
  if (next.phase === 'question' && (next.questionIndex ?? 0) > 0) {
    stopAllMusic();
  }
  render();
  ensureScanTick();
  if (next.phase === 'answering') {
    if (prevPhase !== 'answering') timerEndSeeked = false;
    startTimerTick();
  } else {
    displayQuestionKey = '';
  }
  handleSoundCue(next.soundCue);
}

function unlockAudio() {
  activateAudio();
  tapHint.classList.add('hidden');
}

tapHint.addEventListener('click', unlockAudio);
window.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  }
  unlockAudio();
});
window.addEventListener('pointerdown', unlockAudio, { once: false });

if (isAudioActivated()) tapHint.classList.add('hidden');

connect('display', onState);

window.addEventListener('resize', () => {
  if (state?.currentQuestion?.image) syncQuestionImageLayout();
});

setTimeout(() => {
  if (!state) {
    showBoot(
      `Still connecting… Open <code>${location.origin}/</code> or check the server terminal.`,
      { error: true },
    );
  }
}, 4000);
