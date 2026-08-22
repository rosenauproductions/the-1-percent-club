/** @typedef {'lobby'|'intro'|'question'|'answering'|'eliminating'|'eliminated_count'|'left_count'|'answer_reveal'|'prize_pot'|'reveal'|'cashout_offer'|'final_choice'|'solo_offer'|'finale'|'game_end'} Phase */
/** @typedef {'active'|'out'|'cashed'|'took10k'|'winner'} PlayerStatus */

export const STAKE = 1000;
export const TEN_K = 10000;
export const ANSWER_SECONDS = 30;
export const MAX_PLAYERS = 100;
export const PERCENTAGES = [90, 80, 70, 60, 50, 45, 40, 35, 30, 25, 20, 15, 10, 5, 1];
/** Index of the 50% question — passes granted when entering this question */
export const PASS_QUESTION_INDEX = 4;
/** Index of the 30% question — cashout offered before this question */
export const CASHOUT_QUESTION_INDEX = 8;
/** Index of the 5% question — final choice after reveal */
export const FIVE_PERCENT_INDEX = 13;
/** Index of the 1% question */
export const ONE_PERCENT_INDEX = 14;

const JOIN_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function createJoinCode() {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += JOIN_CHARS[Math.floor(Math.random() * JOIN_CHARS.length)];
  }
  return code;
}

export function makePlayerId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** @typedef {'text'|'number'|'letter'|'ab'|'abc'|'abcd'} AnswerType */

const LETTER_TYPE_COUNT = { ab: 2, abc: 3, abcd: 4 };

export function normalizeAnswerType(raw, choices = []) {
  const s = String(raw ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z]/g, '');
  if (
    s === 'text' ||
    s === 'number' ||
    s === 'letter' ||
    s === 'ab' ||
    s === 'abc' ||
    s === 'abcd'
  ) {
    return s;
  }
  const n = Array.isArray(choices) ? choices.length : 0;
  if (n === 2) return 'ab';
  if (n === 4) return 'abcd';
  if (n >= 3) return 'abc';
  if (n > 0) return 'abc';
  return 'text';
}

/** Letter labels for AB / ABC / ABCD pads. */
export function lettersForAnswerType(answerType) {
  const n = LETTER_TYPE_COUNT[answerType] || 0;
  return Array.from({ length: n }, (_, i) => String.fromCharCode(65 + i));
}

export function normalizeAnswer(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/,/g, '') // allow 1,776 → 1776
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip "option c", "c)", "c." → "c" for letter answers. */
function canonicalizeAnswer(text) {
  let n = normalizeAnswer(text);
  if (!n) return '';
  n = n.replace(/^option\s+/, '');
  n = n.replace(/^([a-d])(?:\s*[).:\-]|\s+)/, '$1');
  n = n.replace(/\s+/g, ' ').trim();
  return n;
}

function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const row = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return row[n];
}

function fuzzyCloseEnough(given, accepted) {
  if (!given || !accepted) return false;
  if (given === accepted) return true;
  const maxLen = Math.max(given.length, accepted.length);
  if (maxLen < 5) return false;
  const allow = maxLen <= 7 ? 1 : maxLen <= 11 ? 2 : 3;
  return editDistance(given, accepted) <= allow;
}

/** Expand accepted aliases (letters, option labels, matching choice text only). */
export function expandAcceptedAnswers(accepted, choices = [], answerType = 'text') {
  const out = new Set();
  const add = (v) => {
    const s = String(v ?? '').trim();
    if (s) out.add(s);
  };
  const list = [...(accepted ?? [])];
  for (const a of list) add(a);

  const acceptedNorm = list.map(canonicalizeAnswer).filter(Boolean);
  const letterPads = lettersForAnswerType(answerType);
  const choiceList =
    choices?.length > 0
      ? choices
      : letterPads.length
        ? letterPads
        : [];

  choiceList.forEach((text, idx) => {
    const L = String.fromCharCode(65 + idx);
    if (letterPads.length && idx >= letterPads.length) return;
    const textN = canonicalizeAnswer(text);
    const letterOk = acceptedNorm.includes(L.toLowerCase());
    const textOk =
      !!textN &&
      textN !== L.toLowerCase() &&
      acceptedNorm.some(
        (n) =>
          n === textN ||
          (n.length >= 3 && textN.length >= 3 && (n.includes(textN) || textN.includes(n))),
      );
    if (letterOk || textOk) {
      add(L);
      add(L.toLowerCase());
      add(`option ${L}`);
      add(`option ${L.toLowerCase()}`);
      if (textN && textN !== L.toLowerCase()) add(text);
    }
  });

  for (const a of [...out]) {
    const n = canonicalizeAnswer(a);
    if (/^[a-d]$/.test(n)) {
      const L = n.toUpperCase();
      add(L);
      add(L.toLowerCase());
      add(`option ${L}`);
      add(`option ${L.toLowerCase()}`);
      add(`${L})`);
    }
  }
  return [...out];
}

