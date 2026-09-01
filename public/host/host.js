import { connect, sendAction } from '../shared/ws.js';
import { installErrorHandlers, mountQaWidget, showBoot, hideBoot } from '../shared/boot.js';
import {
  formatMoney,
  normalizeCurrency,
  normalizeCurrencyLabel,
  normalizeMaxJackpot,
  computeStake,
  stakeFromState,
  DEFAULT_CURRENCY_LABEL,
  DEFAULT_MAX_JACKPOT,
} from '../shared/money.js';

installErrorHandlers('host');
mountQaWidget('host');
showBoot('Connecting to server…');

const main = document.getElementById('main');
const statusLine = document.getElementById('statusLine');
const jackpotEl = document.getElementById('jackpot');

let state = null;
let questionFiles = [];
/** @type {{ packId: string, file: string, name?: string }[]} */
let driveImports = [];
let driveImportUi = {
  status: '', // '' | loading | ok | error
  message: '',
};

/** Local host-only pack preview (does not broadcast / advance live game). */
let packPreview = {
  open: false,
  file: null,
  name: null,
  questions: [],
  index: 0,
  loading: false,
  error: null,
  /** 'both' | 'question' | 'solution' */
  imageMode: 'both',
};

/** Secret test mode: /host?test=1 or tap HOST title 5× */
const params = new URLSearchParams(location.search);
let testMode = params.get('test') === '1' || params.get('test') === 'true';
let hostTitleTaps = 0;
let hostTitleTapTimer = null;

function currency() {
  return normalizeCurrency(state?.setup?.currency);
}

function money(n, opts) {
  return formatMoney(n, state?.setup, opts);
}

function stake() {
  return stakeFromState(state);
}

/** Lobby stake preview copy (live joined count; N/A when empty). */
function stakePreviewHtml(playerCount, maxJackpot, setupForFormat) {
  const n = Math.max(0, Number(playerCount) || 0);
  if (n < 1) {
    return `Each player brings <strong>N/A</strong> until someone joins. Stake locks from joined count when you start. Half-pot offers follow the live prize pot.`;
  }
  const amount = computeStake(maxJackpot, n);
  return `Each player brings <strong>${formatMoney(amount, setupForFormat, {
    short: true,
  })}</strong>
          (max jackpot ÷ ${n} player${n === 1 ? '' : 's'}). Stake locks when you start.
          Half-pot offers follow the live prize pot.`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function playerOnline(p) {
  return !!p?.connected;
}

function presenceMark(p) {
  const player =
    p && p.connected === undefined && p.playerId
      ? state.players?.find((x) => x.id === p.playerId) || p
      : p;
  const on = playerOnline(player);
  return `<span class="presence ${on ? 'presence--on' : 'presence--off'}" title="${
    on ? 'Online' : 'Offline'
  }" aria-label="${on ? 'online' : 'offline'}">${on ? '●' : '○'}</span>`;
}

function onlineSummary(players = state?.players || []) {
  const total = players.length;
  const n = players.filter(playerOnline).length;
  return `${n}/${total} online`;
}

const HOST_SNARK = [
  'Let’s put all the ugliness behind us… and focus on the ugliness ahead.',
  'Congratulations to everyone who just donated their stake to the smarter people.',
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
    return true;
  } catch (err) {
    alert(err.message);
    return false;
  }
}

/** Brief “Saved” flash on Save setup (survives re-render until expiry). */
let setupSavedUntil = 0;
let setupSavedTimer = null;

function flashSetupSaved() {
  setupSavedUntil = Date.now() + 2000;
  if (setupSavedTimer) clearTimeout(setupSavedTimer);
  setupSavedTimer = setTimeout(() => {
    setupSavedTimer = null;
    if (state?.phase === 'lobby') render();
  }, 2000);
}

async function loadPacks() {
  try {
    const res = await fetch('/api/question-files');
    const data = await res.json();
    questionFiles = data.files || [];
  } catch {
    questionFiles = ['split-decision.json'];
  }
  try {
    const res = await fetch('/api/packs/drive-imports');
    const data = await res.json();
    driveImports = Array.isArray(data.imports) ? data.imports : [];
  } catch {
    driveImports = [];
  }
}

function isDriveImportedFile(file) {
  if (!file) return false;
  const id = String(file).replace(/\.json$/i, '');
  return driveImports.some((x) => x.packId === id || x.file === file);
}

