import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';
import {
  createInitialState,
  applySetup,
  joinPlayer,
  removePlayer,
  seedTestPlayers,
  applyTestBotAnswers,
  closeLobby,
  reopenLobby,
  startGame,
  skipIntro,
  beginQuestion,
  startAnswering,
  submitAnswer,
  usePass,
  endAnsweringWithForces,
  showResults,
  finishEliminationSting,
  finishScanningSting,
  continueElimination,
  enterPrizePot,
  enterRightAnswerBoard,
  advanceAfterReveal,
  ELIM_STING_MS,
  THUMP_MS,
  hostOverride,
  cashoutDecide,
  resolveCashout,
  resolvePassBriefing,
  finalDecide,
  resolveFinalChoice,
  startOnePercent,
  soloDecide,
  clearSoundCue,
  resetToLobby,
  sanitizeStateForClient,
  activeCount,
  lockedCount,
  createJoinCode,
  thumpGapMs,
} from './gameState.js';
import { MDNS_NAME, networkInfo } from './network.js';
import { Bonjour } from 'bonjour-service';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const QUESTIONS_DIR = path.join(ROOT, 'data', 'questions');
const SOUNDS_DIR = path.join(ROOT, 'public', 'sounds');
const PUBLIC_DIR = path.join(ROOT, 'public');
const FEEDBACK_FILE = path.join(ROOT, 'data', 'feedback.jsonl');
const PORT = Number(process.env.PORT) || 3457;

let state = createInitialState();
const clients = new Set();
let answerTimer = null;
let elimRevealTimer = null;
let soundCueClearTimer = null;

function clearAnswerTimer() {
  if (answerTimer) {
    clearTimeout(answerTimer);
    answerTimer = null;
  }
}

function clearElimTimers() {
  if (elimRevealTimer) {
    clearTimeout(elimRevealTimer);
    elimRevealTimer = null;
  }
}

function scheduleAnswerTimer() {
  clearAnswerTimer();
  if (!state.timerEndsAt) return;
  const delay = Math.max(0, state.timerEndsAt - Date.now());
  answerTimer = setTimeout(() => {
    try {
      if (state.phase === 'answering') {
        state = endAnsweringWithForces(state);
        broadcast();
      }
    } catch {
      // ignore
    }
  }, delay + 50);
}

function stingFallbackDelay() {
  const elim = state.elimination;
  const times = elim?.stingTimes || 1;
  const sound = elim?.stingSound || state.soundCue?.name;
  if (sound === 'thump') return times * THUMP_MS + 350;
  return times * ELIM_STING_MS + 400;
}

function scheduleElimStingFallback() {
  if (elimRevealTimer) clearTimeout(elimRevealTimer);
  const delay = stingFallbackDelay();
  elimRevealTimer = setTimeout(() => {
    try {
      if (state.phase !== 'eliminating') return;
      if (state.elimination?.stage === 'scanning' || state.elimination?.stage === 'clean_sting') {
        state = finishScanningSting(state);
        broadcast();
        if (state.phase === 'eliminating' && state.elimination?.stage === 'sting') {
          scheduleElimStingFallback();
        }
        return;
      }
      if (state.elimination?.stage !== 'sting') return;
      state = finishEliminationSting(state);
      broadcast();
      scheduleAfterElimLight();
    } catch {
      // ignore
    }
  }, delay);
}

function nextThumpGap() {
  return thumpGapMs(state.elimination?.revealedCount ?? 0);
}

/** Everyone locked — cut remaining answer window to 3s and seek timer bed. */
function maybeShortenTimerForAllLocked() {
  if (!state.setup?.fastFinishWhenAllLocked) return;
  if (state.phase !== 'answering') return;
  const active = activeCount(state);
  if (active < 1) return;
  if (lockedCount(state) < active) return;
  const ends = Date.now() + 3000;
  if (state.timerEndsAt && state.timerEndsAt <= ends) return;
  state = {
    ...state,
    timerEndsAt: ends,
    soundCue: { name: 'timer_seek', at: Date.now(), secondsFromEnd: 3 },
  };
  scheduleAnswerTimer();
}

function scheduleAfterElimLight(delay = nextThumpGap()) {
  if (elimRevealTimer) clearTimeout(elimRevealTimer);
  elimRevealTimer = setTimeout(() => {
    try {
      if (state.phase !== 'eliminating') return;
      state = continueElimination(state);
      broadcast();
      if (state.phase === 'eliminating' && state.elimination?.stage === 'sting') {
        scheduleElimStingFallback();
      } else {
        schedulePostElimBoards();
      }
    } catch {
      // ignore
    }
  }, delay);
}

