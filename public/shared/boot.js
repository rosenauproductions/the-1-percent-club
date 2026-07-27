/** Connection banner + floating QA feedback widget */

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

export function mountQaWidget(screenName) {
  if (document.getElementById('qaFab')) return;

  const fab = document.createElement('button');
  fab.id = 'qaFab';
  fab.className = 'qa-fab';
  fab.type = 'button';
  fab.textContent = 'QA';
  fab.title = 'Send feedback';

  const panel = document.createElement('div');
  panel.id = 'qaPanel';
  panel.className = 'qa-panel';
  panel.innerHTML = `
    <h3>QA Feedback</h3>
    <p style="margin:0 0 0.5rem;color:#8aa0c8;font-size:0.8rem">
      Screen: <strong>${escapeHtml(screenName)}</strong> ·
      <a href="/qa/" target="_blank" rel="noopener">Open QA board</a>
    </p>
    <label>Type
      <select id="qaType">
        <option value="bug">Bug</option>
        <option value="ux">UX / look</option>
        <option value="rules">Rules / gameplay</option>
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
  panel.querySelector('#qaSubmit').addEventListener('click', async () => {
    const status = panel.querySelector('#qaStatus');
    status.classList.remove('err');
    status.textContent = 'Sending…';
    try {
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