export function answersMatch(given, acceptedList, opts = {}) {
  const answerType = opts.answerType || 'text';
  const fuzzy = opts.fuzzy === true;
  const n = canonicalizeAnswer(given);
  if (!n) return false;
  const accepted = (acceptedList ?? []).map(canonicalizeAnswer).filter(Boolean);
  if (!accepted.length) return false;

  if (answerType === 'letter') {
    const letter = n
      .replace(/^the\s+/, '')
      .replace(/^letter\s+/, '')
      .replace(/\s+/g, '');
    const g = letter.length === 1 ? letter : letter.slice(0, 1);
    return accepted.some((a) => {
      const al = a.replace(/^the\s+/, '').replace(/^letter\s+/, '').replace(/\s+/g, '');
      return al === g || al === letter;
    });
  }

  if (accepted.some((a) => a === n)) return true;

  // Digits-only compare (commas already stripped in normalize)
  const digits = (s) => s.replace(/\s+/g, '');
  const gd = digits(n);
  if (/^\d+$/.test(gd) && accepted.some((a) => digits(a) === gd)) return true;

  if (fuzzy) {
    return accepted.some((a) => a.length >= 5 && fuzzyCloseEnough(n.replace(/\s+/g, ''), a.replace(/\s+/g, '')));
  }

  // Longer free-text: contain match (not for short letter keys)
  if (n.length >= 4) {
    return accepted.some(
      (a) => a.length >= 4 && (a.includes(n) || n.includes(a)),
    );
  }
  return false;
}

function normalizeImageTransform(t) {
  if (!t || typeof t !== 'object') return null;
  const scale = Number(t.scale);
  const x = Number(t.x);
  const y = Number(t.y);
  if (![scale, x, y].every((n) => Number.isFinite(n))) return null;
  return {
    scale: Math.max(0.2, Math.min(3, scale)),
    x: Math.max(-200, Math.min(200, x)),
    y: Math.max(-200, Math.min(200, y)),
  };
}

function defaultSetup() {
  return {
    questionFile: 'split-decision.json',
    answerSeconds: ANSWER_SECONDS,
    masterVolume: 0.7,
    skipIntro: false,
    sounds: {},
  };
}

/** Estimated length of one eliminating.mp3 play (server fallback timer). */
export const ELIM_STING_MS = 900;
/** Estimated length of thump.mp3 (TV + phones before each blue light). */
export const THUMP_MS = 1200;
/** Default / legacy gap after a blue light (prefer thumpGapMs). */
export const ELIM_REVEAL_GAP_MS = 1000;

/**
 * Silence after lighting a wrong player before the next thump starts.
 * First 2 outs → 1s; next 3 → 0.75s; rest → 0.5s.
 * @param {number} revealedCount how many wrongs have been lit so far
 */
export function thumpGapMs(revealedCount) {
  const n = Number(revealedCount) || 0;
  if (n <= 2) return 1000;
  if (n <= 5) return 750;
  return 500;
}

/** How long to hold the "X left" board before prize pot */
export const LEFT_COUNT_MS = 3200;
/** How long to hold the prize-pot spectacle before the answer reveal */
export const PRIZE_POT_MS = 4500;

export function createInitialState() {
  return {
    phase: 'lobby',
    setup: defaultSetup(),
    joinCode: createJoinCode(),
    lobbyOpen: true,
    displayConnected: false,
    hostConnected: false,
    playerConnections: 0,
    players: [],
    jackpot: 0,
    questionIndex: -1,
    questions: [],
    packName: null,
    packSettings: { hidePrompt: false },
    currentQuestion: null,
    timerEndsAt: null,
    answeringStartedAt: null,
    answers: {},
    reveal: null,
    elimination: null,
    cashoutDecisions: {},
    finalDecisions: {},
    soloDecision: null,
    lastAction: null,
    // TV lobby bed until host starts the game
    soundCue: {
      name: 'interlude',
      at: Date.now(),
      loop: true,
      audience: 'display',
    },
    pendingAfterReveal: null,
  };
}

function cue(state, name, extra = {}) {
  return { ...state, soundCue: { name, at: Date.now(), ...extra } };
}

function actionMeta(state, type, extra = {}) {
  return { ...state, lastAction: { type, at: Date.now(), ...extra } };
}

function activePlayers(state) {
  return state.players.filter((p) => p.status === 'active');
}

function publicPlayers(players) {
  return players.map((p) => ({
    id: p.id,
    name: p.name,
    status: p.status,
    hasPass: p.hasPass,
    usedPass: p.usedPass,
    seat: p.seat,
    winnings: p.winnings,
  }));
}

