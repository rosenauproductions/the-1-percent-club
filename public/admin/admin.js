const PERCENTS = [90, 80, 70, 60, 50, 45, 40, 35, 30, 25, 20, 15, 10, 5, 1];

/** @type {{ name: string, settings: { hidePrompt: boolean }, questions: object[] }} */
let pack = blankPack();
let selectedIndex = 0;
let previewMode = 'question';
/** @type {Record<string, string>} blob URLs keyed `${index}:q` / `${index}:s` */
const previewBlobs = {};

const els = {
  packName: document.getElementById('packName'),
  hidePrompt: document.getElementById('hidePrompt'),
  fillAbNames: document.getElementById('fillAbNames'),
  slotList: document.getElementById('slotList'),
  editorTitle: document.getElementById('editorTitle'),
  prompt: document.getElementById('prompt'),
  accepted: document.getElementById('accepted'),
  explanation: document.getElementById('explanation'),
  choices: document.getElementById('choices'),
  imageName: document.getElementById('imageName'),
  imageFile: document.getElementById('imageFile'),
  solutionImageName: document.getElementById('solutionImageName'),
  solutionImageFile: document.getElementById('solutionImageFile'),
  loadJson: document.getElementById('loadJson'),
  newPack: document.getElementById('newPack'),
  downloadJson: document.getElementById('downloadJson'),
  scale: document.getElementById('scale'),
  x: document.getElementById('x'),
  y: document.getElementById('y'),
  scaleVal: document.getElementById('scaleVal'),
  xVal: document.getElementById('xVal'),
  yVal: document.getElementById('yVal'),
  resetTransform: document.getElementById('resetTransform'),
  previewMain: document.getElementById('previewMain'),
  imageReminder: document.getElementById('imageReminder'),
};

function blankQuestion(percent) {
  return {
    percent,
    prompt: '',
    accepted: [],
    explanation: '',
    choices: [],
    image: `${percent}a.png`,
    solutionImage: `${percent}b.png`,
    imageTransform: { scale: 1, x: 0, y: 0 },
  };
}

