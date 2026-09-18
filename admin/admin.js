const $ = (id) => document.getElementById(id);
const form = $('settings');

const DAYS = [
  ['monday', 'Lundi'], ['tuesday', 'Mardi'], ['wednesday', 'Mercredi'], ['thursday', 'Jeudi'],
  ['friday', 'Vendredi'], ['saturday', 'Samedi'], ['sunday', 'Dimanche'],
];
const DEFAULT_RANGE = { start: '09:00', end: '17:00' };

let settings;

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', ...options.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function flash(message, bad = false, duration = 6000) {
  const f = $('flash');
  f.textContent = message;
  f.classList.toggle('bad', bad);
  f.hidden = false;
  clearTimeout(flash.timer);
  if (duration) flash.timer = setTimeout(() => { f.hidden = true; }, duration);
}

// ---------------------------------------------------------------- Google status

async function loadStatus() {
  const box = $('google-status');
  let s;
  try {
    s = await api('/api/admin/status');
  } catch (err) {
    box.textContent = err.message;
    return;
  }
  box.replaceChildren();

  if (!s.configured) {
    box.append(el('p', { className: 'warn', textContent: 'GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET ne sont pas définis dans l’environnement du conteneur.' }));
    return;
  }

  const line = el('div', { className: 'status-line' });
  if (s.connected) {
    line.append(
      el('span', { className: 'pill ok', textContent: 'Connecté' }),
      el('strong', { textContent: s.email ?? '' }),
      el('a', { href: '/admin/oauth/start', textContent: 'Reconnecter' }),
    );
    const disconnect = el('button', { type: 'button', className: 'ghost', textContent: 'Déconnecter' });
    disconnect.addEventListener('click', async () => {
      if (!confirm('Déconnecter le compte Google ? La page publique ne proposera plus de créneaux.')) return;
      await api('/api/admin/disconnect', { method: 'POST' });
      loadStatus();
    });
    line.append(disconnect);
  } else {
    line.append(
      el('span', { className: 'pill ko', textContent: 'Non connecté' }),
      el('a', { href: '/admin/oauth/start', className: 'primary', textContent: 'Connecter mon agenda Google' }),
    );
  }
  box.append(line);

  if (s.apiError) box.append(el('p', { className: 'warn', textContent: `Erreur Google : ${s.apiError}` }));
  for (const e of s.calendarErrors ?? []) {
    box.append(el('p', {
      className: 'warn',
      textContent: `⚠ Impossible de lire les disponibilités de « ${e.id} » (${e.reason}). Vérifiez que cet agenda est partagé avec ${s.email ?? 'votre compte'}.`,
    }));
  }
  box.append(el('p', { className: 'hint' }, 'URI de redirection OAuth à déclarer dans Google Cloud : ', el('code', { textContent: s.redirectUri })));
}

// ---------------------------------------------------------------- simple fields

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => (o[k] ??= {}), obj)[last] = value;
}

function fillFields() {
  for (const input of form.querySelectorAll('[name]')) {
    const value = getPath(settings, input.name);
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = value ?? '';
  }
}

function readFields() {
  for (const input of form.querySelectorAll('[name]')) {
    let value = input.value;
    if (input.type === 'checkbox') value = input.checked;
    else if (input.type === 'number') value = input.value === '' ? 0 : Number(input.value);
    setPath(settings, input.name, value);
  }
}

function fillTimezones() {
  const select = $('timezone');
  const zones = Intl.supportedValuesOf?.('timeZone') ?? [];
  if (!zones.includes(settings.availability.timezone)) zones.unshift(settings.availability.timezone);
  select.replaceChildren(...zones.map((z) => el('option', { value: z, textContent: z })));
}

// ---------------------------------------------------------------- time ranges

function rangeEditor(ranges, onChange) {
  const wrap = el('div', { className: 'ranges' });
  const render = () => {
    wrap.replaceChildren();
    if (!ranges.length) wrap.append(el('span', { className: 'off', textContent: 'Indisponible' }));
    ranges.forEach((r, i) => {
      const node = $('range-tpl').content.firstElementChild.cloneNode(true);
      const start = node.querySelector('.start');
      const end = node.querySelector('.end');
      start.value = r.start;
      end.value = r.end === '24:00' ? '23:59' : r.end;
      start.addEventListener('change', () => { r.start = start.value; });
      end.addEventListener('change', () => { r.end = end.value; });
      node.querySelector('.remove').addEventListener('click', () => {
        ranges.splice(i, 1);
        render();
        onChange?.();
      });
      wrap.append(node);
    });
    const add = el('button', { type: 'button', className: 'icon-btn', textContent: '＋', title: 'Ajouter une plage' });
    add.setAttribute('aria-label', 'Ajouter une plage');
    add.addEventListener('click', () => {
      const prev = ranges.at(-1);
      ranges.push(prev ? nextRange(prev) : { ...DEFAULT_RANGE });
      render();
      onChange?.();
    });
    wrap.append(add);
  };
  render();
  return wrap;
}

// A sensible follow-up range: one hour after the previous one ends.
function nextRange(prev) {
  const [h, m] = prev.end.split(':').map(Number);
  const start = Math.min(h + 1, 22);
  return { start: `${String(start).padStart(2, '0')}:${String(m).padStart(2, '0')}`, end: `${String(start + 1).padStart(2, '0')}:${String(m).padStart(2, '0')}` };
}