export function sanitizeStateForClient(state, role, playerId = null) {
  const base = {
    ...state,
    players: publicPlayers(state.players),
    questions: undefined,
  };

  const hideAnswers =
    role !== 'host' &&
    (state.phase === 'answering' || state.phase === 'question');

  if (hideAnswers) {
    const mine = playerId && state.answers[playerId] ? { [playerId]: state.answers[playerId] } : {};
    base.answers = Object.fromEntries(
      Object.entries(mine).map(([id, a]) => [
        id,
        { locked: a.locked, usedPass: a.usedPass, text: a.text ?? '' },
      ]),
    );
    if (base.currentQuestion) {
      base.currentQuestion = {
        ...base.currentQuestion,
        accepted: undefined,
      };
    }
  } else if (
    role !== 'host' &&
    state.phase !== 'reveal' &&
    state.phase !== 'answer_reveal' &&
    state.phase !== 'eliminating' &&
    state.phase !== 'finale' &&
    state.phase !== 'game_end'
  ) {
    if (base.currentQuestion) {
      base.currentQuestion = {
        ...base.currentQuestion,
        accepted: undefined,
        explanation: undefined,
      };
    }
  }

  if (role !== 'host' && base.currentQuestion) {
    base.currentQuestion = {
      ...base.currentQuestion,
      explanation: undefined,
    };
  }

  if (role !== 'host' && base.reveal) {
    base.reveal = {
      ...base.reveal,
      explanation: undefined,
    };
  }

  // During host read (question phase): TV gets the board image, not the text prompt.
  if (role !== 'host' && state.phase === 'question' && base.currentQuestion) {
    const q = state.currentQuestion;
    if (q.image) {
      base.currentQuestion = {
        index: q.index,
        percent: q.percent,
        hidePrompt: true,
        image: q.image,
        imageTransform: q.imageTransform || null,
        promptHidden: false,
        hostReading: true,
      };
    } else {
      base.currentQuestion = {
        index: q.index,
        percent: q.percent,
        promptHidden: true,
      };
    }
  }

  if (role === 'player' && playerId) {
    base.me = publicPlayers(state.players).find((p) => p.id === playerId) ?? null;
    base.myAnswer = state.answers[playerId] ?? null;
  }

  return base;
}

/** Mark every still-active contestant as a 1% Club winner and split the jackpot. */
function awardOnePercentWinners(state) {
  const survivors = state.players.filter((p) => p.status === 'active');
  if (!survivors.length) return state;
  const share = Math.floor(state.jackpot / survivors.length);
  return {
    ...state,
    players: state.players.map((p) => {
      if (p.status !== 'active') return p;
      const keep = !p.stakeInJackpot ? STAKE : 0;
      return { ...p, status: 'winner', winnings: share + keep };
    }),
  };
}

export function applySetup(state, setup) {
  return {
    ...state,
    setup: { ...state.setup, ...setup },
  };
}

export function joinPlayer(state, { name, playerId }) {
  if (state.phase !== 'lobby' || !state.lobbyOpen) {
    throw new Error('Lobby is closed');
  }
  const clean = String(name ?? '').trim().slice(0, 18);
  if (clean.length < 1) throw new Error('Name required');

  if (playerId) {
    const existing = state.players.find((p) => p.id === playerId);
    if (existing) {
      const players = state.players.map((p) =>
        p.id === playerId ? { ...p, name: clean } : p,
      );
      const player = players.find((p) => p.id === playerId);
      return { state: { ...state, players }, player };
    }
  }

  if (state.players.length >= MAX_PLAYERS) {
    throw new Error(`Max ${MAX_PLAYERS} players`);
  }

  const id = playerId || makePlayerId();
  const player = {
    id,
    name: clean,
    status: 'active',
    hasPass: false,
    usedPass: false,
    seat: state.players.length,
    winnings: 0,
    stakeInJackpot: false,
  };

  return {
    state: { ...state, players: [...state.players, player] },
    player,
  };
}

const TEST_BOT_NAMES = ['John', 'Maya', 'Steve', 'Priya', 'Tom'];

/** Lobby-only: seed five bot players for host testing (idempotent). */
export function seedTestPlayers(state) {
  if (state.phase !== 'lobby') throw new Error('Lobby only');
  if (!state.lobbyOpen) throw new Error('Reopen lobby first');

  let next = state;
  for (const name of TEST_BOT_NAMES) {
    const already = next.players.some(
      (p) => p.testBot && p.name.toLowerCase() === name.toLowerCase(),
    );
    if (already) continue;
    if (next.players.length >= MAX_PLAYERS) break;
    const result = joinPlayer(next, { name });
    next = {
      ...result.state,
      players: result.state.players.map((p) =>
        p.id === result.player.id ? { ...p, testBot: true } : p,
      ),
    };
  }
  return actionMeta(next, 'seed_test_players', {
    count: next.players.filter((p) => p.testBot).length,
  });
}

/**
 * Lock in answers for test bots: first bot correct (if possible), rest wrong/funny.
 */
export function applyTestBotAnswers(state) {
  if (state.phase !== 'answering') return state;
  const accepted = state.currentQuestion?.accepted || [];
  const funny = ['fart', 'potato', 'idk', 'blue', '42', 'banana', 'my mom'];
  let next = state;
  const bots = next.players.filter((p) => p.testBot && p.status === 'active');
  bots.forEach((p, i) => {
    if (next.answers[p.id]?.locked) return;
    const text =
      i === 0 && accepted[0]
        ? String(accepted[0])
        : funny[i % funny.length];
    try {
      next = submitAnswer(next, p.id, text);
    } catch {
      // ignore
    }
  });
  return next;
}

export function removePlayer(state, playerId) {
  if (state.phase !== 'lobby') throw new Error('Can only remove in lobby');
  const players = state.players
    .filter((p) => p.id !== playerId)
    .map((p, i) => ({ ...p, seat: i }));
  return { ...state, players };
}

export function closeLobby(state) {
  if (state.players.length < 1) throw new Error('Need at least 1 player');
  return { ...state, lobbyOpen: false };
}

export function reopenLobby(state) {
  if (state.phase !== 'lobby') throw new Error('Not in lobby');
  return { ...state, lobbyOpen: true };
}