/** Boards are host-advanced (eliminated → remain → jackpot → next Q). */
function schedulePostElimBoards() {
  // no auto-advance
}

function clientView(ws) {
  return sanitizeStateForClient(state, ws.role, ws.playerId ?? null);
}

function scheduleSoundCueClear() {
  if (soundCueClearTimer) {
    clearTimeout(soundCueClearTimer);
    soundCueClearTimer = null;
  }
  const cue = state.soundCue;
  if (!cue?.at) return;
  // Give phones time to receive eliminate / eliminating cues before clearing.
  const delay =
    cue.name === 'eliminate'
      ? 2500
      : cue.name === 'eliminating'
        ? Math.max(2500, (cue.times || 1) * ELIM_STING_MS + 800)
        : cue.name === 'thump'
          ? Math.max(1500, (cue.times || 1) * THUMP_MS + 600)
          : 1200;
  soundCueClearTimer = setTimeout(() => {
    if (state.soundCue?.at === cue.at) {
      state = clearSoundCue(state);
      broadcast();
    }
  }, delay);
}

function broadcast() {
  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(JSON.stringify({ type: 'state', state: clientView(client) }));
    }
  }
  scheduleSoundCueClear();
}

function updateConnectionFlags() {
  state = {
    ...state,
    displayConnected: [...clients].some((c) => c.role === 'display'),
    hostConnected: [...clients].some((c) => c.role === 'host'),
    playerConnections: [...clients].filter((c) => c.role === 'player').length,
  };
}

async function loadQuestionPack(filename) {
  const safe = path.basename(filename);
  const filePath = path.join(QUESTIONS_DIR, safe);
  const raw = await fs.readFile(filePath, 'utf8');
  const data = JSON.parse(raw);
  // Support { name, questions: [...] } or a bare questions array
  const list = Array.isArray(data) ? data : data.questions;
  if (!Array.isArray(list)) {
    throw new Error('Invalid question pack: missing questions array');
  }
  const packId = path.basename(safe, '.json');
  const questions = list.map((q) => ({
    ...q,
    image: resolveQuestionImage(q.image, packId),
    solutionImage: resolveQuestionImage(q.solutionImage, packId),
  }));
  const name = Array.isArray(data) ? packId : (data.name ?? safe);
  const settings = {
    hidePrompt: !!(data && !Array.isArray(data) && data.settings?.hidePrompt),
  };
  if (
    data &&
    !Array.isArray(data) &&
    (data.settings?.currency === 'dollars' || data.settings?.currency === 'points')
  ) {
    settings.currency = data.settings.currency;
  }
  return { questions, name, packId, settings };
}

/** Pack-relative image → /images/questions/<packId>/<file> */
function resolveQuestionImage(image, packId) {
  if (!image) return null;
  const s = String(image).trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s) || s.startsWith('/')) return s;
  const cleaned = s.replace(/\\/g, '/').replace(/\.\./g, '').replace(/^\/+/, '');
  if (!cleaned) return null;
  return `/images/questions/${packId}/${cleaned}`;
}

async function listQuestionFiles() {
  const entries = await fs.readdir(QUESTIONS_DIR);
  return entries.filter((f) => f.endsWith('.json')).sort();
}

async function listSoundFiles() {
  const entries = await fs.readdir(SOUNDS_DIR);
  return entries.filter((f) => /\.(mp3|wav|ogg|m4a)$/i.test(f)).sort();
}

function requireHost(role) {
  if (role !== 'host') throw new Error('Host only');
}