function renderWeekly() {
  const container = $('weekly');
  container.replaceChildren();
  for (const [key, label] of DAYS) {
    const ranges = settings.availability.weekly[key];
    const toggle = el('input', { type: 'checkbox', checked: ranges.length > 0 });
    const editor = rangeEditor(ranges, () => { toggle.checked = ranges.length > 0; });
    toggle.addEventListener('change', () => {
      ranges.splice(0, ranges.length, ...(toggle.checked ? [{ ...DEFAULT_RANGE }] : []));
      renderWeekly();
    });
    container.append(el('div', { className: 'day-row' }, el('label', { className: 'day-toggle' }, toggle, label), editor));
  }
}

function renderOverrides() {
  const container = $('overrides');
  container.replaceChildren();
  settings.availability.overrides.forEach((o, i) => {
    const date = el('input', { type: 'date', value: o.date, required: true });
    date.addEventListener('change', () => { o.date = date.value; });
    const remove = el('button', { type: 'button', className: 'icon-btn', textContent: '🗑', title: 'Supprimer cette date' });
    remove.addEventListener('click', () => {
      settings.availability.overrides.splice(i, 1);
      renderOverrides();
    });
    container.append(el('div', { className: 'override-row' }, date, rangeEditor(o.ranges), remove));
  });
}

$('add-override').addEventListener('click', () => {
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  settings.availability.overrides.push({ date: tomorrow, ranges: [] });
  renderOverrides();
});

// ---------------------------------------------------------------- calendars

function renderCalendars() {
  const tbody = $('calendars');
  tbody.replaceChildren();
  if (!settings.calendars.length) {
    tbody.append(el('tr', {}, el('td', { colSpan: 5, className: 'empty', textContent: 'Aucun agenda ajouté : seul votre agenda principal est utilisé.' })));
  }
  settings.calendars.forEach((c, i) => {
    const label = el('input', { type: 'text', value: c.label ?? '', placeholder: 'Nom (facultatif)', maxLength: 100 });
    label.addEventListener('input', () => { c.label = label.value; });
    const check = el('input', { type: 'checkbox', checked: c.checkBusy });
    check.addEventListener('change', () => { c.checkBusy = check.checked; });
    const invite = el('input', { type: 'checkbox', checked: c.invite });
    invite.addEventListener('change', () => { c.invite = invite.checked; });
    const remove = el('button', { type: 'button', className: 'icon-btn', textContent: '🗑', title: 'Retirer' });
    remove.addEventListener('click', () => {
      settings.calendars.splice(i, 1);
      renderCalendars();
    });
    tbody.append(el('tr', {},
      el('td', { className: 'cal-id', textContent: c.id }),
      el('td', {}, label),
      labelledCell('Vérifier', check),
      labelledCell('Inviter', invite),
      el('td', {}, remove),
    ));
  });
}

// The column label is repeated inside the cell for the stacked mobile layout.
function labelledCell(label, child) {
  const td = el('td', {}, child);
  td.dataset.label = label;
  return td;
}

function addCalendar(id, label = '') {
  id = id.trim();
  if (!id) return;
  if (settings.calendars.some((c) => c.id === id)) {
    flash(`« ${id} » est déjà dans la liste.`, true);
    return;
  }
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id) && !id.endsWith('calendar.google.com');
  settings.calendars.push({ id, label, checkBusy: true, invite: isEmail });
  renderCalendars();
}

$('add-cal').addEventListener('click', () => {
  addCalendar($('new-cal').value);
  $('new-cal').value = '';
});
$('new-cal').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('add-cal').click();
  }
});

$('load-cals').addEventListener('click', async () => {
  try {
    const { calendars } = await api('/api/admin/calendars');
    const picker = $('cal-picker');
    picker.replaceChildren(
      el('option', { value: '', textContent: '— Choisir parmi mes agendas —' }),
      ...calendars.filter((c) => !c.primary).map((c) => el('option', { value: c.id, textContent: `${c.summary} (${c.id})` })),
    );
    picker.hidden = false;
    $('load-cals').hidden = true;
  } catch (err) {
    flash(err.message, true);
  }
});

$('cal-picker').addEventListener('change', (e) => {
  const option = e.target.selectedOptions[0];
  if (!option.value) return;
  addCalendar(option.value, option.textContent.replace(/ \(.*\)$/, ''));
  e.target.value = '';
});

// ---------------------------------------------------------------- save

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  $('save-error').textContent = '';
  readFields();
  try {
    settings = await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(settings) });
    render();
    flash('Réglages enregistrés ✓');
    loadStatus();
  } catch (err) {
    $('save-error').textContent = err.message;
  }
});

function render() {
  fillTimezones();
  fillFields();
  renderWeekly();
  renderOverrides();
  renderCalendars();
}

async function init() {
  const params = new URLSearchParams(location.search);
  if (params.has('connected')) flash('Compte Google connecté ✓');
  if (params.has('error')) flash(`Échec de la connexion Google : ${params.get('error')}`, true, 0);
  if (params.size) history.replaceState(null, '', location.pathname);

  loadStatus();
  settings = await api('/api/admin/settings');
  render();
}

init();
