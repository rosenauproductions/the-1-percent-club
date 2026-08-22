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

/** Secret test mode: /host?test=1 or tap HOST title 5× */
const params = new URLSearchParams(location.search);
let testMode = params.get('test') === '1' || params.get('test') === 'true';
let hostTitleTaps = 0;
let hostTitleTapTimer = null;

function money(n) {
  return `$${Number(n || 0).toLocaleString('en-US')}`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const HOST_SNARK = [
  'Let’s put all the ugliness behind us… and focus on the ugliness ahead.',
  'Congratulations to everyone who just donated their thousand dollars to the smarter people.',
  'That was a bloodbath. I feel like I should be offering counseling.',
  'If you just got a blue light, thank you for your generous contribution to the pot.',
  'We’ve gone from hopefuls to… significantly fewer hopefuls.',
];

function pickSnark(seed) {
  const i = Math.abs(Number(seed) || 0) % HOST_SNARK.length;
  return HOST_SNARK[i];
}

function isWipeoutPending() {
  return state?.pendingAfterReveal === 'wipeout_final';
}

function advanceLabel({ allOut = false } = {}) {
  if (isWipeoutPending()) return 'Continue · final decision';
  if (allOut || state?.pendingAfterReveal === 'game_end') return 'End game';
  return null;
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
    questionFiles = ['split-decision.json'];
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
        ${
          testMode
            ? `<button class="btn-ghost" data-act="seed_test_players" style="opacity:0.55;font-size:0.85rem">
                Seed 5 test players
              </button>`
            : ''
        }
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
                TV is showing the board. Read the question out loud, then start the timer.
              </p>
            </div>`
          : ''
      }
      <p style="font-weight:700;line-height:1.45;font-size:1.15rem;margin:0">${escapeHtml(q?.prompt || '')}</p>
      ${
        q?.image
          ? `<div style="margin-top:0.75rem;border-radius:12px;overflow:hidden;border:1px solid rgba(255,213,74,0.35);background:#000">
              <img src="${escapeHtml(q.image)}" alt="" style="display:block;width:100%;max-height:220px;object-fit:contain" />
            </div>`
          : ''
      }
      <p class="muted" style="margin-top:0.65rem">Accepted: ${(q?.accepted || []).map(escapeHtml).join(' · ')}</p>
      ${answering ? `<p class="muted">${lockedCount()} / ${active.length} locked · ${secs ?? '—'}s</p>` : ''}
      <div class="stack" style="margin-top:0.85rem">
        ${
          !answering
            ? `<button class="btn-primary big-btn" data-act="start_answering">Start timer</button>
               <p class="muted" style="margin:0.35rem 0 0;text-align:center">Say “Your time starts now” as you tap.</p>`
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
      ${renderRoastLists()}
      <button class="btn-primary big-btn" style="margin-top:0.85rem" data-act="advance">Continue</button>
    </div>
  `;
}

/** Host roast sheet — wrong answers first and loud. */
function renderRoastLists() {
  const r = state.reveal;
  const results = r?.results || [];
  const wrongs = results.filter((row) => !row.correct);
  const safes = results.filter((row) => row.correct);
  const accepted = (r?.accepted || []).slice(0, 4).join(' · ') || '—';

  return `
    <p class="roast-correct muted" style="margin-top:0.65rem">
      Correct: <strong style="color:var(--club-gold,#ffd54a)">${escapeHtml(accepted)}</strong>
    </p>
    ${
      wrongs.length
        ? `<div class="roast-block roast-block--wrong" style="margin-top:0.85rem">
            <h3 class="roast-heading">Wrong · roast these</h3>
            <ul class="answer-list roast-list">
              ${wrongs
                .map(
                  (row) => `<li class="roast-item">
                    <div class="name bad">${escapeHtml(row.name)}</div>
                    <div class="roast-answer">${
                      row.timedOut || !row.text
                        ? '<em>(no answer)</em>'
                        : `“${escapeHtml(row.text)}”`
                    }</div>
                  </li>`,
                )
                .join('')}
            </ul>
          </div>`
        : `<p class="muted" style="margin-top:0.85rem">Nobody wrong — clean round.</p>`
    }
    ${
      safes.length
        ? `<div class="roast-block roast-block--safe" style="margin-top:0.75rem">
            <h3 class="roast-heading muted">Safe</h3>
            <ul class="answer-list">
              ${safes
                .map(
                  (row) => `<li>
                    <div class="name ok">${escapeHtml(row.name)} ✓</div>
                    <div class="text">${escapeHtml(row.text || '—')}</div>
                  </li>`,
                )
                .join('')}
            </ul>
          </div>`
        : ''
    }
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
      const wipeout = isWipeoutPending();
      const allOut =
        state.pendingAfterReveal === 'game_end' || activePlayers().length === 0;
      main.innerHTML = `
        <div class="card">
          <h2>${outCount} eliminated</h2>
          <p class="muted">
            ${
              wipeout
                ? 'Full wipeout — furthest contestants (everyone who reached this question) become finalists after the pot.'
                : allOut
                  ? 'Everyone is out. TV is on the eliminated board — roast them, then end.'
                  : 'TV is showing outs. Next: who remains, then you roast.'
            }
          </p>
          ${allOut || wipeout ? renderRoastLists() : ''}
          <button class="btn-primary big-btn" style="margin-top:0.85rem" data-act="advance">
            ${advanceLabel({ allOut }) || 'Show who remains'}
          </button>
        </div>`;
      break;
    }
    case 'left_count': {
      const left = activePlayers().length;
      const wipeout = isWipeoutPending();
      const allOut =
        state.pendingAfterReveal === 'game_end' || left === 0;
      const explanation =
        state.reveal?.explanation ||
        'TEMP: Explain how this one works — why the correct answer is right.';
      main.innerHTML = `
        <div class="card">
          <h2>${wipeout ? '0 left — wipeout!' : `${left} left!`}</h2>
          <p class="host-script" style="margin:0.65rem 0;font-weight:700;line-height:1.4">
            ${
              wipeout
                ? 'Everyone missed. Per show rules they’re still the furthest — roast, show the answer, pot, then Final Decision.'
                : 'Blue lights and thumps are done. TV shows who’s left — now roast the wrong answers.'
            }
          </p>
          ${renderRoastLists()}
          <div class="host-explanation" style="margin:0.85rem 0;padding:0.75rem 0.9rem;border-radius:12px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12)">
            <div class="muted" style="font-size:0.75rem;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:0.35rem">How to answer</div>
            <p style="margin:0;line-height:1.45;font-weight:600">${escapeHtml(explanation)}</p>
          </div>
          <button class="btn-primary big-btn" style="margin-top:0.5rem" data-act="show_right_answer">
            Show right answer
          </button>
          <button class="btn-ghost big-btn" style="margin-top:0.65rem" data-act="advance">
            ${advanceLabel({ allOut }) || 'Done roasting · prize pot'}
          </button>
        </div>`;
      break;
    }
    case 'answer_reveal': {
      const left = activePlayers().length;
      const allOut =
        state.pendingAfterReveal === 'game_end' || left === 0;
      const accepted = (state.reveal?.accepted || []).slice(0, 3).join(' / ');
      main.innerHTML = `
        <div class="card">
          <h2>Right answer on TV</h2>
          <p class="muted" style="margin:0.5rem 0">Correct: <strong>${escapeHtml(accepted || '—')}</strong></p>
          ${renderRoastLists()}
          <button class="btn-primary big-btn" style="margin-top:0.85rem" data-act="advance">
            ${advanceLabel({ allOut }) || 'Done roasting · prize pot'}
          </button>
        </div>`;
      break;
    }
    case 'prize_pot': {
      const snark = pickSnark(
        (state.questionIndex ?? 0) * 17 + (state.jackpot ?? 0),
      );
      const wipeout = isWipeoutPending();
      const nextLabel =
        advanceLabel() ||
        (state.pendingAfterReveal === 'solo_offer'
          ? 'Continue · solo offer'
          : state.pendingAfterReveal === 'final_choice'
            ? 'Continue · final decision'
            : state.pendingAfterReveal === 'finale'
              ? 'Continue · finale'
              : 'Next question');
      main.innerHTML = `
        <div class="card">
          <h2>Prize pot · ${money(state.jackpot)}</h2>
          <p class="muted">TV jackpot board is counting up.</p>
          <div class="host-script" style="margin:0.85rem 0;padding:0.75rem 0.9rem;border-radius:12px;background:rgba(255,213,74,0.1);border:1px solid rgba(255,213,74,0.35);font-weight:700;line-height:1.4;color:var(--club-gold,#ffd54a)">
            “${escapeHtml(snark)}”
          </div>
          ${
            wipeout
              ? `<p class="muted" style="margin:0 0 0.5rem">After this: Final Decision for the furthest contestants.</p>`
              : ''
          }
          <button class="btn-primary big-btn" style="margin-top:0.5rem" data-act="advance">${nextLabel}</button>
        </div>`;
      break;
    }
    case 'reveal':
      renderReveal();
      break;
    case 'eliminating':
      if (state.elimination?.stage === 'pending') {
        const r = state.reveal;
        main.innerHTML = `
          <div class="card">
            <h2>Time’s up · ${r?.percent ?? '?'}%</h2>
            <div class="host-script" style="margin:0.75rem 0;font-weight:700;line-height:1.45">
              <p style="margin:0 0 0.5rem">Say something like:</p>
              <p style="margin:0;color:var(--club-gold,#ffd54a)">
                “Let’s see who got it right…”
              </p>
              <p class="muted" style="margin:0.65rem 0 0;font-weight:600">
                Then hit the button — suspense lights, then thumps. You’ll get the wrong answers
                <em>after</em> we see who’s left.
              </p>
            </div>
            <p class="muted">${r?.eliminated ?? 0} will be going out · ${r?.survived ?? 0} safe (don’t spoil yet)</p>
            <button class="btn-primary big-btn" style="margin-top:0.85rem" data-act="show_results">
              Let’s see who got it right
            </button>
          </div>`;
      } else {
        const stage = state.elimination?.stage;
        const scanning = stage === 'scanning';
        const sting = stage === 'sting';
        main.innerHTML = `
          <div class="card">
            <h2>${scanning ? 'Suspense…' : sting ? 'Thumps…' : 'Lighting outs…'}</h2>
            <p class="muted">${
              scanning
                ? `TV eliminating.mp3 × ${state.elimination?.stingTimes || 1} — wait for the thumps`
                : sting
                  ? `Thump sequence (${state.elimination?.revealedCount || 0} / ${state.elimination?.wrongIds?.length || 0})`
                  : `Lighting out ${state.elimination?.revealedCount || 0} / ${state.elimination?.wrongIds?.length || 0}`
            }</p>
            <p class="muted" style="margin-top:0.65rem">
              Hold your roasts — wrong answers show after “who remains.”
            </p>
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

document.querySelector('.host-title')?.addEventListener('click', () => {
  if (testMode) return;
  hostTitleTaps += 1;
  clearTimeout(hostTitleTapTimer);
  hostTitleTapTimer = setTimeout(() => {
    hostTitleTaps = 0;
  }, 1200);
  if (hostTitleTaps >= 5) {
    hostTitleTaps = 0;
    testMode = true;
    try {
      history.replaceState(null, '', `${location.pathname}?test=1`);
    } catch {
      // ignore
    }
    if (state) render();
  }
});

setTimeout(() => {
  if (!state) {
    showBoot(`Still connecting… Is the server running at <code>${location.origin}</code>?`, {
      error: true,
    });
  }
}, 4000);
