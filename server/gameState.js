/** @typedef {'lobby'|'intro'|'question'|'answering'|'eliminating'|'reveal'|'cashout_offer'|'final_choice'|'solo_offer'|'finale'|'game_end'} Phase */
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

export function normalizeAnswer(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function answersMatch(given, acceptedList) {
  const n = normalizeAnswer(given);
  if (!n) return false;
  return (acceptedList ?? []).some((a) => normalizeAnswer(a) === n);
}

function defaultSetup() {
  return {
    questionFile: 'sample.json',
    answerSeconds: ANSWER_SECONDS,
    masterVolume: 0.7,
    skipIntro: false,
    sounds: {},
  };
}

export const ELIMINATING_MS = 4400;
export const ELIM_REVEAL_GAP_MS = 1200;

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
    soundCue: null,
    pendingAfterReveal: null,
  };
}

function cue(state, name) {
  return { ...state, soundCue: { name, at: Date.now() } };
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
    state.phase !== 'eliminating' &&
    state.phase !== 'finale' &&
    state.phase !== 'game_end'
  ) {
    if (base.currentQuestion) {
      base.currentQuestion = {
        ...base.currentQuestion,
        accepted: undefined,
      };
    }
  }

  // Host-only preview: TV/players see percent + seats, not the prompt, until Start.
  if (role !== 'host' && state.phase === 'question' && base.currentQuestion) {
    base.currentQuestion = {
      index: base.currentQuestion.index,
      percent: base.currentQuestion.percent,
      promptHidden: true,
    };
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

export function startGame(state, questions, packName = null) {
  if (state.players.length < 1) throw new Error('Need at least 1 player');
  if (!Array.isArray(questions) || questions.length < PERCENTAGES.length) {
    throw new Error(`Need ${PERCENTAGES.length} questions in pack`);
  }

  const packed = PERCENTAGES.map((pct, i) => {
    const q = questions[i];
    const choices = Array.isArray(q.choices)
      ? q.choices.map((c) => String(c)).filter(Boolean).slice(0, 6)
      : [];
    let accepted = Array.isArray(q.accepted)
      ? q.accepted
      : Array.isArray(q.answers)
        ? q.answers
        : [q.answer].filter(Boolean);
    // Allow answering by letter (A/B/C) or by choice text
    if (choices.length) {
      const extras = [];
      choices.forEach((text, idx) => {
        extras.push(String.fromCharCode(65 + idx)); // A, B, C…
        extras.push(text);
      });
      accepted = [...accepted, ...extras];
    }
    return {
      index: i,
      percent: pct,
      prompt: q.prompt ?? q.question,
      hint: q.hint ?? null,
      image: q.image || null,
      choices,
      accepted,
    };
  });

  let next = {
    ...state,
    lobbyOpen: false,
    questions: packed,
    packName,
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

  next = cue(next, 'intro');
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

  // Host talk / banter bed — question + answer music wait for Start.
  return actionMeta(cue(next, 'interlude'), 'begin_question', { questionIndex });
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
  if (state.phase !== 'reveal' && state.phase !== 'answering') {
    throw new Error('Override only during answering/reveal');
  }
  // If still answering, just mark override flag for grading
  if (state.phase === 'answering') {
    const ans = state.answers[playerId] ?? { text: '', locked: true, usedPass: false };
    return {
      ...state,
      answers: {
        ...state.answers,
        [playerId]: { ...ans, locked: true, forceCorrect: !!correct, forceWrong: !correct },
      },
    };
  }

  // During reveal: flip result and adjust jackpot/status
  if (!state.reveal) throw new Error('No reveal data');
  const result = state.reveal.results.find((r) => r.playerId === playerId);
  if (!result) throw new Error('Player not in results');
  if (result.usedPass) throw new Error('Cannot override a pass');

  const wasCorrect = result.correct;
  if (wasCorrect === correct) return state;

  let jackpot = state.jackpot;
  const players = state.players.map((p) => {
    if (p.id !== playerId) return p;
    if (correct) {
      // resurrect
      if (p.stakeInJackpot) jackpot = Math.max(0, jackpot - STAKE);
      return { ...p, status: 'active', stakeInJackpot: false };
    }
    // eliminate
    if (!p.stakeInJackpot) jackpot += STAKE;
    return { ...p, status: 'out', stakeInJackpot: true };
  });

  const results = state.reveal.results.map((r) =>
    r.playerId === playerId ? { ...r, correct, timedOut: false } : r,
  );

  let next = {
    ...state,
    jackpot,
    players,
    reveal: {
      ...state.reveal,
      results,
      eliminated: results.filter((r) => !r.correct).length,
      survived: results.filter((r) => r.correct).length,
    },
  };

  // Recalculate pending
  const survivors = players.filter((p) => p.status === 'active');
  if (survivors.length === 0) next.pendingAfterReveal = 'game_end';
  else if (state.questionIndex === ONE_PERCENT_INDEX) next.pendingAfterReveal = 'finale';
  else if (survivors.length === 1) next.pendingAfterReveal = 'solo_offer';
  else if (state.questionIndex === FIVE_PERCENT_INDEX) next.pendingAfterReveal = 'final_choice';
  else next.pendingAfterReveal = 'next_question';

  return actionMeta(next, 'host_override', { playerId, correct });
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
    else correct = !timedOut && answersMatch(ans?.text, q.accepted);

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
      if (!p.stakeInJackpot) jackpotAdd += STAKE;
      // Stay active until the blue-light sequence reveals them
      return { ...p, stakeInJackpot: true };
    }
    return p;
  });

  const jackpot = state.jackpot + jackpotAdd;
  const reveal = {
    percent: q.percent,
    prompt: q.prompt,
    accepted: q.accepted,
    results,
    eliminated: wrongIds.length,
    survived: results.filter((r) => r.correct).length,
  };

  const pending = computePendingAfterReveal(
    { ...state, players, jackpot, questionIndex: state.questionIndex },
    wrongIds,
  );

  // Always hold for host — "Show who is right and wrong" starts lighting / reveal.
  return actionMeta(
    {
      ...state,
      phase: 'eliminating',
      timerEndsAt: null,
      players,
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
  if (survivors.length === 0) return 'game_end';
  if (state.questionIndex === ONE_PERCENT_INDEX) return 'finale';
  if (survivors.length === 1) return 'solo_offer';
  if (state.questionIndex === FIVE_PERCENT_INDEX) return 'final_choice';
  return 'next_question';
}

/**
 * Host pressed "Show who is right and wrong".
 * Clean round → reveal + correct sting. Otherwise start blue-light eliminations.
 */
export function showResults(state) {
  if (state.phase !== 'eliminating' || state.elimination?.stage !== 'pending') {
    throw new Error('Not waiting to show results');
  }

  const wrongIds = state.elimination.wrongIds || [];
  if (wrongIds.length === 0) {
    return actionMeta(
      cue(
        {
          ...state,
          phase: 'reveal',
          elimination: {
            ...state.elimination,
            stage: 'done',
            currentId: null,
          },
        },
        'correct',
      ),
      'show_results',
    );
  }

  const ready = {
    ...state,
    elimination: {
      ...state.elimination,
      stage: 'lighting',
      currentId: null,
    },
    soundCue: null,
  };
  return revealNextEliminated(ready);
}

/** @deprecated use showResults */
export function showEliminated(state) {
  return showResults(state);
}

/** Reveal the next wrong player (blue light + eliminate SFX). */
export function revealNextEliminated(state) {
  if (state.phase !== 'eliminating') throw new Error('Not eliminating');
  const elim = state.elimination;
  if (!elim || elim.stage !== 'lighting') throw new Error('Not lighting eliminated yet');

  const nextId = elim.wrongIds.find((id) => !elim.revealedIds.includes(id));
  if (!nextId) {
    return finalizeElimination(state);
  }

  const revealedIds = [...elim.revealedIds, nextId];
  const players = state.players.map((p) =>
    p.id === nextId ? { ...p, status: 'out' } : p,
  );

  let next = {
    ...state,
    players,
    elimination: {
      ...elim,
      stage: 'lighting',
      revealedIds,
      revealedCount: revealedIds.length,
      currentId: nextId,
    },
  };
  next = cue(next, 'eliminate');
  return actionMeta(next, 'elim_light', { playerId: nextId });
}

function finalizeElimination(state) {
  const elim = state.elimination;
  let next = {
    ...state,
    phase: 'reveal',
    elimination: {
      ...elim,
      stage: 'done',
      currentId: null,
    },
    soundCue: null,
  };

  return actionMeta(next, 'elim_done');
}

export function advanceAfterReveal(state) {
  if (state.phase !== 'reveal' && state.phase !== 'eliminating') {
    throw new Error('Not in reveal');
  }
  // If somehow still eliminating, finish first
  if (state.phase === 'eliminating') {
    state = finalizeElimination(state);
  }
  const pending = state.pendingAfterReveal;

  if (pending === 'game_end') {
    return actionMeta({ ...state, phase: 'game_end', soundCue: null }, 'game_end');
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