export function startGame(state, questions, packName = null, packSettings = null) {
  if (state.players.length < 1) throw new Error('Need at least 1 player');
  if (!Array.isArray(questions) || questions.length < PERCENTAGES.length) {
    throw new Error(`Need ${PERCENTAGES.length} questions in pack`);
  }

  const settings = {
    // Full-screen board packs only for now
    hidePrompt: true,
  };

  const packed = PERCENTAGES.map((pct, i) => {
    const q = questions[i];
    const choices = Array.isArray(q.choices)
      ? q.choices.map((c) => String(c)).filter(Boolean).slice(0, 6)
      : [];
    const answerType = normalizeAnswerType(q.answerType ?? q.input ?? q.mode, choices);
    const fuzzy = q.fuzzy === true;
    const rawAccepted = Array.isArray(q.accepted)
      ? q.accepted
      : Array.isArray(q.answers)
        ? q.answers
        : [q.answer].filter(Boolean);
    const accepted = expandAcceptedAnswers(rawAccepted, choices, answerType);
    return {
      index: i,
      percent: pct,
      prompt: q.prompt ?? q.question,
      hint: q.hint ?? null,
      explanation: q.explanation ? String(q.explanation) : null,
      hidePrompt: true,
      image: q.image || null,
      solutionImage: q.solutionImage || null,
      imageTransform: normalizeImageTransform(q.imageTransform),
      solutionImageTransform: normalizeImageTransform(q.solutionImageTransform),
      answerType,
      fuzzy,
      choices,
      accepted,
    };
  });

  let next = {
    ...state,
    lobbyOpen: false,
    questions: packed,
    packName,
    packSettings: settings,
    jackpot: 0,
    questionIndex: -1,
    currentQuestion: null,
    timerEndsAt: null,
    answers: {},
    reveal: null,
    elimination: null,
    cashoutDecisions: {},
    finalDecisions: {},
    soloDecision: null,
    pendingAfterReveal: null,
    players: state.players.map((p) => ({
      ...p,
      status: 'active',
      hasPass: false,
      usedPass: false,
      winnings: 0,
      stakeInJackpot: false,
    })),
  };

  // Soft loop so the host can talk over the show open before questions.
  next = cue(next, 'intro', { loop: true, volume: 0.2 });
  next = actionMeta(next, 'start_game');
  next.phase = state.setup.skipIntro ? 'question' : 'intro';

  if (next.phase === 'question') {
    return beginQuestion(next, 0);
  }
  return next;
}

export function skipIntro(state) {
  if (state.phase !== 'intro') return state;
  return beginQuestion({ ...state, soundCue: null }, 0);
}

function grantPassesIfNeeded(state, questionIndex) {
  if (questionIndex !== PASS_QUESTION_INDEX) return state;
  return {
    ...cue(state, 'pass'),
    players: state.players.map((p) =>
      p.status === 'active' ? { ...p, hasPass: true } : p,
    ),
  };
}

export function beginQuestion(state, questionIndex) {
  if (questionIndex < 0 || questionIndex >= PERCENTAGES.length) {
    throw new Error('Invalid question index');
  }

  // Cashout must happen before 30% question
  if (
    questionIndex === CASHOUT_QUESTION_INDEX &&
    state.phase !== 'cashout_offer' &&
    !state._cashoutDone
  ) {
    const eligible = activePlayers(state).filter((p) => p.hasPass && !p.usedPass);
    if (eligible.length > 0) {
      return {
        ...state,
        phase: 'cashout_offer',
        cashoutDecisions: {},
        pendingAfterReveal: null,
        questionIndex: questionIndex - 1,
        currentQuestion: null,
        soundCue: { name: 'pass', at: Date.now() },
        _awaitingQuestionIndex: questionIndex,
      };
    }
  }

  let next = grantPassesIfNeeded(state, questionIndex);
  const q = next.questions[questionIndex];

  next = {
    ...next,
    phase: 'question',
    questionIndex,
    currentQuestion: q,
    timerEndsAt: null,
    answeringStartedAt: null,
    answers: {},
    reveal: null,
    elimination: null,
    pendingAfterReveal: null,
    _cashoutDone: questionIndex >= CASHOUT_QUESTION_INDEX ? true : next._cashoutDone,
    _awaitingQuestionIndex: undefined,
  };

  // After intro talk, first-question hold keeps a soft one-shot bed; later holds are silent.
  if (questionIndex === 0) {
    return actionMeta(
      cue(next, 'intro', { loop: false, volume: 0.2 }),
      'begin_question',
      { questionIndex },
    );
  }
  return actionMeta({ ...next, soundCue: null }, 'begin_question', { questionIndex });
}

export function startAnswering(state) {
  if (state.phase !== 'question' && state.phase !== 'answering') {
    throw new Error('Not ready to answer');
  }
  const seconds = state.setup.answerSeconds || ANSWER_SECONDS;
  const now = Date.now();
  return actionMeta(
    cue(
      {
        ...state,
        phase: 'answering',
        answeringStartedAt: now,
        timerEndsAt: now + seconds * 1000,
      },
      'timer',
    ),
    'start_answering',
  );
}

