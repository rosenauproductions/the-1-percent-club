import { connect, sendAction } from '../shared/ws.js';
import {
  activateAudio,
  playSound,
  setMasterVolume,
  configureSounds,
  isAudioActivated,
  stopAllMusic,
} from '../shared/audio.js';
import { installErrorHandlers, mountQaWidget, showBoot, hideBoot } from '../shared/boot.js';

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

function money(n) {
  return `$${Number(n || 0).toLocaleString('en-US')}`;
}

function seatClass(p) {
  if (!p) return 'empty';
  if (p.status === 'winner') return 'winner';
  if (p.status === 'cashed' || p.status === 'took10k') return p.status;
  const elim = state?.elimination;
  if (p.status === 'out' || elim?.revealedIds?.includes(p.id)) return 'out';
  if (elim?.stage === 'search' && p.status === 'active') return 'searching';
  if (elim?.stage === 'lighting' && elim.wrongIds?.includes(p.id) && !elim.revealedIds?.includes(p.id)) {
    return 'searching';
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
      `<div class="seat ${seatClass(p)}" title="${p ? p.name : ''}">${p ? escapeHtml(p.name) : ''}</div>`,
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
    const el = document.getElementById('tvTimer');
    if (el) {
      const secs = secondsLeft();
      el.textContent = String(secs ?? '—');
      el.classList.toggle('warn', secs !== null && secs <= 5);
      const lock = document.querySelector('.lock-progress');
      if (lock && state) {
        const active = state.players.filter((p) => p.status === 'active').length;
        const locked = Object.values(state.answers || {}).filter((a) => a.locked).length;
        lock.textContent = `${locked} / ${active} locked in`;
      }
    } else {
      render();
    }
  }, 200);
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

function renderQuestion() {
  const q = state.currentQuestion;
  const secs = secondsLeft();
  const active = state.players.filter((p) => p.status === 'active');
  const locked = Object.values(state.answers || {}).filter((a) => a.locked).length;
  const answering = state.phase === 'answering';
  const promptHidden = !answering && (!!q?.promptHidden || !q?.prompt);
  const isOnePercent = q?.percent === 1 || state.questionIndex === 14;
  const hasImage = !!q?.image && !promptHidden;
  const hasChoices = !promptHidden && Array.isArray(q?.choices) && q.choices.length > 0;

  // Host talk beat — seats + percent only; question waits for Start.
  if (promptHidden) {
    const names = active.map((p) => escapeHtml(p.name)).join(' · ');
    main.innerHTML = `
      <div class="question-layout">
        <div class="question-panel host-hold">
          <div class="pct-badge">${q?.percent ?? '?'}%${
            isOnePercent
              ? '<small>THE FINAL QUESTION</small>'
              : '<small>NEXT QUESTION</small>'
          }</div>
          <div class="host-hold__body">
            <h2 class="host-hold__title">${
              isOnePercent
                ? 'WELCOME, <span class="pct">FINALISTS</span>'
                : 'OVER TO THE <span class="pct">HOST</span>'
            }</h2>
            <p class="host-hold__copy">${
              isOnePercent
                ? `${active.length} contestant${active.length === 1 ? '' : 's'} left for the 1% question.`
                : "Talk through the last answer, check who's still in, then start when ready."
            }</p>
            ${names ? `<p class="host-hold__names">${names}</p>` : ''}
            <div class="lock-progress">Waiting for host to start…</div>
          </div>
        </div>
        <div class="side-grid">${renderSeatGrid(state.players)}</div>
      </div>
    `;
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
              ? `<div class="question-image-wrap q-area-image"><img class="question-image" src="${escapeHtml(q.image)}" alt="" /></div>`
              : ''
          }
          ${hasChoices ? `<div class="q-area-choices">${renderChoices(q.choices)}</div>` : '<div class="q-area-choices"></div>'}
          <div class="q-area-meta">
            <div class="timer ${secs !== null && secs <= 5 ? 'warn' : ''}" id="tvTimer">${secs ?? '—'}</div>
            <div class="lock-progress">${locked} / ${active.length} locked in</div>
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
  const searching = elim.stage === 'search';
  const count = elim.revealedCount || 0;
  const total = elim.wrongIds?.length || 0;
  const current = state.players.find((p) => p.id === elim.currentId);

  main.innerHTML = `
    <div class="elim-layout">
      <div class="elim-panel">
        <div class="pct-badge">${state.currentQuestion?.percent ?? '?'}%</div>
        <h2 class="elim-title">${searching ? 'SEARCHING…' : 'YOU’RE OUT'}</h2>
        <div class="elim-count">
          <span class="elim-count__label">WRONG</span>
          <span class="elim-count__value" id="elimWrongCount">${count}</span>
          <span class="elim-count__of">/ ${total}</span>
        </div>
        ${
          current && !searching
            ? `<p class="elim-current">${escapeHtml(current.name)}</p>`
            : `<p class="elim-current muted">${searching ? 'Blue lights scanning the room' : ' '}</p>`
        }
      </div>
      <div class="side-grid">${renderSeatGrid(state.players)}</div>
    </div>
  `;
}