function selectedPackFile() {
  return (
    document.getElementById('packSelect')?.value ||
    state?.setup?.questionFile ||
    questionFiles[0] ||
    ''
  );
}

function resetPackPreview() {
  packPreview = {
    open: false,
    file: null,
    name: null,
    questions: [],
    index: 0,
    loading: false,
    error: null,
    imageMode: packPreview.imageMode || 'both',
  };
}

async function loadPackPreview(file, { open = true } = {}) {
  if (!file) return;
  packPreview = {
    ...packPreview,
    open,
    file,
    loading: true,
    error: null,
  };
  if (state?.phase === 'lobby') render();
  try {
    const res = await fetch(
      `/api/question-pack?file=${encodeURIComponent(file)}&preview=1`,
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not load pack');
    const questions = Array.isArray(data.questions) ? data.questions : [];
    packPreview = {
      ...packPreview,
      open,
      file,
      name: data.name || file,
      questions,
      index: questions.length
        ? Math.min(Math.max(0, packPreview.index), questions.length - 1)
        : 0,
      loading: false,
      error: questions.length ? null : 'This pack has no questions.',
    };
  } catch (err) {
    packPreview = {
      ...packPreview,
      open,
      file,
      questions: [],
      loading: false,
      error: err.message || 'Could not load pack',
    };
  }
  if (state?.phase === 'lobby') render();
}

function previewImageHtml(src, label) {
  if (!src) {
    return `<div class="preview-img-empty muted">${escapeHtml(label)} — no image</div>`;
  }
  return `<figure class="preview-img">
    <figcaption class="muted">${escapeHtml(label)}</figcaption>
    <img src="${escapeHtml(src)}" alt="" loading="lazy" data-preview-fallback="${escapeHtml(label)}" />
  </figure>`;
}

function renderPackPreviewCard() {
  const file = packPreview.open
    ? packPreview.file || selectedPackFile()
    : selectedPackFile();
  const { open, loading, error, questions, index, imageMode, name } = packPreview;

  if (!open) {
    return `
      <div class="card" id="packPreviewCard">
        <h2>Preview pack</h2>
        <p class="muted" style="margin:0 0 0.65rem">
          Step through all questions &amp; answers for the selected pack — host only, does not start the game or change the TV.
        </p>
        <button type="button" class="btn-ghost" id="openPackPreview" ${file ? '' : 'disabled'}>
          Preview questions
        </button>
      </div>`;
  }

  const safeIndex =
    questions.length > 0
      ? Math.min(Math.max(0, index), questions.length - 1)
      : 0;
  const q = !loading && !error && questions.length ? questions[safeIndex] : null;
  const total = questions.length;
  const letters = 'ABCDEF'.split('');
  const choices = Array.isArray(q?.choices) ? q.choices : [];
  const accepted = Array.isArray(q?.accepted) ? q.accepted : [];
  const answerType = q?.answerType || q?.input || q?.mode || 'text';

  let body = '';
  if (loading) {
    body = `<p class="muted">Loading ${escapeHtml(file || 'pack')}…</p>`;
  } else if (error) {
    body = `<p class="muted" style="color:var(--club-danger,#ff8a96)">${escapeHtml(error)}</p>`;
  } else if (!q) {
    body = `<p class="muted">No questions in this pack.</p>`;
  } else {
    const choicesHtml = choices.length
      ? `<ul class="preview-choices">
          ${choices
            .map(
              (c, i) =>
                `<li><span class="preview-letter">${letters[i] || i + 1}</span> ${escapeHtml(c)}</li>`,
            )
            .join('')}
        </ul>`
      : `<p class="muted" style="margin:0">No labeled choices (letter / free-text mode).</p>`;

    const imagesHtml =
      imageMode === 'question'
        ? previewImageHtml(q.image, 'Question')
        : imageMode === 'solution'
          ? previewImageHtml(q.solutionImage, 'Solution')
          : `<div class="preview-imgs">
              ${previewImageHtml(q.image, 'Question')}
              ${previewImageHtml(q.solutionImage, 'Solution')}
            </div>`;

    body = `
      <div class="preview-nav row">
        <button type="button" class="btn-ghost" id="previewPrev" ${safeIndex <= 0 ? 'disabled' : ''}>Prev</button>
        <div class="preview-pos muted">${safeIndex + 1} / ${total}</div>
        <button type="button" class="btn-ghost" id="previewNext" ${safeIndex >= total - 1 ? 'disabled' : ''}>Next</button>
      </div>
      <div class="preview-q">
        <div class="preview-meta">
          <span class="badge">${escapeHtml(String(q.percent ?? '—'))}%</span>
          <span class="muted">Type: <strong>${escapeHtml(String(answerType))}</strong></span>
        </div>
        <p class="preview-prompt">${escapeHtml(q.prompt || '(no prompt)')}</p>
        <div class="preview-block">
          <div class="muted preview-label">Choices</div>
          ${choicesHtml}
        </div>
        <div class="preview-block">
          <div class="muted preview-label">Accepted answers</div>
          <p class="preview-accepted">${
            accepted.length
              ? accepted.map(escapeHtml).join(' · ')
              : '<span class="muted">None listed</span>'
          }</p>
        </div>
        <div class="preview-block">
          <div class="muted preview-label">Explanation</div>
          <p class="preview-explanation">${
            q.explanation
              ? escapeHtml(q.explanation)
              : '<span class="muted">No explanation</span>'
          }</p>
        </div>
        <div class="preview-block">
          <div class="row preview-img-toggle">
            <button type="button" class="btn-ghost ${imageMode === 'both' ? 'is-active' : ''}" data-preview-img="both">Both</button>
            <button type="button" class="btn-ghost ${imageMode === 'question' ? 'is-active' : ''}" data-preview-img="question">Question</button>
            <button type="button" class="btn-ghost ${imageMode === 'solution' ? 'is-active' : ''}" data-preview-img="solution">Solution</button>
          </div>
          ${imagesHtml}
        </div>
      </div>`;
  }

  return `
    <div class="card" id="packPreviewCard">
      <h2>Preview pack</h2>
      <p class="muted" style="margin:0 0 0.65rem">
        ${escapeHtml(name || file || 'Pack')} · host only — does not affect the live game or TV.
      </p>
      ${body}
      <button type="button" class="btn-ghost" id="closePackPreview" style="margin-top:0.65rem">Close preview</button>
    </div>`;
}

function lockedCount() {
  return Object.values(state.answers || {}).filter((a) => a.locked).length;
}

function activePlayers() {
  return (state.players || []).filter((p) => p.status === 'active');
}

/** Keeps question image mounted — only refresh countdown / locks / live list. */
let questionViewKey = '';

function answeringSeconds() {
  if (!state?.timerEndsAt) return null;
  return Math.max(0, Math.ceil((state.timerEndsAt - Date.now()) / 1000));
}

function questionViewKeyFor(s) {
  const q = s?.currentQuestion;
  return `${s?.phase}:${s?.questionIndex}:${q?.image || ''}:${q?.percent ?? ''}`;
}

function liveAnswerRowsHtml() {
  const active = activePlayers();
  return active
    .map((p) => {
      const a = state.answers[p.id];
      const forced =
        a?.forceCorrect === true
          ? ' · forced ✓'
          : a?.forceWrong === true
            ? ' · forced ✗'
            : '';
      return `<li>
        <div class="name">${presenceMark(p)} ${escapeHtml(p.name)}${escapeHtml(forced)}</div>
        <div class="text">${
          a?.locked ? (a.usedPass ? '(PASS)' : escapeHtml(a.text || '—')) : '…thinking'
        }</div>
        ${
          a?.locked && !a.usedPass
            ? `<div style="display:flex;gap:0.4rem;margin-top:0.35rem;flex-wrap:wrap">
                <button type="button" class="btn-ghost" style="padding:0.3rem 0.55rem;font-size:0.75rem" data-override="${escapeHtml(p.id)}" data-correct="1">Count correct</button>
                <button type="button" class="btn-ghost" style="padding:0.3rem 0.55rem;font-size:0.75rem;opacity:0.7" data-override="${escapeHtml(p.id)}" data-correct="0">Force wrong</button>
              </div>`
            : ''
        }
      </li>`;
    })
    .join('');
}

function updateAnsweringOnly() {
  if (!state || state.phase !== 'answering') return false;
  const meta = document.getElementById('hostAnsweringMeta');
  const list = document.getElementById('hostLiveAnswers');
  if (!meta || !list) return false;

  const secs = answeringSeconds();
  const active = activePlayers();
  meta.textContent = `${lockedCount()} / ${active.length} locked · ${secs ?? '—'}s`;
  list.innerHTML = liveAnswerRowsHtml();
  return true;
}

function renderLobby() {
  const players = state.players || [];
  main.innerHTML = `
    <div class="card">
      <h2>Lobby · Code ${escapeHtml(state.joinCode)}</h2>
      <p class="muted">${players.length} joined · ${onlineSummary(players)} · ${state.lobbyOpen ? 'open' : 'closed'} · Display ${state.displayConnected ? '✓' : '✗'}</p>
      <div class="stack" style="margin-top:0.75rem">
        <div class="row">
          <button class="btn-ghost" data-act="close_lobby" ${state.lobbyOpen ? '' : 'disabled'}>Close join</button>
          <button class="btn-ghost" data-act="reopen_lobby" ${state.lobbyOpen ? 'disabled' : ''}>Reopen join</button>
        </div>
        <ul class="player-list">
          ${players
            .map(
              (p) => `<li><span class="player-list__name">${presenceMark(p)} ${escapeHtml(p.name)}</span>
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
        <div class="drive-import">
          <label class="field">Load from Google Drive
            <input id="driveUrlInput" type="url" inputmode="url" autocomplete="off"
              placeholder="Public folder, zip, or JSON share link" />
          </label>
          <div class="row" style="gap:0.5rem;flex-wrap:wrap">
            <button type="button" class="btn-ghost" id="importDriveBtn"
              ${driveImportUi.status === 'loading' ? 'disabled' : ''}>
              ${driveImportUi.status === 'loading' ? 'Importing…' : 'Import'}
            </button>
            ${
              isDriveImportedFile(state.setup.questionFile)
                ? `<button type="button" class="btn-danger" id="clearDriveBtn"
                    ${driveImportUi.status === 'loading' ? 'disabled' : ''}>
                    Clear Drive pack
                  </button>`
                : ''
            }
          </div>
          <p class="muted drive-import-status" id="driveImportStatus" style="margin:0;font-size:0.85rem;${
            driveImportUi.status === 'error'
              ? 'color:#ff8a80'
              : driveImportUi.status === 'ok'
                ? 'color:#a5d6a7'
                : ''
          }">${escapeHtml(driveImportUi.message || 'Anyone-with-the-link zip (JSON + images), JSON file, or folder (needs API key on server).')}</p>
        </div>
        <label class="field">Answer seconds
          <input id="secsInput" type="number" min="10" max="120" value="${state.setup.answerSeconds || 30}" />
        </label>
        <label class="field">Currency display
          <select id="currencySelect">
            <option value="points" ${currency() === 'points' ? 'selected' : ''}>Points</option>
            <option value="dollars" ${currency() === 'dollars' ? 'selected' : ''}>Dollars</option>
            <option value="custom" ${currency() === 'custom' ? 'selected' : ''}>Custom unit</option>
          </select>
        </label>
        <label class="field" id="currencyLabelField" style="${currency() === 'custom' ? '' : 'display:none'}">Unit name
          <input id="currencyLabelInput" type="text" maxlength="32"
            value="${escapeHtml(normalizeCurrencyLabel(state.setup.currencyLabel))}"
            placeholder="${DEFAULT_CURRENCY_LABEL}" />
        </label>
        <label class="field">Max jackpot
          <input id="maxJackpotInput" type="number" min="1" max="1000000000" step="1"
            value="${normalizeMaxJackpot(state.setup.maxJackpot)}" />
        </label>
        <p class="muted" id="stakePreview" style="margin:0;font-size:0.85rem">
          ${stakePreviewHtml(players.length, normalizeMaxJackpot(state.setup.maxJackpot), state.setup)}
        </p>
        <label class="field">Master volume (0–1)
          <input id="volInput" type="number" min="0" max="1" step="0.05" value="${state.setup.masterVolume ?? 0.7}" />
        </label>
        <label class="field">Intro music volume (0–1)
          <input id="introVolInput" type="range" min="0" max="1" step="0.05" value="${state.setup.introVolume ?? 0.75}" />
          <span class="muted" id="introVolLabel">${Math.round((state.setup.introVolume ?? 0.75) * 100)}%</span>
        </label>
        <label class="field" style="flex-direction:row;align-items:center;gap:0.5rem">
          <input id="fastFinish" type="checkbox" ${state.setup.fastFinishWhenAllLocked ? 'checked' : ''} />
          Fast finish when everyone locks (cut timer to ~3s)
        </label>
        <label class="field" style="flex-direction:row;align-items:center;gap:0.5rem">
          <input id="skipIntro" type="checkbox" ${state.setup.skipIntro ? 'checked' : ''} />
          Skip intro
        </label>
        ${
          Date.now() < setupSavedUntil
            ? `<button class="btn-ghost setup-saved" id="saveSetup" disabled>Saved</button>`
            : `<button class="btn-ghost" id="saveSetup">Save setup</button>`
        }
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
    ${renderPackPreviewCard()}
  `;
}

function renderIntro() {
  const introPct = Math.round((state.setup?.introVolume ?? 0.75) * 100);
  main.innerHTML = `
    <div class="card">
      <h2>Intro</h2>
      <p class="muted">${state.players.length} players ready</p>
      <p style="margin:0.65rem 0 0;font-weight:700;line-height:1.4">
        Intro music is at <span style="color:var(--club-gold,#ffd54a)">${introPct}%</span> — talk about the game, then begin.
      </p>
      <button class="btn-primary big-btn" style="margin-top:0.85rem" data-act="skip_intro">Begin questions</button>
    </div>
    <button class="btn-danger" data-act="reset_lobby">Reset to lobby</button>
  `;
}

function renderPassBriefing() {
  const active = activePlayers();
  main.innerHTML = `
    <div class="card">
      <h2>Passes unlocked · 50%</h2>
      <div class="host-script" style="margin:0.75rem 0;padding:0.85rem 1rem;border-radius:12px;background:rgba(255,213,74,0.1);border:1px solid rgba(255,213,74,0.4);font-weight:700;line-height:1.45">
        <p style="margin:0 0 0.65rem">Script:</p>
        <p style="margin:0 0 0.5rem">
          “Everyone still in just earned a <span style="color:var(--club-gold,#ffd54a)">PASS</span>.”
        </p>
        <p style="margin:0 0 0.5rem">
          “One free escape on a later question. Use it and you’re safe — but your ${money(stake())} goes into the prize pot.”
        </p>
        <p style="margin:0">
          “You can’t use it on the 1% question. Hold it or burn it wisely.”
        </p>
      </div>
      <img
        class="pass-example-art"
        src="/images/pass-available-example.png"
        alt="USE PASS button example shown on player phones"
      />
      <p class="muted" style="margin-top:0.5rem">What players see on their phones when they can use a pass</p>
      <p class="muted">${active.length} players now have a pass · TV is on the pass hold</p>
      <button class="btn-primary big-btn" style="margin-top:0.85rem" data-act="resolve_pass_briefing">
        Continue to 50% question
      </button>
    </div>
    <button class="btn-danger" data-act="reset_lobby">Reset to lobby</button>
  `;
}

function renderQuestion() {
  const q = state.currentQuestion;
  const active = activePlayers();
  const answering = state.phase === 'answering';
  const secs = answeringSeconds();
  const isOnePercent = q?.percent === 1 || state.questionIndex === 14;
  const key = questionViewKeyFor(state);

  // Answering: keep the question image mounted; only patch live bits
  if (answering && questionViewKey === key && updateAnsweringOnly()) {
    return;
  }
  questionViewKey = key;

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
      <p class="muted" style="margin-top:0.65rem">Type: <strong>${escapeHtml(q?.answerType || 'text')}</strong>${
        q?.fuzzy ? ' · fuzzy spelling' : ''
      } · Accepted: ${(q?.accepted || []).map(escapeHtml).join(' · ')}</p>
      ${
        answering
          ? `<p class="muted" id="hostAnsweringMeta">${lockedCount()} / ${active.length} locked · ${secs ?? '—'}s</p>`
          : ''
      }
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
        ? `<div class="card"><h2>Live answers · umpire · ${onlineSummary(active)}</h2>
            <p class="muted" style="margin:0 0 0.65rem">You see every lock. Mark correct if the server is being picky.</p>
            <ul class="answer-list" id="hostLiveAnswers">
              ${liveAnswerRowsHtml()}
            </ul></div>`
        : `<div class="card"><h2>Still in · ${onlineSummary(active)}</h2>
            <ul class="answer-list">
              ${active
                .map((p) => `<li><div class="name">${presenceMark(p)} ${escapeHtml(p.name)}</div></li>`)
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

/** Host roast sheet — wrong answers first; umpire can force correct. */
function renderRoastLists() {
  const r = state.reveal;
  const results = r?.results || [];
  const wrongs = results.filter((row) => !row.correct);
  const safes = results.filter((row) => row.correct);
  const accepted = (r?.accepted || []).slice(0, 6).join(' · ') || '—';
  const canUmpire = !!r?.results?.length;

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
                    <div class="name bad">${presenceMark(row)} ${escapeHtml(row.name)}</div>
                    <div class="roast-answer">${
                      row.timedOut || !row.text
                        ? '<em>(no answer)</em>'
                        : `“${escapeHtml(row.text)}”`
                    }</div>
                    ${
                      canUmpire && !row.usedPass
                        ? `<button type="button" class="btn-ghost" style="margin-top:0.35rem;padding:0.35rem 0.6rem;font-size:0.8rem" data-override="${escapeHtml(row.playerId)}" data-correct="1">
                            Umpire: count as correct
                          </button>`
                        : ''
                    }
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
                    <div class="name ok">${presenceMark(row)} ${escapeHtml(row.name)} ✓</div>
                    <div class="text">${escapeHtml(row.text || '—')}</div>
                    ${
                      canUmpire && !row.usedPass
                        ? `<button type="button" class="btn-ghost" style="margin-top:0.35rem;padding:0.35rem 0.6rem;font-size:0.75rem;opacity:0.75" data-override="${escapeHtml(row.playerId)}" data-correct="0">
                            Umpire: mark wrong
                          </button>`
                        : ''
                    }
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
              <div class="text">${d === true ? `LEAVING with ${money(stake(), { short: true })}` : d === false ? 'STAYING' : '…deciding'}</div></li>`;
          })
          .join('')}
      </ul>
      <button class="btn-primary big-btn" style="margin-top:0.85rem" data-act="resolve_cashout">Lock decisions & continue</button>
    </div>
  `;
}

function renderFinal() {
  const active = activePlayers();
  const awaiting = !!state._awaitingOnePercent;
  const took = (state.players || []).filter((p) => p.status === 'took10k');
  const offer = Math.floor((Number(state.jackpot) || 0) / 2);
  const offerLabel = money(awaiting ? state.finalOffer ?? offer : offer);
  main.innerHTML = `
    <div class="card">
      <h2>Finalists · half pot or 1%?</h2>
      <p class="muted">${active.length} still in · pot ${money(state.jackpot)} · offer ${offerLabel}</p>
      ${
        awaiting
          ? `<p class="muted">Decisions locked. ${took.length ? `${took.length} took the offer. ` : ''}Start the 1% when you’re ready.</p>
             <ul class="answer-list">
               ${active
                 .map((p) => `<li><div class="name ok">${escapeHtml(p.name)}</div><div class="text">GOING FOR 1%</div></li>`)
                 .join('')}
               ${took
                 .map((p) => `<li><div class="name">${escapeHtml(p.name)}</div><div class="text">Took ${money(p.winnings)}</div></li>`)
                 .join('')}
             </ul>
             <button class="btn-primary big-btn" style="margin-top:0.85rem" data-act="start_one_percent">
               Start 1% question
             </button>`
          : `<p class="muted">Offer is half the pot (${offerLabel}), split if more than one takes it. Lock — then you start the 1%.</p>
             <ul class="answer-list">
               ${active
                 .map((p) => {
                   const d = state.finalDecisions?.[p.id];
                   return `<li><div class="name">${escapeHtml(p.name)}</div>
                     <div class="text">${d === true ? `TAKE OFFER` : d === false ? 'GO FOR 1%' : '…deciding'}</div></li>`;
                 })
                 .join('')}
             </ul>
             <button class="btn-primary big-btn" style="margin-top:0.85rem" data-act="resolve_final">
               Lock decisions
             </button>`
      }
    </div>
  `;
}

function renderSolo() {
  const solo = activePlayers()[0];
  const awaiting = state.soloDecision === 'one_percent' || state._awaitingOnePercent;
  const offer = money(Math.floor((Number(state.jackpot) || 0) / 2));
  main.innerHTML = `
    <div class="card">
      <h2>Solo offer</h2>
      <p><strong>${escapeHtml(solo?.name || '')}</strong> is alone.</p>
      <p class="muted">Pot ${money(state.jackpot)} · offer ${offer} (half)</p>
      ${
        awaiting
          ? `<p class="muted" style="margin-top:0.75rem">They chose the 1%. Start when you’re ready to read it.</p>
             <button class="btn-primary big-btn" style="margin-top:0.85rem" data-act="start_one_percent">
               Start 1% question
             </button>`
          : `<div class="stack" style="margin-top:0.85rem">
               <button class="btn-gold big-btn" data-solo="1">Take ${offer}</button>
               <button class="btn-primary big-btn" data-solo="0">Choose 1% (host starts question)</button>
             </div>`
      }
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
  statusLine.textContent = `Phase: ${state.phase} · ${onlineSummary()} · TV ${state.displayConnected ? '✓' : '✗'}`;

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
              <p style="margin:0 0 0.5rem">Check answers first — umpire if needed — then:</p>
              <p style="margin:0;color:var(--club-gold,#ffd54a)">
                “Let’s see who got it right…”
              </p>
            </div>
            ${renderRoastLists()}
            <p class="muted" style="margin-top:0.75rem">${r?.eliminated ?? 0} marked out · ${r?.survived ?? 0} safe</p>
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

main.addEventListener('input', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  if (t.id === 'introVolInput') {
    const label = document.getElementById('introVolLabel');
    if (label) label.textContent = `${Math.round(Number(t.value || 0) * 100)}%`;
  }
  if (t.id === 'maxJackpotInput' || t.id === 'currencySelect' || t.id === 'currencyLabelInput') {
    updateStakePreview();
  }
});

function updateStakePreview() {
  const preview = document.getElementById('stakePreview');
  if (!preview || !state) return;
  const pot = normalizeMaxJackpot(
    document.getElementById('maxJackpotInput')?.value || state.setup.maxJackpot,
  );
  const setupForFormat = {
    ...state.setup,
    currency: normalizeCurrency(
      document.getElementById('currencySelect')?.value || state.setup.currency,
    ),
    currencyLabel: normalizeCurrencyLabel(
      document.getElementById('currencyLabelInput')?.value || state.setup.currencyLabel,
    ),
  };
  preview.innerHTML = stakePreviewHtml(state.players?.length || 0, pot, setupForFormat);
}

main.addEventListener('change', async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;

  if (t.id === 'currencySelect') {
    const field = document.getElementById('currencyLabelField');
    if (field) field.style.display = t.value === 'custom' ? '' : 'none';
    updateStakePreview();
    return;
  }

  if (t.id !== 'packSelect') return;
  const file = t.value;
  if (!file) return;
  if (packPreview.open) {
    packPreview.index = 0;
    await loadPackPreview(file, { open: true });
  } else if (packPreview.file && packPreview.file !== file) {
    resetPackPreview();
  }
  try {
    const res = await fetch(`/api/question-pack?file=${encodeURIComponent(file)}`);
    if (!res.ok) return;
    const data = await res.json();
    const c = data.settings?.currency;
    if (c !== 'dollars' && c !== 'points') return;
    const sel = document.getElementById('currencySelect');
    if (sel) sel.value = c;
    const labelField = document.getElementById('currencyLabelField');
    if (labelField) labelField.style.display = 'none';
    await act('update_setup', { setup: { questionFile: file, currency: c } });
  } catch {
    // ignore
  }
});

main.addEventListener(
  'error',
  (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    const label = img.getAttribute('data-preview-fallback');
    if (!label) return;
    const empty = document.createElement('div');
    empty.className = 'preview-img-empty muted';
    empty.textContent = `${label} — missing`;
    img.replaceWith(empty);
  },
  true,
);

main.addEventListener('click', async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;

  if (t.id === 'openPackPreview') {
    const file = selectedPackFile();
    if (!file) return;
    packPreview.index = 0;
    await loadPackPreview(file, { open: true });
    return;
  }

  if (t.id === 'importDriveBtn') {
    const input = document.getElementById('driveUrlInput');
    const url = (input instanceof HTMLInputElement ? input.value : '').trim();
    if (!url) {
      driveImportUi = { status: 'error', message: 'Paste a public Google Drive URL first.' };
      if (state?.phase === 'lobby') render();
      return;
    }
    driveImportUi = { status: 'loading', message: 'Downloading from Drive…' };
    if (state?.phase === 'lobby') render();
    // Restore URL after re-render
    const again = document.getElementById('driveUrlInput');
    if (again instanceof HTMLInputElement) again.value = url;
    try {
      const res = await fetch('/api/packs/import-drive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Import failed');
      questionFiles = data.files || questionFiles;
      driveImports = Array.isArray(data.imports) ? data.imports : driveImports;
      const file = data.file;
      driveImportUi = {
        status: 'ok',
        message: `Imported “${data.name || file}” · ${data.questionCount ?? '?'} questions · ${data.imageCount ?? 0} images`,
      };
      await act('update_setup', { setup: { questionFile: file } });
      packPreview.index = 0;
      if (packPreview.open) await loadPackPreview(file, { open: true });
      if (state?.phase === 'lobby') render();
      const sel = document.getElementById('packSelect');
      if (sel) sel.value = file;
      const urlEl = document.getElementById('driveUrlInput');
      if (urlEl instanceof HTMLInputElement) urlEl.value = url;
    } catch (err) {
      driveImportUi = {
        status: 'error',
        message: err.message || 'Import failed',
      };
      if (state?.phase === 'lobby') render();
      const urlEl = document.getElementById('driveUrlInput');
      if (urlEl instanceof HTMLInputElement) urlEl.value = url;
    }
    return;
  }

  if (t.id === 'clearDriveBtn') {
    const file = selectedPackFile() || state?.setup?.questionFile;
    if (!file || !isDriveImportedFile(file)) return;
    driveImportUi = { status: 'loading', message: 'Clearing Drive pack…' };
    if (state?.phase === 'lobby') render();
    try {
      const res = await fetch('/api/packs/clear-drive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Clear failed');
      questionFiles = data.files || questionFiles;
      driveImports = Array.isArray(data.imports) ? data.imports : [];
      const nextFile = data.questionFile || questionFiles[0] || '';
      driveImportUi = {
        status: 'ok',
        message: `Cleared ${file}. Selected ${nextFile || 'none'}.`,
      };
      resetPackPreview();
      if (state?.phase === 'lobby') render();
    } catch (err) {
      driveImportUi = {
        status: 'error',
        message: err.message || 'Clear failed',
      };
      if (state?.phase === 'lobby') render();
    }
    return;
  }

  if (t.id === 'closePackPreview') {
    packPreview.open = false;
    if (state?.phase === 'lobby') render();
    return;
  }

  if (t.id === 'previewPrev') {
    if (packPreview.index > 0) {
      packPreview.index -= 1;
      if (state?.phase === 'lobby') render();
    }
    return;
  }

  if (t.id === 'previewNext') {
    if (packPreview.index < packPreview.questions.length - 1) {
      packPreview.index += 1;
      if (state?.phase === 'lobby') render();
    }
    return;
  }

  const imgMode = t.getAttribute('data-preview-img');
  if (imgMode === 'both' || imgMode === 'question' || imgMode === 'solution') {
    packPreview.imageMode = imgMode;
    if (state?.phase === 'lobby') render();
    return;
  }

  if (t.id === 'saveSetup') {
    if (Date.now() < setupSavedUntil) return;
    const ok = await act('update_setup', {
      setup: {
        questionFile: document.getElementById('packSelect')?.value,
        answerSeconds: Number(document.getElementById('secsInput')?.value || 30),
        masterVolume: Number(document.getElementById('volInput')?.value || 0.7),
        introVolume: Number(document.getElementById('introVolInput')?.value || 0.75),
        fastFinishWhenAllLocked: !!document.getElementById('fastFinish')?.checked,
        skipIntro: !!document.getElementById('skipIntro')?.checked,
        currency: normalizeCurrency(document.getElementById('currencySelect')?.value),
        currencyLabel: normalizeCurrencyLabel(
          document.getElementById('currencyLabelInput')?.value || DEFAULT_CURRENCY_LABEL,
        ),
        maxJackpot: normalizeMaxJackpot(
          document.getElementById('maxJackpotInput')?.value || DEFAULT_MAX_JACKPOT,
        ),
      },
    });
    if (ok) {
      flashSetupSaved();
      if (state?.phase === 'lobby') render();
    }
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
  if (next.phase !== 'answering' && next.phase !== 'question') {
    questionViewKey = '';
  }
  render();
  if (tick) clearInterval(tick);
  if (next.phase === 'answering') {
    tick = setInterval(() => {
      jackpotEl.textContent = money(state.jackpot);
      statusLine.textContent = `Phase: ${state.phase} · ${onlineSummary()} · TV ${state.displayConnected ? '✓' : '✗'}`;
      if (!updateAnsweringOnly()) render();
    }, 250);
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
