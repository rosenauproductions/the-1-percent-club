/** Connection banner + floating QA feedback widget (+ audio tools) */

import {
  activateAudio,
  getAudioDebug,
  onAudioDebug,
  playTestTone,
  isAudioActivated,
} from './audio.js';

export function showBoot(message, { error = false } = {}) {
  let el = document.getElementById('bootBanner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'bootBanner';
    el.className = 'boot-banner';
    document.body.appendChild(el);
  }
  el.classList.toggle('error', !!error);
  el.classList.add('show');
  el.innerHTML = message;
}

export function hideBoot() {
  document.getElementById('bootBanner')?.classList.remove('show');
}

export function installErrorHandlers(screenName) {
  window.addEventListener('error', (e) => {
    showBoot(
      `<strong>${screenName} error:</strong> ${escapeHtml(e.message || 'Unknown')}<br/><code>${escapeHtml(location.href)}</code>`,
      { error: true },
    );
  });
  window.addEventListener('unhandledrejection', (e) => {
    const msg = e.reason?.message || String(e.reason || 'Promise failed');
    showBoot(`<strong>${screenName} async error:</strong> ${escapeHtml(msg)}`, { error: true });
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatAudioDebug(d) {
  return `Audio: ${d.activated ? 'UNLOCKED' : 'LOCKED'} · ctx ${d.ctxState}<br/>Last: ${escapeHtml(d.lastPlayResult || '—')}<br/>Cue: ${escapeHtml(d.lastCueSeen || '—')}`;
}

/**
 * @param {string} screenName
 * @param {{ audioTools?: boolean }} [options]
 */
export function mountQaWidget(screenName, options = {}) {
  if (document.getElementById('qaFab')) return;
  const audioTools = options.audioTools !== false;

  const fab = document.createElement('button');
  fab.id = 'qaFab';
  fab.className = 'qa-fab';
  fab.type = 'button';
  fab.textContent = 'QA';
  fab.title = 'Send feedback / audio tools';

  const panel = document.createElement('div');
  panel.id = 'qaPanel';
  panel.className = 'qa-panel';
  panel.innerHTML = `
    <h3>QA Feedback</h3>
    <p style="margin:0 0 0.5rem;color:#8aa0c8;font-size:0.8rem">
      Screen: <strong>${escapeHtml(screenName)}</strong> ·
      <a href="/qa/" target="_blank" rel="noopener">Open QA board</a>
    </p>
    ${
      audioTools
        ? `<div class="qa-audio">
      <h4>Audio</h4>
      <div class="qa-audio-status" id="qaAudioStatus">${formatAudioDebug(getAudioDebug())}</div>
      <div class="qa-audio-actions">
        <button type="button" class="qa-audio-btn" id="qaUnlockAudio">Unlock</button>
        <button type="button" class="qa-audio-btn qa-audio-btn--primary" id="qaTestAudio">Test sound</button>
      </div>
      <p class="qa-audio-hint">On phones: unlock/test must be a tap. You should hear eliminate.mp3.</p>
    </div>`
        : ''
    }
    <label>Type
      <select id="qaType">
        <option value="bug">Bug</option>
        <option value="ux">UX / look</option>
        <option value="rules">Rules / gameplay</option>
        <option value="audio">Audio</option>
        <option value="idea">Idea</option>
        <option value="other">Other</option>
      </select>
    </label>
    <label>Severity
      <select id="qaSeverity">
        <option value="blocker">Blocker</option>
        <option value="major">Major</option>
        <option value="minor" selected>Minor</option>
        <option value="nit">Nit</option>
      </select>
    </label>
    <label>Note
      <textarea id="qaNote" placeholder="What happened? What did you expect?"></textarea>
    </label>
    <label>Your name (optional)
      <input id="qaName" type="text" maxlength="40" placeholder="Chris" />
    </label>
    <div class="qa-actions">
      <button type="button" class="qa-cancel" id="qaCancel">Close</button>
      <button type="button" class="qa-submit" id="qaSubmit">Send</button>
    </div>
    <div class="qa-status" id="qaStatus"></div>
  `;

  document.body.appendChild(fab);
  document.body.appendChild(panel);

  fab.addEventListener('click', () => panel.classList.toggle('open'));
  panel.querySelector('#qaCancel').addEventListener('click', () => panel.classList.remove('open'));

  if (audioTools) {
    const statusEl = panel.querySelector('#qaAudioStatus');
    onAudioDebug((d) => {
      if (statusEl) statusEl.innerHTML = formatAudioDebug(d);
    });
    panel.querySelector('#qaUnlockAudio')?.addEventListener('click', async () => {
      await activateAudio();
    });
    panel.querySelector('#qaTestAudio')?.addEventListener('click', async () => {
      const status = panel.querySelector('#qaStatus');
      status.classList.remove('err');
      status.textContent = 'Playing test…';
      try {
        const ok = await playTestTone();
        status.textContent = ok || isAudioActivated()
          ? 'Test played — did you hear it?'
          : 'Test failed — tap Unlock first';
        if (!ok && !isAudioActivated()) status.classList.add('err');
      } catch (err) {
        status.classList.add('err');
        status.textContent = err.message || 'Test failed';
      }
    });
  }

  panel.querySelector('#qaSubmit').addEventListener('click', async () => {
    const status = panel.querySelector('#qaStatus');
    status.classList.remove('err');
    status.textContent = 'Sending…';
    try {
      const audio = getAudioDebug();
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          screen: screenName,
          type: panel.querySelector('#qaType').value,
          severity: panel.querySelector('#qaSeverity').value,
          note: panel.querySelector('#qaNote').value,
          name: panel.querySelector('#qaName').value,
          url: location.href,
          userAgent: navigator.userAgent,
          audio,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      status.textContent = 'Saved. Thanks!';
      panel.querySelector('#qaNote').value = '';
    } catch (err) {
      status.classList.add('err');
      status.textContent = err.message;
    }
  });
}