function blankPack() {
  return {
    name: 'My Question Pack',
    settings: { hidePrompt: false },
    questions: PERCENTS.map((p) => blankQuestion(p)),
  };
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseList(text) {
  return String(text || '')
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function currentQ() {
  return pack.questions[selectedIndex];
}

function ensureTransform(q) {
  if (!q.imageTransform || typeof q.imageTransform !== 'object') {
    q.imageTransform = { scale: 1, x: 0, y: 0 };
  }
  const t = q.imageTransform;
  t.scale = Number.isFinite(Number(t.scale)) ? Number(t.scale) : 1;
  t.x = Number.isFinite(Number(t.x)) ? Number(t.x) : 0;
  t.y = Number.isFinite(Number(t.y)) ? Number(t.y) : 0;
  return t;
}

function imageTransformStyle(t) {
  if (!t) return '';
  return `transform: translate(${t.x}%, ${t.y}%) scale(${t.scale}); transform-origin: center center;`;
}

function imageSrc(kind, q, index) {
  const key = `${index}:${kind}`;
  if (previewBlobs[key]) return previewBlobs[key];
  const name = String(kind === 's' ? q.solutionImage || q.image : q.image || '').trim();
  if (!name) return '';
  if (name.startsWith('/') || name.startsWith('http')) return name;
  const folder = slugFromPackName(pack.name);
  return `/images/questions/${folder}/${name}`;
}

function slugFromPackName(name) {
  const base = String(name || 'pack')
    .toLowerCase()
    .replace(/\.json$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return base || 'pack';
}

function clearPreviewBlobs() {
  Object.keys(previewBlobs).forEach((k) => {
    URL.revokeObjectURL(previewBlobs[k]);
    delete previewBlobs[k];
  });
}

function renderSlots() {
  els.slotList.innerHTML = pack.questions
    .map((q, i) => {
      const tip = (q.prompt || '').trim() || 'Empty';
      return `<button type="button" class="slot-btn ${i === selectedIndex ? 'is-active' : ''}" data-i="${i}">
        ${q.percent}%
        <small>${escapeHtml(tip)}</small>
      </button>`;
    })
    .join('');
}

function renderImageReminder() {
  const names = [
    ...new Set(
      pack.questions.flatMap((q) =>
        [q.image, q.solutionImage]
          .map((n) => String(n || '').trim())
          .filter((n) => n && !n.startsWith('/') && !n.startsWith('http')),
      ),
    ),
  ];
  if (!names.length) {
    els.imageReminder.textContent =
      'No image filenames yet. Zip matching files under public/images/questions/<pack>/';
    return;
  }
  els.imageReminder.innerHTML = `<strong>Zip these with the pack:</strong><br>${names
    .map((n) => escapeHtml(n))
    .join('<br>')}`;
}

function fillEditor() {
  const q = currentQ();
  const t = ensureTransform(q);
  els.packName.value = pack.name || '';
  els.hidePrompt.checked = !!pack.settings?.hidePrompt;
  els.editorTitle.textContent = `${q.percent}% question`;
  els.prompt.value = q.prompt || '';
  els.accepted.value = Array.isArray(q.accepted) ? q.accepted.join('\n') : '';
  els.explanation.value = q.explanation || '';
  els.choices.value = Array.isArray(q.choices) ? q.choices.join('\n') : '';
  els.imageName.value = q.image || '';
  els.solutionImageName.value = q.solutionImage || '';
  els.scale.value = String(t.scale);
  els.x.value = String(t.x);
  els.y.value = String(t.y);
  els.scaleVal.textContent = Number(t.scale).toFixed(2);
  els.xVal.textContent = String(Math.round(t.x));
  els.yVal.textContent = String(Math.round(t.y));
}

function readEditorIntoPack() {
  const q = currentQ();
  pack.name = els.packName.value.trim() || 'My Question Pack';
  pack.settings = { hidePrompt: !!els.hidePrompt.checked };
  q.prompt = els.prompt.value;
  q.accepted = parseList(els.accepted.value);
  q.explanation = els.explanation.value.trim();
  q.choices = parseList(els.choices.value);
  q.image = els.imageName.value.trim();
  q.solutionImage = els.solutionImageName.value.trim();
  q.imageTransform = {
    scale: Number(els.scale.value),
    x: Number(els.x.value),
    y: Number(els.y.value),
  };
}

function renderChoices(choices) {
  if (!choices?.length) return '';
  return `<div class="q-choices">${choices
    .map((c, i) => {
      const letter = String.fromCharCode(65 + i);
      return `<div class="q-choice"><span class="q-choice__letter">${letter}</span><span class="q-choice__text">${escapeHtml(c)}</span></div>`;
    })
    .join('')}</div>`;
}

function renderPreview() {
  const q = currentQ();
  const t = ensureTransform(q);
  const imageOnly = !!pack.settings?.hidePrompt;
  const qSrc = imageSrc('q', q, selectedIndex);
  const sSrc = imageSrc('s', q, selectedIndex) || qSrc;
  const hasChoices = !imageOnly && Array.isArray(q.choices) && q.choices.length > 0;
  const accepted = (q.accepted || []).slice(0, 3).join(' / ') || '—';

  if (previewMode === 'answer') {
    els.previewMain.innerHTML = `
      <div class="reveal-layout reveal-layout--answer-only">
        <div class="pct-badge" style="align-self:center">${q.percent}%</div>
        ${
          sSrc
            ? `<div class="question-image-wrap question-image-wrap--reveal"><img class="question-image" src="${escapeHtml(sSrc)}" alt="" style="${imageTransformStyle(t)}" /></div>`
            : ''
        }
        <div class="answer-banner">
          <div class="answer-banner__label">CORRECT ANSWER</div>
          <div class="answer-banner__value">${escapeHtml(accepted)}</div>
        </div>
      </div>`;
    return;
  }

  els.previewMain.innerHTML = `
    <div class="question-layout">
      <div class="question-panel">
        <div class="pct-badge">${q.percent}%<small>OF PEOPLE GOT THIS RIGHT</small></div>
        <div class="question-flow ${qSrc ? 'question-flow--has-image' : ''} ${imageOnly ? 'question-flow--image-only' : ''}" data-image-layout="stack">
          ${imageOnly ? '' : `<p class="prompt q-area-prompt">${escapeHtml(q.prompt || 'Prompt…')}</p>`}
          ${
            qSrc
              ? `<div class="question-image-wrap q-area-image"><img class="question-image" src="${escapeHtml(qSrc)}" alt="" style="${imageTransformStyle(t)}" /></div>`
              : ''
          }
          ${hasChoices ? `<div class="q-area-choices">${renderChoices(q.choices)}</div>` : '<div class="q-area-choices"></div>'}
          <div class="q-area-meta">
            <div class="timer" id="tvTimer">30</div>
            <div class="lock-progress">0 / 12 locked in</div>
          </div>
        </div>
      </div>
    </div>`;
}

function refresh() {
  renderSlots();
  fillEditor();
  renderPreview();
  renderImageReminder();
}

function selectIndex(i) {
  readEditorIntoPack();
  selectedIndex = Math.max(0, Math.min(PERCENTS.length - 1, i));
  refresh();
}

function normalizeTransform(t) {
  if (!t || typeof t !== 'object') return { scale: 1, x: 0, y: 0 };
  return {
    scale: Number.isFinite(Number(t.scale)) ? Number(t.scale) : 1,
    x: Number.isFinite(Number(t.x)) ? Number(t.x) : 0,
    y: Number.isFinite(Number(t.y)) ? Number(t.y) : 0,
  };
}

function normalizeLoaded(raw) {
  let name = 'My Question Pack';
  let list = [];
  let hidePrompt = false;
  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw && typeof raw === 'object') {
    name = raw.name || name;
    list = raw.questions || [];
    hidePrompt = !!(raw.settings?.hidePrompt || raw.hidePrompt);
  }
  const byPercent = new Map();
  for (const q of list) {
    const pct = Number(q.percent);
    if (PERCENTS.includes(pct)) byPercent.set(pct, q);
  }
  return {
    name,
    settings: { hidePrompt },
    questions: PERCENTS.map((percent) => {
      const src = byPercent.get(percent) || blankQuestion(percent);
      const q = blankQuestion(percent);
      q.prompt = src.prompt ?? src.question ?? '';
      q.accepted = Array.isArray(src.accepted)
        ? src.accepted.map(String)
        : Array.isArray(src.answers)
          ? src.answers.map(String)
          : src.answer
            ? [String(src.answer)]
            : [];
      q.explanation = src.explanation ? String(src.explanation) : '';
      q.choices = Array.isArray(src.choices) ? src.choices.map(String) : [];
      q.image = src.image ? String(src.image) : `${percent}a.png`;
      q.solutionImage = src.solutionImage
        ? String(src.solutionImage)
        : `${percent}b.png`;
      q.imageTransform = normalizeTransform(src.imageTransform);
      return q;
    }),
  };
}

function exportPack() {
  readEditorIntoPack();
  return {
    name: pack.name,
    settings: { hidePrompt: !!pack.settings?.hidePrompt },
    questions: pack.questions.map((q) => {
      const out = {
        percent: q.percent,
        prompt: q.prompt || '',
        accepted: q.accepted || [],
      };
      if (q.explanation) out.explanation = q.explanation;
      if (q.choices?.length) out.choices = q.choices;
      if (q.image) out.image = q.image;
      if (q.solutionImage) out.solutionImage = q.solutionImage;
      const t = ensureTransform(q);
      if (t.scale !== 1 || t.x !== 0 || t.y !== 0) {
        out.imageTransform = { scale: t.scale, x: t.x, y: t.y };
      }
      return out;
    }),
  };
}

els.slotList.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-i]');
  if (!btn) return;
  selectIndex(Number(btn.getAttribute('data-i')));
});