export function submitAnswer(state, playerId, text) {
  if (state.phase !== 'answering') throw new Error('Not accepting answers');
  const player = state.players.find((p) => p.id === playerId);
  if (!player || player.status !== 'active') throw new Error('Not an active player');
  if (state.answers[playerId]?.locked) throw new Error('Already locked in');

  const trimmed = String(text ?? '').trim().slice(0, 80);
  if (!trimmed) throw new Error('Answer required');

  // No lock SFX — question/timer bed keeps playing until the round ends.
  return actionMeta(
    {
      ...state,
      answers: {
        ...state.answers,
        [playerId]: {
          text: trimmed,
          locked: true,
          usedPass: false,
          lockedAt: Date.now(),
        },
      },
    },
    'submit_answer',
    { playerId },
  );
}

export function usePass(state, playerId) {
  if (state.phase !== 'answering') {
    throw new Error('Cannot pass now');
  }
  if (state.questionIndex === ONE_PERCENT_INDEX) {
    throw new Error('Cannot pass the 1% question');
  }
  const player = state.players.find((p) => p.id === playerId);
  if (!player || player.status !== 'active') throw new Error('Not an active player');
  if (!player.hasPass || player.usedPass) throw new Error('No pass available');
  if (state.answers[playerId]?.locked) throw new Error('Already locked in');

  // Using a pass puts $1000 into the jackpot
  const players = state.players.map((p) =>
    p.id === playerId ? { ...p, usedPass: true, hasPass: false, stakeInJackpot: true } : p,
  );

  return actionMeta(
    cue(
      {
        ...state,
        jackpot: state.jackpot + STAKE,
        players,
        answers: {
          ...state.answers,
          [playerId]: {
            text: '',
            locked: true,
            usedPass: true,
            lockedAt: Date.now(),
          },
        },
      },
      'pass',
    ),
    'use_pass',
    { playerId },
  );
}

export function hostOverride(state, playerId, correct) {
  // During answering: stamp force flags for grading
  if (state.phase === 'answering') {
    const ans = state.answers[playerId] ?? { text: '', locked: true, usedPass: false };
    return actionMeta(
      {
        ...state,
        answers: {
          ...state.answers,
          [playerId]: {
            ...ans,
            locked: true,
            forceCorrect: !!correct,
            forceWrong: !correct,
          },
        },
      },
      'host_override',
      { playerId, correct: !!correct },
    );
  }

  // After grading: allow umpire flips whenever reveal results exist
  if (!state.reveal?.results) {
    throw new Error('Override only during answering or after grading');
  }
  const result = state.reveal.results.find((r) => r.playerId === playerId);
  if (!result) throw new Error('Player not in results');
  if (result.usedPass) throw new Error('Cannot override a pass');

  const wasCorrect = result.correct;
  if (wasCorrect === !!correct) return state;

  let jackpot = state.jackpot;
  const players = state.players.map((p) => {
    if (p.id !== playerId) return p;
    if (correct) {
      if (p.stakeInJackpot) jackpot = Math.max(0, jackpot - STAKE);
      return { ...p, status: 'active', stakeInJackpot: false };
    }
    if (!p.stakeInJackpot) jackpot += STAKE;
    return { ...p, status: 'out', stakeInJackpot: true };
  });

  const results = state.reveal.results.map((r) =>
    r.playerId === playerId ? { ...r, correct: !!correct, timedOut: false } : r,
  );

  let elimination = state.elimination;
  if (elimination?.wrongIds) {
    let wrongIds = [...elimination.wrongIds];
    let revealedIds = [...(elimination.revealedIds || [])];
    if (correct) {
      wrongIds = wrongIds.filter((id) => id !== playerId);
      revealedIds = revealedIds.filter((id) => id !== playerId);
    } else if (!wrongIds.includes(playerId)) {
      wrongIds.push(playerId);
    }
    elimination = {
      ...elimination,
      wrongIds,
      revealedIds,
      revealedCount: revealedIds.length,
    };
  }

  let next = {
    ...state,
    jackpot,
    players,
    elimination,
    reveal: {
      ...state.reveal,
      results,
      eliminated: results.filter((r) => !r.correct).length,
      survived: results.filter((r) => r.correct).length,
      wrongIds: elimination?.wrongIds || state.reveal.wrongIds,
    },
  };

  const survivors = players.filter((p) => p.status === 'active');
  if (survivors.length === 0) {
    next.pendingAfterReveal =
      state.questionIndex === ONE_PERCENT_INDEX ? 'finale' : 'wipeout_final';
  } else if (state.questionIndex === ONE_PERCENT_INDEX) next.pendingAfterReveal = 'finale';
  else if (survivors.length === 1) next.pendingAfterReveal = 'solo_offer';
  else if (state.questionIndex === FIVE_PERCENT_INDEX) next.pendingAfterReveal = 'final_choice';
  else next.pendingAfterReveal = 'next_question';

  return actionMeta(next, 'host_override', { playerId, correct: !!correct });
}