function renderReveal() {
  const r = state.reveal;
  const accepted = (r?.accepted || []).slice(0, 3).join(' / ');
  main.innerHTML = `
    <div class="reveal-layout">
      <div class="pct-badge" style="align-self:center">${r?.percent ?? '?'}%</div>
      ${
        state.currentQuestion?.image
          ? `<div class="question-image-wrap question-image-wrap--reveal"><img class="question-image" src="${escapeHtml(state.currentQuestion.image)}" alt="" /></div>`
          : ''
      }
      <div class="answer-banner">
        <div class="answer-banner__label">CORRECT ANSWER</div>
        <div class="answer-banner__value">${escapeHtml(accepted)}</div>
      </div>
      <div class="reveal-stats">
        <div class="in">${r?.survived ?? 0} SAFE</div>
        <div class="out">${r?.eliminated ?? 0} OUT</div>
      </div>
      <div class="side-grid" style="flex:1;min-height:0">${renderSeatGrid(state.players)}</div>
    </div>
  `;
}

function renderCashout() {
  main.innerHTML = `
    <div class="center-phase">
      <h1>TAKE THE <span class="pct">$1,000</span>?</h1>
      <p>Players who still have their pass may leave with $1,000 before the 30% question.</p>
      <div class="side-grid" style="width:70%;max-height:40%">${renderSeatGrid(state.players.filter((p) => p.status === 'active'))}</div>
    </div>
  `;
}

function renderFinalChoice() {
  const active = state.players.filter((p) => p.status === 'active');
  main.innerHTML = `
    <div class="center-phase">
      <h1>TAKE <span class="pct">$10,000</span> OR GO FOR <span class="pct">1%</span>?</h1>
      <p>${active.length} finalist${active.length === 1 ? '' : 's'} · jackpot ${money(state.jackpot)}</p>
      <p>Anyone who stays faces the 1% question — one player or a full table.</p>
      <div class="side-grid" style="width:70%;max-height:40%">${renderSeatGrid(active)}</div>
    </div>
  `;
}

function renderSolo() {
  const solo = state.players.find((p) => p.status === 'active');
  main.innerHTML = `
    <div class="center-phase">
      <h1>ONE LEFT</h1>
      <p><strong>${escapeHtml(solo?.name ?? '')}</strong> — take $10,000 or face the 1% question?</p>
      <p>Jackpot: ${money(state.jackpot)}</p>
    </div>
  `;
}

function renderFinale() {
  const winners = state.players.filter(
    (p) => p.status === 'winner' || p.status === 'took10k' || p.status === 'cashed',
  );
  const big = winners.filter((p) => p.status === 'winner');
  main.innerHTML = `
    <div class="center-phase">
      <h1>${big.length ? 'WELCOME TO THE <span class="pct">1%</span> CLUB' : 'GAME OVER'}</h1>
      <p>Final jackpot: ${money(state.jackpot)}</p>
      <ul class="winner-list">
        ${winners
          .map(
            (p) =>
              `<li>${escapeHtml(p.name)} · ${money(p.winnings)}${p.status === 'took10k' ? ' (took $10k)' : p.status === 'cashed' ? ' (cashed out)' : ''}</li>`,
          )
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

  switch (state.phase) {
    case 'lobby':
      renderLobby();
      break;
    case 'intro':
      renderIntro();
      break;
    case 'question':
    case 'answering':
      renderQuestion();
      break;
    case 'eliminating':
      renderEliminating();
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
      main.innerHTML = `<div class="center-phase"><h1>${escapeHtml(state.phase)}</h1></div>`;
  }
}

async function handleSoundCue(cue) {
  if (!cue || cue.at === lastSoundAt) return;
  lastSoundAt = cue.at;
  const looping = cue.name === 'intro' || cue.name === 'interlude';
  if (!looping) stopAllMusic();
  const audio = await playSound(cue.name, { loop: looping });
  if (cue.name === 'eliminating' && audio) {
    audio.addEventListener(
      'ended',
      () => {
        sendAction('elim_search_done').catch(() => {});
      },
      { once: true },
    );
  }
  try {
    await sendAction('clear_sound');
  } catch {
    // ignore
  }
}

function onState(next) {
  state = next;
  hideBoot();
  setMasterVolume(next.setup?.masterVolume ?? 0.7);
  configureSounds(next.setup?.sounds);
  render();
  if (next.phase === 'answering') startTimerTick();
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
