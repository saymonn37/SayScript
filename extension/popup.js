/* SayScript toolbar popup — lists the scripts running on the current tab,
 * with on/off toggles, plus a link to the dashboard. */

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const hostEl = document.getElementById('host');
const connEl = document.getElementById('conn');

document.getElementById('dash-btn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

async function init() {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch { /* ignore */ }

  const url = tab && tab.url || '';
  try { hostEl.textContent = url ? new URL(url).host || url : 'No active tab'; }
  catch { hostEl.textContent = url || 'No active tab'; }

  let data;
  try {
    const res = await chrome.runtime.sendMessage({ __ms_control: true, action: 'get_active_scripts', url });
    if (res && res.ok) data = res.data;
  } catch { /* background asleep */ }

  const connected = data ? data.connected : false;
  connEl.classList.toggle('conn--on', connected);
  connEl.classList.toggle('conn--off', !connected);

  const scripts = (data && data.scripts) || [];
  render(scripts);
}

function render(scripts) {
  listEl.innerHTML = '';
  if (!scripts.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No scripts run on this page.';
    listEl.appendChild(li);
    return;
  }

  for (const s of scripts) {
    const li = document.createElement('li');
    li.className = 'item' + (s.enabled ? '' : ' disabled');

    const ic = document.createElement('span');
    ic.className = 'ic';
    if (s.icon && /^https?:|^data:/.test(s.icon)) {
      const img = document.createElement('img');
      img.src = s.icon; img.alt = '';
      img.onerror = () => { ic.textContent = '📜'; };
      ic.appendChild(img);
    } else {
      ic.textContent = '📜';
    }

    const nm = document.createElement('span');
    nm.className = 'nm';
    const t = document.createElement('div'); t.className = 't'; t.textContent = s.name;
    const v = document.createElement('div'); v.className = 'v'; v.textContent = s.version ? 'v' + s.version : '';
    nm.append(t, v);

    const tg = document.createElement('span');
    tg.className = 'tg' + (s.enabled ? ' on' : '');
    tg.title = s.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable';
    tg.addEventListener('click', async () => {
      const next = !li.classList.contains('disabled') ? false : true;
      // next === desired enabled state
      tg.classList.toggle('on', next);
      li.classList.toggle('disabled', !next);
      try {
        await chrome.runtime.sendMessage({ __ms_control: true, action: 'set_enabled', filename: s.filename, value: next });
      } catch { /* ignore */ }
    });

    li.append(ic, nm, tg);
    listEl.appendChild(li);
  }
}

init();