export function endAnsweringWithForces(state) {
  if (state.phase !== 'answering' && state.phase !== 'question') {
    throw new Error('Not in answering');
  }
  const q = state.currentQuestion;
  const results = [];
  let jackpotAdd = 0;
  const wrongIds = [];

  const players = state.players.map((p) => {
    if (p.status !== 'active') return p;
    const ans = state.answers[p.id];
    if (ans?.usedPass) {
      results.push({
        playerId: p.id,
        name: p.name,
        text: '(PASS)',
        correct: true,
        usedPass: true,
        timedOut: false,
      });
      return p;
    }
    const timedOut = !ans?.locked;
    let correct;
    if (ans?.forceCorrect) correct = true;
    else if (ans?.forceWrong) correct = false;
    else correct = !timedOut && answersMatch(ans?.text, q.accepted, {
      answerType: q.answerType,
      fuzzy: q.fuzzy,
    });

    results.push({
      playerId: p.id,
      name: p.name,
      text: timedOut ? '(no answer)' : ans?.text ?? '',
      correct,
      usedPass: false,
      timedOut,
    });

    if (!correct) {
      wrongIds.push(p.id);
      // On the 1% question, unspent $1,000 stays with the player as a bonus even if wrong.
      if (state.questionIndex === ONE_PERCENT_INDEX && !p.stakeInJackpot) {
        return { ...p, winnings: Math.max(p.winnings || 0, STAKE) };
      }
      if (!p.stakeInJackpot) jackpotAdd += STAKE;
      // Stay active until the blue-light sequence reveals them
      return { ...p, stakeInJackpot: true };
    }
    return p;
  });

  const jackpotBefore = state.jackpot;
  const jackpot = jackpotBefore + jackpotAdd;
  const reveal = {
    percent: q.percent,
    prompt: q.prompt,
    accepted: q.accepted,
    explanation: q.explanation || null,
    results,
    eliminated: wrongIds.length,
    survived: results.filter((r) => r.correct).length,
  };

  const pending = computePendingAfterReveal(
    { ...state, players, jackpot, questionIndex: state.questionIndex },
    wrongIds,
  );

  // Hold for host — silent until "Show wrong players"
  return actionMeta(
    {
      ...state,
      phase: 'eliminating',
      timerEndsAt: null,
      players,
      prevJackpot: jackpotBefore,
      jackpot,
      reveal,
      pendingAfterReveal: pending,
      soundCue: null,
      elimination: {
        stage: 'pending',
        wrongIds,
        revealedIds: [],
        revealedCount: 0,
        currentId: null,
      },
    },
    'end_answering',
  );
}

function computePendingAfterReveal(state, wrongIds) {
  const survivors = state.players.filter(
    (p) => p.status === 'active' && !wrongIds.includes(p.id),
  );
  // After lighting, wrongIds will be out — compute as if already out
  if (survivors.length === 0) {
    // Wipeout on 1%: no pot winners (keepers of $1k already have winnings).
    if (state.questionIndex === ONE_PERCENT_INDEX) return 'finale';
    // Everyone out on the same question → furthest become finalists.
    return 'wipeout_final';
  }
  if (state.questionIndex === ONE_PERCENT_INDEX) return 'finale';
  if (survivors.length === 1) return 'solo_offer';
  if (state.questionIndex === FIVE_PERCENT_INDEX) return 'final_choice';
  return 'next_question';
}

/**
 * Host pressed "Show wrong players".
 * TV eliminating.mp3 × 1–3 + all phones flash, then thump lights (or boards if clean).
 */
export function showResults(state) {
  if (state.phase !== 'eliminating' || state.elimination?.stage !== 'pending') {
    throw new Error('Not waiting to show results');
  }

  const times = 1 + Math.floor(Math.random() * 3);
  return actionMeta(
    cue(
      {
        ...state,
        elimination: {
          ...state.elimination,
          stage: 'scanning',
          scanStartedAt: Date.now(),
          stingTimes: times,
          stingSound: 'eliminating',
          stingTargetId: null,
          currentId: null,
        },
      },
      'eliminating',
      { times, audience: 'all', loop: false },
    ),
    'show_results_scanning',
    { times },
  );
}

/** @deprecated use showResults */
export function showEliminated(state) {
  return showResults(state);
}

/** After TV eliminating × 1–3 — start thumps, or go to boards if nobody wrong. */
export function finishScanningSting(state) {
  if (state.phase !== 'eliminating' || state.elimination?.stage !== 'scanning') {
    return state;
  }
  const wrongIds = state.elimination.wrongIds || [];
  if (wrongIds.length === 0) {
    return enterLeftCount({
      ...state,
      elimination: {
        ...state.elimination,
        stage: 'done',
        currentId: null,
        stingTimes: null,
        stingSound: null,
      },
    });
  }
  return startEliminationSting(state);
}

/** @deprecated use finishScanningSting */
export function finishCleanSting(state) {
  return finishScanningSting(state);
}

/** Big "X eliminated" board. */
export function enterEliminatedCount(state) {
  const out =
    state.reveal?.eliminated ??
    state.elimination?.wrongIds?.length ??
    state.players.filter((p) => p.status === 'out').length;
  return actionMeta(
    cue({ ...state, phase: 'eliminated_count' }, 'eliminate', { audience: 'all' }),
    'eliminated_count',
    { out },
  );
}

/** Big "X left / remain" board. */
export function enterLeftCount(state) {
  const left = activePlayers(state).length;
  return actionMeta(
    {
      ...state,
      phase: 'left_count',
      soundCue: null,
    },
    'left_count',
    { left },
  );
}

/** Prize pot / jackpot spectacle (show money). */
export function enterPrizePot(state) {
  return actionMeta(cue({ ...state, phase: 'prize_pot' }, 'eliminate', { audience: 'all' }), 'prize_pot');
}