async function handleAction(action, payload = {}, meta = {}) {
  const role = meta.role || 'host';
  const playerId = payload.playerId || meta.playerId || null;

  switch (action) {
    case 'update_setup':
      requireHost(role);
      state = applySetup(state, payload.setup ?? {});
      break;

    case 'join': {
      const result = joinPlayer(state, { name: payload.name, playerId });
      state = result.state;
      return { playerId: result.player.id, player: result.player };
    }

    case 'remove_player':
      requireHost(role);
      state = removePlayer(state, payload.targetId || payload.playerId);
      break;

    case 'close_lobby':
      requireHost(role);
      state = closeLobby(state);
      break;

    case 'reopen_lobby':
      requireHost(role);
      state = reopenLobby(state);
      break;

    case 'seed_test_players':
      requireHost(role);
      state = seedTestPlayers(state);
      break;

    case 'start_game': {
      requireHost(role);
      const pack = await loadQuestionPack(state.setup.questionFile);
      // Pack Editor `settings.currency` drives the live unit when present.
      if (pack.settings?.currency === 'dollars' || pack.settings?.currency === 'points') {
        state = applySetup(state, { currency: pack.settings.currency });
      }
      state = startGame(state, pack.questions, pack.name, pack.settings);
      break;
    }

    case 'skip_intro':
      requireHost(role);
      state = skipIntro(state);
      if (state.phase === 'question') {
        // auto-start answering after brief question show? Host triggers.
      }
      break;

    case 'show_question':
      requireHost(role);
      if (state.phase === 'intro') state = skipIntro(state);
      else if (state.questionIndex < 0) state = beginQuestion(state, 0);
      break;

    case 'start_answering':
      requireHost(role);
      clearAnswerTimer();
      state = startAnswering(state);
      state = applyTestBotAnswers(state);
      maybeShortenTimerForAllLocked();
      scheduleAnswerTimer();
      break;

    case 'submit_answer':
      if (role !== 'player' && role !== 'host') throw new Error('Players only');
      state = submitAnswer(state, playerId, payload.text);
      maybeShortenTimerForAllLocked();
      break;

    case 'use_pass':
      if (role !== 'player' && role !== 'host') throw new Error('Players only');
      state = usePass(state, playerId);
      maybeShortenTimerForAllLocked();
      break;

    case 'end_answering':
      requireHost(role);
      clearAnswerTimer();
      clearElimTimers();
      state = endAnsweringWithForces(state);
      break;

    case 'show_results':
    case 'show_eliminated':
      requireHost(role);
      clearElimTimers();
      state = showResults(state);
      if (
        state.phase === 'eliminating' &&
        (state.elimination?.stage === 'scanning' ||
          state.elimination?.stage === 'sting' ||
          state.elimination?.stage === 'clean_sting')
      ) {
        scheduleElimStingFallback();
      }
      break;

    case 'show_right_answer':
      requireHost(role);
      state = enterRightAnswerBoard(state);
      break;

    case 'elim_sting_done':
      // TV finished eliminating (scanning) or thump — advance
      if (
        state.phase === 'eliminating' &&
        (state.elimination?.stage === 'scanning' || state.elimination?.stage === 'clean_sting')
      ) {
        clearElimTimers();
        state = finishScanningSting(state);
        if (state.phase === 'eliminating' && state.elimination?.stage === 'sting') {
          scheduleElimStingFallback();
        }
      } else if (state.phase === 'eliminating' && state.elimination?.stage === 'sting') {
        clearElimTimers();
        state = finishEliminationSting(state);
        scheduleAfterElimLight();
      }
      break;

    case 'host_override':
      requireHost(role);
      state = hostOverride(state, payload.targetId || payload.playerId, !!payload.correct);
      break;

    case 'advance':
      requireHost(role);
      clearElimTimers();
      if (state.phase === 'pass_briefing') {
        state = resolvePassBriefing(state);
      } else {
        state = advanceAfterReveal(state);
      }
      if (state.phase === 'answering') scheduleAnswerTimer();
      schedulePostElimBoards();
      break;

    case 'cashout_decide':
      state = cashoutDecide(state, playerId, !!payload.leave);
      break;

    case 'resolve_cashout':
      requireHost(role);
      state = resolveCashout(state);
      break;

    case 'resolve_pass_briefing':
      requireHost(role);
      state = resolvePassBriefing(state);
      break;

    case 'final_decide':
      state = finalDecide(state, playerId, !!payload.take10k);
      break;

    case 'resolve_final':
      requireHost(role);
      state = resolveFinalChoice(state);
      break;

    case 'start_one_percent':
      requireHost(role);
      state = startOnePercent(state);
      break;

    case 'solo_decide':
      // Host or the solo player can decide (1% waits for host to start the question)
      state = soloDecide(state, !!payload.take10k);
      break;

    case 'clear_sound':
      state = clearSoundCue(state);
      break;

    case 'reset_lobby':
      requireHost(role);
      clearAnswerTimer();
      clearElimTimers();
      state = resetToLobby(state);
      break;

    case 'new_join_code':
      requireHost(role);
      if (state.phase !== 'lobby') throw new Error('Lobby only');
      state = { ...state, joinCode: createJoinCode() };
      break;

    default:
      throw new Error(`Unknown action: ${action}`);
  }

  return null;
}

