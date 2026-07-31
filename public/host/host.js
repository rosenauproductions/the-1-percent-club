import { connect, sendAction } from '../shared/ws.js';
import { installErrorHandlers, mountQaWidget, showBoot, hideBoot } from '../shared/boot.js';

installErrorHandlers('host');
mountQaWidget('host');
showBoot('Connecting to server…');

const main = document.getElementById('main');
const statusLine = document.getElementById('statusLine');
const jackpotEl = document.getElementById('jackpot');

let state = null;
let questionFiles = [];

function money(n) {
  return `$${Number(n || 0).toLocaleString('en-US')}`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function act(action, payload = {}) {
  try {
    await sendAction(action, payload);
  } catch (err) {
    alert(err.message);
  }
}

async function loadPacks() {
  try {
    const res = await fetch('/api/question-files');
    const data = await res.json();
    questionFiles = data.files || [];
  } catch {
    questionFiles = ['sample.json'];
  }
}

function lockedCount() {
  return Object.values(state.answers || {}).filter((a) => a.locked).length;
}

function activePlayers() {
  return (state.players || []).filter((p) => p.status === 'active');
}

function renderLobby() {
  const players = state.players || [];
  main.innerHTML = `
    <div class="card">
      <h2>Lobby · Code ${escapeHtml(state.joinCode)}</h2>
      <p class="muted">${players.length} joined · ${state.lobbyOpen ? 'open' : 'closed'} · Display ${state.displayConnected ? '✓' : '✗'}</p>
      <div class="stack" style="margin-top:0.75rem">
        <div class="row">
          <button class="btn-ghost" data-act="close_lobby" ${state.lobbyOpen ? '' : 'disabled'}>Close join</button>
          <button class="btn-ghost" data-act="reopen_lobby" ${state.lobbyOpen ? 'disabled' : ''}>Reopen join</button>
        </div>
        <ul class="player-list">
          ${players
            .map(
              (p) => `<li><span>${escapeHtml(p.name)}</span>
                <button class="btn-danger" data-remove="${p.id}">Remove</button></li>`,
            )
            .join('') || '<li class="muted">Waiting for players…</li>'}
        </ul>
      </div>
    </div>
    <div class="card">
      <h2>Setup</h2>
      <div class="stack">
        <label class="field">Question pack
          <select id="packSelect">
            ${questionFiles
              .map(
                (f) =>
                  `<option value="${escapeHtml(f)}" ${state.setup.questionFile === f ? 'selected' : ''}>${escapeHtml(f)}</option>`,
              )
              .join('')}
          </select>
        </label>
        <label class="field">Answer seconds
          <input id="secsInput" type="number" min="10" max="120" value="${state.setup.answerSeconds || 30}" />
        </label>
        <label class="field">Volume (0–1)
          <input id="volInput" type="number" min="0" max="1" step="0.05" value="${state.setup.masterVolume ?? 0.7}" />
        </label>
        <label class="field" style="flex-direction:row;align-items:center;gap:0.5rem">
          <input id="skipIntro" type="checkbox" ${state.setup.skipIntro ? 'checked' : ''} />
          Skip intro
        </label>
        <button class="btn-ghost" id="saveSetup">Save setup</button>
        <button class="btn-primary big-btn" data-act="start_game" ${players.length ? '' : 'disabled'}>Start game</button>
      </div>
    </div>
  `;
}

function renderIntro() {
  main.innerHTML = `
    <div class="card">
      <h2>Intro</h2>
      <p class="muted">${state.players.length} players ready</p>
      <p style="margin:0.65rem 0 0;font-weight:700;line-height:1.4">
        Intro music is at <span style="color:var(--club-gold,#ffd54a)">20%</span> — talk about the game, then begin.
      </p>
      <button class="btn-primary big-btn" style="margin-top:0.85rem" data-act="skip_intro">Begin questions</button>
    </div>
    <button class="btn-danger" data-act="reset_lobby">Reset to lobby</button>
  `;
}

function renderQuestion() {
  const q = state.currentQuestion;
  const active = activePlayers();
  const answering = state.phase === 'answering';
  const secs = state.timerEndsAt ? Math.max(0, Math.ceil((state.timerEndsAt - Date.now()) / 1000)) : null;
  const isOnePercent = q?.percent === 1 || state.questionIndex === 14;

  main.innerHTML = `
    <div class="card">
      <h2><span class="badge">${q?.percent}%</span> ${
        isOnePercent ? '1% question' : `Question ${(state.questionIndex ?? 0) + 1}/15`
      }</h2>
      ${
        !answering
          ? `<div class="host-script" style="margin-bottom:0.75rem">
              <p class="muted" style="margin:0 0 0.4rem">
                ${
                  isOnePercent
                    ? `${active.length} finalist${active.length === 1 ? '' : 's'} · TV is waiting.`
                    : 'Only you can see this. TV is waiting.'
                }
              </p>
              <p style="margin:0;font-weight:700;line-height:1.4">
                Ask this question out loud, then say:
                <span style="color:var(--club-gold,#ffd54a)">"Your time starts now."</span>
              </p>
              <p class="muted" style="margin:0.4rem 0 0">Tap Start right as you say it.</p>
            </div>`
          : ''
      }
      <p style="font-weight:700;line-height:1.35">${escapeHtml(q?.prompt || '')}</p>
      <p class="muted" style="margin-top:0.5rem">Accepted: ${(q?.accepted || []).map(escapeHtml).join(' · ')}</p>
      ${answering ? `<p class="muted">${lockedCount()} / ${active.length} locked · ${secs ?? '—'}s</p>` : ''}
      <div class="stack" style="margin-top:0.85rem">
        ${
          !answering
            ? `<button class="btn-primary big-btn" data-act="start_answering">Start — "Your time starts now"</button>`
            : `<button class="btn-gold big-btn" data-act="end_answering">End round now</button>`
        }
      </div>
    </div>
    ${
      answering
        ? `<div class="card"><h2>Live locks</h2>
            <ul class="answer-list">
              ${active
                .map((p) => {
                  const a = state.answers[p.id];
                  return `<li><div class="name">${escapeHtml(p.name)}</div>
                    <div class="text">${a?.locked ? (a.usedPass ? '(PASS)' : escapeHtml(a.text)) : '…thinking'}</div></li>`;
                })
                .join('')}
            </ul></div>`
        : `<div class="card"><h2>Still in</h2>
            <ul class="answer-list">
              ${active
                .map((p) => `<li><div class="name">${escapeHtml(p.name)}</div></li>`)
                .join('') || '<li><div class="text">Nobody left</div></li>'}
            </ul></div>`
    }
    <button class="btn-danger" data-act="reset_lobby">Reset to lobby</button>
  `;
}

function renderReveal() {
  const r = state.reveal;
  main.innerHTML = `
    <div class="card">
      <h2>Reveal · ${r?.percent}%</h2>
      <p class="muted">${r?.survived ?? 0} safe · ${r?.eliminated ?? 0} out · Next: ${escapeHtml(state.pendingAfterReveal || '')}</p>
      <ul class="answer-list" style="margin-top:0.75rem">
        ${(r?.results || [])
          .map(
            (row) => `<li>
              <div class="name ${row.correct ? 'ok' : 'bad'}">${escapeHtml(row.name)} ${row.correct ? '✓' : '✗'}</div>
              <div class="text">${escapeHtml(row.text)}</div>
              ${
                row.usedPass
                  ? ''
                  : `<div class="row" style="margin-top:0.4rem">
                      <button class="btn-ghost" data-override="${row.playerId}" data-correct="1">Force ✓</button>
                      <button class="btn-ghost" data-override="${row.playerId}" data-correct="0">Force ✗</button>
                    </div>`
              }
            </li>`,
          )
          .join('')}
      </ul>
      <button class="btn-primary big-btn" style="margin-top:0.85rem" data-act="advance">Continue</button>
    </div>
  `;
}

function renderCashout() {
  const eligible = activePlayers().filter((p) => p.hasPass && !p.usedPass);
  main.innerHTML = `
    <div class="card">
      <h2>Cash-out offer (before 30%)</h2>
      <p class="muted">${eligible.length} eligible · decisions: ${Object.keys(state.cashoutDecisions || {}).length}</p>
      <ul class="answer-list">
        ${eligible
          .map((p) => {
            const d = state.cashoutDecisions?.[p.id];
            return `<li><div class="name">${escapeHtml(p.name)}</div>
              <div class="text">${d === true ? 'LEAVING with $1k' : d === false ? 'STAYING' : '…deciding'}</div></li>`;
          })
          .join('')}
      </ul>
      <button class="btn-primary big-btn" style="margin-top:0.85rem" data-act="resolve_cashout">Lock decisions & continue</button>
    </div>
  `;
}

function renderFinal() {
  const active = activePlayers();
  main.innerHTML = `
    <div class="card">
      <h2>Finalists · $10k or 1%?</h2>
      <p class="muted">${active.length} left · jackpot ${money(state.jackpot)}</p>
      <p class="muted">Anyone who goes for 1% plays the last question — one player or many.</p>
      <ul class="answer-list">
        ${active
          .map((p) => {
            const d = state.finalDecisions?.[p.id];
            return `<li><div class="name">${escapeHtml(p.name)}</div>
              <div class="text">${d === true ? 'TAKE $10k' : d === false ? 'GO FOR 1%' : '…deciding'}</div></li>`;
          })
          .join('')}
      </ul>
      <button class="btn-primary big-btn" style="margin-top:0.85rem" data-act="resolve_final">Lock in & go to 1%</button>
    </div>
  `;
}

function renderSolo() {
  const solo = activePlayers()[0];
  main.innerHTML = `
    <div class="card">
      <h2>Solo offer</h2>
      <p><strong>${escapeHtml(solo?.name || '')}</strong> is alone.</p>
      <p class="muted">Jackpot ${money(state.jackpot)}</p>
      <div class="stack" style="margin-top:0.85rem">
        <button class="btn-gold big-btn" data-solo="1">Take $10,000</button>
        <button class="btn-primary big-btn" data-solo="0">Go for 1%</button>
      </div>
    </div>
  `;
}

function renderFinale() {
  if (state.phase === 'game_end') {
    main.innerHTML = `
      <div class="card">
        <h2>No one got to the 1% question</h2>
        <p class="muted">Jackpot ${money(state.jackpot)} unclaimed.</p>
        <button class="btn-primary big-btn" style="margin-top:0.85rem" data-act="reset_lobby">New game</button>
      </div>
    `;
    return;
  }
  const winners = state.players.filter((p) => ['winner', 'took10k', 'cashed'].includes(p.status));
  main.innerHTML = `
    <div class="card">
      <h2>Finale</h2>
      <ul class="answer-list">
        ${winners
          .map(
            (p) =>
              `<li><div class="name">${escapeHtml(p.name)}</div>
               <div class="text money">${money(p.winnings)} · ${escapeHtml(p.status)}</div></li>`,
          )
          .join('') || '<li>No winners</li>'}
      </ul>
      <button class="btn-primary big-btn" style="margin-top:0.85rem" data-act="reset_lobby">New game</button>
    </div>
  `;
}

function render() {
  if (!state) return;
  jackpotEl.textContent = money(state.jackpot);
  statusLine.textContent = `Phase: ${state.phase} · Players ${state.players?.length || 0} · TV ${state.displayConnected ? '✓' : '✗'}`;

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
    case 'eliminated_count': {
      const outCount =
        state.reveal?.eliminated ??
        state.elimination?.wrongIds?.length ??
        state.players.filter((p) => p.status === 'out').length;
      const allOut =
        state.pendingAfterReveal === 'game_end' || activePlayers().length === 0;
      main.innerHTML = `
        <div class="card">
          <h2>${outCount} eliminated</h2>
          <p class="muted">${
            allOut
              ? 'Everyone is out this round. TV is on the eliminated board.'
              : 'TV is showing how many went out this round.'
          }</p>
          <button class="btn-primary big-btn" style="margin-top:0.85rem" data-act="advance">
            ${allOut ? 'End game' : 'Show who remains'}
          </button>
        </div>`;
      break;
    }
    case 'left_count':
      main.innerHTML = `
        <div class="card">
          <h2>${activePlayers().length} remain</h2>
          <p class="muted">TV is showing how many contestants remain.</p>
          <button class="btn-primary big-btn" style="margin-top:0.85rem" data-act="advance">Show prize pot</button>
        </div>`;
      break;
    case 'prize_pot':
      main.innerHTML = `
        <div class="card">
          <h2>Prize pot · ${money(state.jackpot)}</h2>
          <p class="muted">TV jackpot board is up.</p>
          <button class="btn-primary big-btn" style="margin-top:0.85rem" data-act="advance">Next question</button>
        </div>`;
      break;
    case 'reveal':
      renderReveal();
      break;
    case 'eliminating':
      if (state.elimination?.stage === 'pending') {
        const r = state.reveal;
        main.innerHTML = `
          <div class="card">
            <h2>Round over</h2>
            <p class="muted">Round up — TV holding. When ready, show wrong players (eliminating × 1–3, then thumps).</p>
            <ul class="answer-list" style="margin-top:0.75rem">
              ${(r?.results || [])
                .map(
                  (row) => `<li>
                    <div class="name ${row.correct ? 'ok' : 'bad'}">${escapeHtml(row.name)} ${row.correct ? '✓' : '✗'}</div>
                    <div class="text">${escapeHtml(row.text)}</div>
                  </li>`,
                )
                .join('')}
            </ul>
            <button class="btn-primary big-btn" style="margin-top:0.85rem" data-act="show_results">Show wrong players</button>
          </div>`;
      } else {
        const stage = state.elimination?.stage;
        const scanning = stage === 'scanning';
        const sting = stage === 'sting';
        main.innerHTML = `
          <div class="card">
            <h2>Elimination</h2>
            <p class="muted">${
              scanning
                ? `TV eliminating.mp3 × ${state.elimination?.stingTimes || 1} — phones flashing`
                : sting
                  ? `Thump sequence (TV + phones)`
                  : `Lighting out ${state.elimination?.revealedCount || 0} / ${state.elimination?.wrongIds?.length || 0}`
            }</p>
            <p class="muted">Wait for the sequence to finish, then continue.</p>
          </div>`;
      }
      break;
    case 'cashout_offer':
      renderCashout();
      break;
    case 'final_choice':
      renderFinal();
      break;
    case 'solo_offer':
      renderSolo();
      break;
    case 'finale':
    case 'game_end':
      renderFinale();
      break;
    default:
      main.innerHTML = `
        <div class="card">
          <h2>${escapeHtml(state.phase)}</h2>
          <p class="muted">Unexpected host screen — try Advance or Reset.</p>
          <button class="btn-primary big-btn" style="margin-top:0.85rem" data-act="advance">Advance</button>
          <button class="btn-danger" style="margin-top:0.5rem" data-act="reset_lobby">Reset to lobby</button>
        </div>`;
  }
}