[
  els.prompt,
  els.accepted,
  els.explanation,
  els.choices,
  els.imageName,
  els.solutionImageName,
  els.packName,
].forEach((el) => {
  el.addEventListener('input', () => {
    readEditorIntoPack();
    renderSlots();
    renderPreview();
    renderImageReminder();
  });
});

els.hidePrompt.addEventListener('change', () => {
  readEditorIntoPack();
  renderPreview();
});

els.fillAbNames.addEventListener('click', () => {
  readEditorIntoPack();
  for (const q of pack.questions) {
    q.image = `${q.percent}a.png`;
    q.solutionImage = `${q.percent}b.png`;
  }
  refresh();
});

function onTransformInput() {
  els.scaleVal.textContent = Number(els.scale.value).toFixed(2);
  els.xVal.textContent = String(Math.round(Number(els.x.value)));
  els.yVal.textContent = String(Math.round(Number(els.y.value)));
  readEditorIntoPack();
  renderPreview();
}

[els.scale, els.x, els.y].forEach((el) => el.addEventListener('input', onTransformInput));

els.resetTransform.addEventListener('click', () => {
  els.scale.value = '1';
  els.x.value = '0';
  els.y.value = '0';
  onTransformInput();
});

function bindImagePicker(input, kind, nameEl) {
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    const key = `${selectedIndex}:${kind}`;
    if (previewBlobs[key]) URL.revokeObjectURL(previewBlobs[key]);
    previewBlobs[key] = URL.createObjectURL(file);
    if (!nameEl.value.trim()) nameEl.value = file.name;
    readEditorIntoPack();
    renderPreview();
    renderImageReminder();
  });
}

bindImagePicker(els.imageFile, 'q', els.imageName);
bindImagePicker(els.solutionImageFile, 's', els.solutionImageName);

els.loadJson.addEventListener('change', async () => {
  const file = els.loadJson.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    clearPreviewBlobs();
    pack = normalizeLoaded(JSON.parse(text));
    selectedIndex = 0;
    refresh();
  } catch (err) {
    alert(`Could not load JSON: ${err.message || err}`);
  }
  els.loadJson.value = '';
});

els.newPack.addEventListener('click', () => {
  if (!confirm('Start a blank 15-slot pack? Unsaved edits will be lost.')) return;
  clearPreviewBlobs();
  pack = blankPack();
  selectedIndex = 0;
  refresh();
});

els.downloadJson.addEventListener('click', () => {
  const data = exportPack();
  const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], {
    type: 'application/json',
  });
  const a = document.createElement('a');
  const slug = slugFromPackName(data.name);
  a.href = URL.createObjectURL(blob);
  a.download = `${slug}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  renderImageReminder();
});

document.querySelectorAll('[data-preview]').forEach((btn) => {
  btn.addEventListener('click', () => {
    previewMode = btn.getAttribute('data-preview');
    document.querySelectorAll('[data-preview]').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    readEditorIntoPack();
    renderPreview();
  });
});

refresh();