const app = express();
app.use(express.json({ limit: '1mb' }));
// Avoid stale host/display/play JS after deploys (browsers were caching old clients)
app.use(
  express.static(PUBLIC_DIR, {
    setHeaders(res, filePath) {
      if (/\.(js|css|html)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }),
);

app.get('/api/state', (req, res) => {
  const role = req.headers['x-client-role'] || req.query.role || 'display';
  const playerId = req.headers['x-player-id'] || req.query.playerId || null;
  res.json(sanitizeStateForClient(state, role, playerId));
});

app.get('/api/question-files', async (_req, res) => {
  try {
    res.json({ files: await listQuestionFiles() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Pack metadata (name + settings) for host setup seeding. Optional preview=1 includes questions. */
app.get('/api/question-pack', async (req, res) => {
  try {
    const file = String(req.query.file || '');
    const pack = await loadQuestionPack(file);
    const body = { name: pack.name, settings: pack.settings, packId: pack.packId };
    const preview =
      req.query.preview === '1' ||
      req.query.preview === 'true' ||
      req.query.include === 'questions';
    if (preview) {
      body.questions = pack.questions;
    }
    res.json(body);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/sound-files', async (_req, res) => {
  try {
    res.json({ files: await listSoundFiles() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/info', (_req, res) => {
  res.json(networkInfo(PORT));
});

app.get('/api/qr', async (req, res) => {
  try {
    const data = String(req.query.data || '').slice(0, 2048);
    if (!data) {
      res.status(400).json({ error: 'data required' });
      return;
    }
    const png = await QRCode.toBuffer(data, {
      type: 'png',
      width: Number(req.query.size) || 320,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#031018', light: '#ffffff' },
    });
    res.set('Cache-Control', 'public, max-age=60');
    res.type('png').send(png);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/feedback', async (_req, res) => {
  try {
    const raw = await fs.readFile(FEEDBACK_FILE, 'utf8').catch(() => '');
    const items = raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/feedback', async (req, res) => {
  try {
    const note = String(req.body?.note ?? '').trim();
    if (!note) {
      res.status(400).json({ error: 'Note required' });
      return;
    }
    const entry = {
      id: `fb_${Date.now().toString(36)}`,
      at: new Date().toISOString(),
      screen: String(req.body?.screen || 'unknown').slice(0, 40),
      type: String(req.body?.type || 'other').slice(0, 40),
      severity: String(req.body?.severity || 'minor').slice(0, 40),
      note: note.slice(0, 4000),
      name: String(req.body?.name || '').slice(0, 80),
      url: String(req.body?.url || '').slice(0, 500),
      userAgent: String(req.body?.userAgent || '').slice(0, 300),
    };
    await fs.mkdir(path.dirname(FEEDBACK_FILE), { recursive: true });
    await fs.appendFile(FEEDBACK_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
    res.json({ ok: true, entry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/action', async (req, res) => {
  try {
    const { action, ...payload } = req.body;
    const role = req.headers['x-client-role'] || payload.role || 'host';
    const meta = {
      role,
      playerId: req.headers['x-player-id'] || payload.playerId || null,
    };
    const extra = await handleAction(action, payload, meta);
    updateConnectionFlags();
    broadcast();
    const view = sanitizeStateForClient(state, role, meta.playerId);
    res.json({ ok: true, state: view, ...extra });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roleParam = url.searchParams.get('role') || 'display';
  ws.role = ['display', 'host', 'player'].includes(roleParam) ? roleParam : 'display';
  ws.playerId = url.searchParams.get('playerId') || null;
  clients.add(ws);
  updateConnectionFlags();
  ws.send(JSON.stringify({ type: 'state', state: clientView(ws) }));
  broadcast();

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'action') {
        await handleAction(msg.action, msg, { role: ws.role, playerId: ws.playerId });
        updateConnectionFlags();
        broadcast();
      } else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      } else if (msg.type === 'identify') {
        ws.playerId = msg.playerId || ws.playerId;
        ws.send(JSON.stringify({ type: 'state', state: clientView(ws) }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', error: err.message }));
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    updateConnectionFlags();
    broadcast();
  });
});

server.listen(PORT, '0.0.0.0', async () => {
  const info = networkInfo(PORT);
  const files = await listQuestionFiles();

  if (!process.env.RENDER) {
    try {
      const bonjour = new Bonjour();
      bonjour.publish({
        name: MDNS_NAME,
        type: 'http',
        port: PORT,
      });
    } catch (err) {
      console.warn('  mDNS: could not advertise (club.local may not resolve):', err.message);
    }
  }

  console.log('');
  console.log('  The 1% Club — party server');
  console.log('  ──────────────────────────');
  console.log('  USE THESE (LAN IP — works on phones):');
  console.log(`  Home:     ${info.primary}/`);
  console.log(`  TV:       ${info.display}`);
  console.log(`  Host:     ${info.host}`);
  console.log(`  Play:     ${info.play}`);
  console.log(`  QA:       ${info.qa}`);
  console.log('');
  console.log('  On this Mac you can also use:');
  console.log(`    http://localhost:${PORT}/`);
  console.log('');
  console.log('  Note: club.local often hangs on macOS — prefer the IP above.');
  console.log('');
  console.log(`  Question packs: ${files.join(', ')}`);
  console.log('');
});