main.addEventListener('click', async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;

  if (t.id === 'saveSetup') {
    await act('update_setup', {
      setup: {
        questionFile: document.getElementById('packSelect')?.value,
        answerSeconds: Number(document.getElementById('secsInput')?.value || 30),
        masterVolume: Number(document.getElementById('volInput')?.value || 0.7),
        skipIntro: !!document.getElementById('skipIntro')?.checked,
      },
    });
    return;
  }

  const remove = t.getAttribute('data-remove');
  if (remove) {
    await act('remove_player', { targetId: remove });
    return;
  }

  const override = t.getAttribute('data-override');
  if (override) {
    await act('host_override', {
      targetId: override,
      correct: t.getAttribute('data-correct') === '1',
    });
    return;
  }

  const solo = t.getAttribute('data-solo');
  if (solo !== null && t.hasAttribute('data-solo')) {
    await act('solo_decide', { take10k: solo === '1' });
    return;
  }

  const action = t.getAttribute('data-act');
  if (action) await act(action);
});

let tick = null;
function onState(next) {
  state = next;
  hideBoot();
  render();
  if (tick) clearInterval(tick);
  if (next.phase === 'answering') {
    tick = setInterval(render, 250);
  }
}

loadPacks()
  .then(() => connect('host', onState))
  .catch((err) => {
    showBoot(`Host failed to start: ${err.message}`, { error: true });
  });

setTimeout(() => {
  if (!state) {
    showBoot(`Still connecting… Is the server running at <code>${location.origin}</code>?`, {
      error: true,
    });
  }
}, 4000);
