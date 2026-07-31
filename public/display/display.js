import { connect, sendAction } from '../shared/ws.js';
import {
  activateAudio,
  playSound,
  playSoundTimes,
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
  if (elim?.stage === 'clean_sting' && p.status === 'active') {
    return 'searching';
  }
  if (
    (elim?.stage === 'sting' || elim?.stage === 'lighting') &&
    p.status === 'active' &&
    elim.wrongIds?.includes(p.id) &&
    !elim.revealedIds?.includes(p.id)
  ) {
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
  const hasImage = !!q?.image && !promptHidden;
  const hasChoices = !promptHidden && Array.isArray(q?.choices) && q.choices.length > 0;

  // Host talk beat — brand mark only until Start reveals the question.
  if (promptHidden) {
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
  const pending = elim.stage === 'pending';
  const sting = elim.stage === 'sting' || elim.stage === 'clean_sting';
  const outCount = elim.revealedCount || 0;
  const leftCount = state.players.filter((p) => p.status === 'active').length;
  const current = state.players.find((p) => p.id === elim.currentId);
  // Show running tally once anyone has been revealed (and keep it through later stings)
  const showTally = !pending && outCount > 0;

  main.innerHTML = `
    <div class="elim-layout">
      <div class="elim-panel">
        <div class="pct-badge">${state.currentQuestion?.percent ?? '?'}%</div>
        <h2 class="elim-title">${
          pending
            ? 'THE <span class="pct">1%</span> CLUB'
            : sting
              ? 'SEARCHING…'
              : "YOU'RE OUT"
        }</h2>
        ${
          showTally
            ? `<div class="elim-tally">
          <div class="elim-tally__row elim-tally__row--out">
            <span class="elim-tally__value" id="elimOutCount">${outCount}</span>
            <span class="elim-tally__label">out</span>
          </div>
          <div class="elim-tally__row elim-tally__row--left">
            <span class="elim-tally__value" id="elimLeftCount">${leftCount}</span>
            <span class="elim-tally__label">left</span>
          </div>
        </div>`
            : ''
        }
        ${
          current && !pending && !sting
            ? `<p class="elim-current">${escapeHtml(current.name)}</p>`
            : `<p class="elim-current muted">${
                sting ? 'Blue lights scanning…' : pending ? '' : ' '
              }</p>`
        }
      </div>
      <div class="side-grid">${renderSeatGrid(state.players)}</div>
    </div>
  `;
}

function renderLeftCount() {
  const left = state.players.filter((p) => p.status === 'active').length;
  main.innerHTML = `
    <div class="left-count-board">
      <div class="left-count-board__value">${left}</div>
      <div class="left-count-board__label">left</div>
      <p class="left-count-board__sub">contestants still in the game</p>
    </div>
  `;
}

function renderPrizePot() {
  const amount = money(state.jackpot);
  const signs = Array.from({ length: 36 }, (_, i) => {
    const left = 4 + ((i * 17) % 92);
    const delay = ((i * 0.11) % 2.4).toFixed(2);
    const dur = (2.4 + (i % 5) * 0.35).toFixed(2);
    const size = 1.1 + (i % 6) * 0.35;
    return `<span class="prize-pot__sign" style="left:${left}%;animation-delay:${delay}s;animation-duration:${dur}s;font-size:${size}em">$</span>`;
  }).join('');

  main.innerHTML = `
    <div class="prize-pot">
      <div class="prize-pot__glow"></div>
      <div class="prize-pot__ring"></div>
      <div class="prize-pot__signs" aria-hidden="true">${signs}</div>
      <div class="prize-pot__amount">${escapeHtml(amount)}</div>
      <div class="prize-pot__label">PRIZE POT</div>
    </div>
  `;
}

function renderReveal() {
  const r = state.reveal;
  const accepted = (r?.accepted || []).slice(0, 3).join(' / ');
  const leftCount = state.players.filter((p) => p.status === 'active').length;
  const outCount = r?.eliminated ?? state.players.filter((p) => p.status === 'out').length;
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
        <div class="out">${outCount} out</div>
        <div class="in">${leftCount} left</div>
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
  document.body.classList.toggle('prize-pot-mode', state.phase === 'prize_pot');
  document.body.classList.toggle('left-count-mode', state.phase === 'left_count');

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
    case 'left_count':
      renderLeftCount();
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
      main.innerHTML = `<div class="center-phase"><h1>${escapeHtml(state.phase)}</h1></div>`;
  }
}

async function handleSoundCue(cue) {
  if (!cue || cue.at === lastSoundAt) return;
  lastSoundAt = cue.at;

  // Phone-only cues — TV stays silent (server timer advances the sting)
  if (cue.audience === 'play' || cue.name === 'thump') {
    return;
  }

  // Only bed / phase music stops the previous track.
  const looping = cue.name === 'interlude';
  const replacesMusic =
    looping ||
    cue.name === 'intro' ||
    cue.name === 'timer' ||
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

  // TV-only: eliminating.mp3 × 1–3 (clean round or last wrong), then advance
  if (cue.name === 'eliminating') {
    const times = cue.times || state?.elimination?.stingTimes || 1;
    await playSoundTimes('eliminating', times, { volume: 0.5 });
    try {
      await sendAction('elim_sting_done');
    } catch {
      // server fallback timer will advance
    }
    return;
  }

  const volume =
    cue.name === 'intro' || cue.name === 'eliminate' ? 0.5 : undefined;
  await playSound(cue.name, {
    loop: looping,
    asMusic: looping || cue.name === 'intro',
    ...(volume != null ? { volume } : {}),
  });
  if (cue.name !== 'eliminate') {
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
  // Stop question bed when the round ends
  if (
    prevPhase === 'answering' &&
    (next.phase === 'eliminating' || next.phase === 'reveal')
  ) {
    stopAllMusic();
  }
  // Intro only before Q1 — later question holds stay silent
  if (next.phase === 'question' && (next.questionIndex ?? 0) > 0) {
    stopAllMusic();
  }
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