/** TV board: host announced the correct answer (during/after roast). Silent — no sting. */
export function enterRightAnswerBoard(state) {
  if (state.phase !== 'left_count' && state.phase !== 'answer_reveal') {
    throw new Error('Show right answer after who remains');
  }
  return actionMeta(
    { ...state, phase: 'answer_reveal', soundCue: null },
    'show_right_answer',
  );
}

/** Correct-answer reveal after pot (optional / legacy). */
export function enterAnswerReveal(state) {
  return actionMeta(cue({ ...state, phase: 'reveal' }, 'correct'), 'reveal_answer');
}

/**
 * Sting before the next blue light — thump on TV + phones for every wrong.
 */
export function startEliminationSting(state) {
  if (state.phase !== 'eliminating') throw new Error('Not eliminating');
  const elim = state.elimination;
  if (!elim) throw new Error('No elimination data');

  const remaining = elim.wrongIds.filter((id) => !elim.revealedIds.includes(id));
  const nextId = remaining[0];
  if (!nextId) {
    return finalizeElimination(state);
  }

  const times = 1;
  const soundName = 'thump';
  const audience = 'all';

  return actionMeta(
    cue(
      {
        ...state,
        elimination: {
          ...elim,
          stage: 'sting',
          stingTargetId: nextId,
          stingTimes: times,
          stingSound: soundName,
          currentId: null,
        },
      },
      soundName,
      { times, audience },
    ),
    'elim_sting',
    { playerId: nextId, times, soundName, audience },
  );
}

/** Sting finished — light the targeted wrong player (no eliminate.mp3 yet). */
export function finishEliminationSting(state) {
  if (state.phase !== 'eliminating' || state.elimination?.stage !== 'sting') {
    return state;
  }
  const elim = state.elimination;
  const nextId = elim.stingTargetId;
  if (!nextId || elim.revealedIds.includes(nextId)) {
    return continueElimination(state);
  }

  const revealedIds = [...elim.revealedIds, nextId];
  const players = state.players.map((p) =>
    p.id === nextId ? { ...p, status: 'out' } : p,
  );

  return actionMeta(
    {
      ...state,
      players,
      soundCue: null,
      elimination: {
        ...elim,
        stage: 'lighting',
        revealedIds,
        revealedCount: revealedIds.length,
        currentId: nextId,
        stingTargetId: null,
        stingTimes: null,
        stingSound: null,
      },
    },
    'elim_light',
    { playerId: nextId },
  );
}

/** After a blue light beat — sting the next wrong player, or go to reveal. */
export function continueElimination(state) {
  if (state.phase !== 'eliminating') return state;
  const elim = state.elimination;
  if (!elim) return finalizeElimination(state);
  const nextId = elim.wrongIds.find((id) => !elim.revealedIds.includes(id));
  if (!nextId) return finalizeElimination(state);
  return startEliminationSting(state);
}

/** @deprecated — prefer finishEliminationSting / continueElimination */
export function revealNextEliminated(state) {
  if (state.phase !== 'eliminating') throw new Error('Not eliminating');
  if (state.elimination?.stage === 'sting') {
    return finishEliminationSting(state);
  }
  return continueElimination(state);
}

/** After outs — big "X left" board (roast happens here on host). */
export function finalizeElimination(state) {
  const elim = state.elimination;
  const next = {
    ...state,
    elimination: {
      ...elim,
      stage: 'done',
      currentId: null,
      stingTargetId: null,
      stingTimes: null,
      stingSound: null,
    },
  };
  const left = activePlayers(next).length;
  // Skip "X eliminated" — thumps → "X left!" → host roasts
  return actionMeta(
    cue({ ...next, phase: 'left_count' }, 'eliminate', { audience: 'all' }),
    'left_count',
    { left },
  );
}

export function advanceAfterReveal(state) {
  // Host-driven: left (roast) → optional answer board → jackpot → next
  if (state.phase === 'eliminated_count') {
    if (state.pendingAfterReveal === 'game_end' || activePlayers(state).length === 0) {
      return continueAfterBoards(state);
    }
    return enterLeftCount(state);
  }
  if (state.phase === 'left_count' || state.phase === 'answer_reveal') {
    // Still show the pot on wipeout (stakes just landed); only hard-end skips it.
    if (state.pendingAfterReveal === 'game_end') {
      return continueAfterBoards(state);
    }
    return enterPrizePot(state);
  }
  if (state.phase === 'prize_pot') {
    return continueAfterBoards(state);
  }
  if (state.phase !== 'reveal' && state.phase !== 'eliminating') {
    throw new Error('Not in reveal');
  }
  if (state.phase === 'eliminating') {
    state = finalizeElimination(state);
    if (state.phase === 'left_count' || state.phase === 'eliminated_count') return state;
  }
  return continueAfterBoards(state);
}

function continueAfterBoards(state) {
  const pending = state.pendingAfterReveal;

  if (pending === 'game_end') {
    return actionMeta({ ...state, phase: 'game_end', soundCue: null }, 'game_end');
  }
  if (pending === 'wipeout_final') {
    return enterWipeoutFinal(state);
  }
  if (pending === 'finale') {
    let next = { ...state, phase: 'finale' };
    // Clean or messy 1% round — any remaining contestants split the jackpot
    if (state.questionIndex === ONE_PERCENT_INDEX) {
      next = awardOnePercentWinners(next);
    }
    return actionMeta(cue(next, 'win'), 'finale');
  }
  if (pending === 'solo_offer') {
    return actionMeta(
      { ...state, phase: 'solo_offer', soloDecision: null },
      'solo_offer',
    );
  }
  if (pending === 'final_choice') {
    return actionMeta(
      {
        ...state,
        phase: 'final_choice',
        finalDecisions: {},
      },
      'final_choice',
    );
  }
  return beginQuestion(state, state.questionIndex + 1);
}

/**
 * Full wipeout — furthest-advancing contestants become finalists.
 * Those still in when the wipeout question was asked (everyone wrong this round)
 * are restored and jump to the Final Decision / solo offer — including an early
 * wipeout on 90% (UK/US: the show never ends with “nobody reaches the final”).
 */
function enterWipeoutFinal(state) {
  const finalistIds =
    state.elimination?.wrongIds?.length
      ? state.elimination.wrongIds
      : (state.reveal?.results || [])
          .filter((r) => !r.correct && !r.usedPass)
          .map((r) => r.playerId);

  if (!finalistIds.length) {
    return actionMeta({ ...state, phase: 'game_end', soundCue: null }, 'game_end');
  }

  const players = state.players.map((p) =>
    finalistIds.includes(p.id) ? { ...p, status: 'active' } : p,
  );
  const next = {
    ...state,
    players,
    pendingAfterReveal: null,
    elimination: null,
  };

  if (finalistIds.length === 1) {
    return actionMeta(
      { ...next, phase: 'solo_offer', soloDecision: null },
      'wipeout_solo',
    );
  }
  return actionMeta(
    { ...next, phase: 'final_choice', finalDecisions: {} },
    'wipeout_final',
  );
}

export function cashoutDecide(state, playerId, leave) {
  if (state.phase !== 'cashout_offer') throw new Error('Not in cashout');
  const player = state.players.find((p) => p.id === playerId);
  if (!player || player.status !== 'active') throw new Error('Not active');
  if (!player.hasPass || player.usedPass) throw new Error('Not eligible to cash out');

  return {
    ...state,
    cashoutDecisions: {
      ...state.cashoutDecisions,
      [playerId]: !!leave,
    },
  };
}

export function resolveCashout(state) {
  if (state.phase !== 'cashout_offer') throw new Error('Not in cashout');
  const eligible = activePlayers(state).filter((p) => p.hasPass && !p.usedPass);
  // Anyone who didn't decide stays
  const players = state.players.map((p) => {
    if (state.cashoutDecisions[p.id] === true) {
      return { ...p, status: 'cashed', winnings: STAKE };
    }
    return p;
  });

  const nextIndex =
    state._awaitingQuestionIndex ?? CASHOUT_QUESTION_INDEX;

  let next = {
    ...state,
    players,
    phase: 'question',
    _cashoutDone: true,
    cashoutDecisions: {},
  };

  // Force-decide remaining eligible as stay
  void eligible;
  return beginQuestion(next, nextIndex);
}

export function finalDecide(state, playerId, take10k) {
  if (state.phase !== 'final_choice') throw new Error('Not in final choice');
  const player = state.players.find((p) => p.id === playerId);
  if (!player || player.status !== 'active') throw new Error('Not active');

  return {
    ...state,
    finalDecisions: {
      ...state.finalDecisions,
      [playerId]: !!take10k,
    },
  };
}

export function resolveFinalChoice(state) {
  if (state.phase !== 'final_choice') throw new Error('Not in final choice');
  const actives = activePlayers(state);
  // Default: go for 1% if no decision
  const leavers = actives.filter((p) => state.finalDecisions[p.id] === true);
  const stayers = actives.filter((p) => state.finalDecisions[p.id] !== true);

  let share = 0;
  if (leavers.length > 0) {
    share = Math.floor(TEN_K / leavers.length);
  }

  const players = state.players.map((p) => {
    if (state.finalDecisions[p.id] === true) {
      return { ...p, status: 'took10k', winnings: share };
    }
    return p;
  });

  if (stayers.length === 0) {
    return actionMeta(cue({ ...state, players, phase: 'finale' }, 'win'), 'finale');
  }

  return beginQuestion({ ...state, players, finalDecisions: {} }, ONE_PERCENT_INDEX);
}

export function soloDecide(state, take10k) {
  if (state.phase !== 'solo_offer') throw new Error('Not in solo offer');
  const solo = activePlayers(state)[0];
  if (!solo) throw new Error('No solo player');

  if (take10k) {
    const players = state.players.map((p) =>
      p.id === solo.id ? { ...p, status: 'took10k', winnings: TEN_K } : p,
    );
    return actionMeta(
      cue({ ...state, players, soloDecision: '10k', phase: 'finale' }, 'win'),
      'solo_10k',
    );
  }

  // Jump to 1%
  return beginQuestion(
    { ...state, soloDecision: 'one_percent' },
    ONE_PERCENT_INDEX,
  );
}

export function clearSoundCue(state) {
  return { ...state, soundCue: null };
}

export function resetToLobby(state) {
  const setup = state.setup;
  return {
    ...createInitialState(),
    setup,
    joinCode: createJoinCode(),
  };
}

export function lockedCount(state) {
  return Object.values(state.answers).filter((a) => a.locked).length;
}

export function activeCount(state) {
  return activePlayers(state).length;
}
