const $ = (id) => document.getElementById(id);
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

const fmt = {
  month: new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' }),
  day: new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }),
  time: new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }),
  full: new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
};

// Local calendar date key, e.g. "2026-09-21".
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const state = {
  config: null,
  month: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  slotsByDay: new Map(),
  selectedDay: null,
  selectedSlot: null,
  loadId: 0,
};

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Une erreur est survenue.');
  return data;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function loadMonth({ autoAdvance = false } = {}) {
  const id = ++state.loadId;
  const from = state.month;
  const to = new Date(from.getFullYear(), from.getMonth() + 1, 1);
  $('month-label').textContent = capitalize(fmt.month.format(from));
  $('pick-status').textContent = 'Chargement des disponibilités…';
  state.slotsByDay = new Map();
  renderDays(true);
  updateNav();

  try {
    const { slots } = await api(`/api/slots?from=${from.toISOString()}&to=${to.toISOString()}`);
    if (id !== state.loadId) return;
    for (const iso of slots) {
      const d = new Date(iso);
      const key = dayKey(d);
      if (!state.slotsByDay.has(key)) state.slotsByDay.set(key, []);
      state.slotsByDay.get(key).push(d);
    }
    $('pick-status').textContent = slots.length ? '' : 'Aucun créneau disponible ce mois-ci.';
  } catch (err) {
    if (id !== state.loadId) return;
    $('pick-status').textContent = err.message;
  }
  renderDays(false);

  // Late in the month there may be nothing left: jump straight to the next month.
  if (autoAdvance && state.slotsByDay.size === 0 && !$('next').disabled) {
    state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1);
    return loadMonth();
  }

  // Keep the current day selection if it still has slots, otherwise pick the first available day.
  if (!state.slotsByDay.has(state.selectedDay)) {
    state.selectedDay = state.slotsByDay.keys().next().value ?? null;
  }
  renderTimes();
}

function renderDays(loading) {
  const grid = $('days');
  grid.replaceChildren();
  const first = state.month;
  const offset = (first.getDay() + 6) % 7; // Monday first
  for (let i = 0; i < offset; i++) grid.append(document.createElement('span'));

  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const today = dayKey(new Date());
  for (let n = 1; n <= daysInMonth; n++) {
    const date = new Date(first.getFullYear(), first.getMonth(), n);
    const key = dayKey(date);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = n;
    btn.className = 'day';
    const available = !loading && state.slotsByDay.has(key);
    btn.disabled = !available;
    if (available) btn.classList.add('available');
    if (key === today) btn.classList.add('today');
    if (key === state.selectedDay) btn.classList.add('selected');
    btn.setAttribute('aria-label', fmt.day.format(date));
    btn.addEventListener('click', () => {
      state.selectedDay = key;
      renderDays(false);
      renderTimes();
    });
    grid.append(btn);
  }
}

function renderTimes() {
  const slots = state.slotsByDay.get(state.selectedDay);
  $('times').hidden = !slots;
  if (!slots) return;
  $('day-label').textContent = capitalize(fmt.day.format(slots[0]));
  const list = $('time-list');
  list.replaceChildren(...slots.map((slot) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'time';
    btn.textContent = fmt.time.format(slot);
    btn.addEventListener('click', () => chooseSlot(slot));
    return btn;
  }));
}

function updateNav() {
  const now = new Date();
  const current = new Date(now.getFullYear(), now.getMonth(), 1);
  const last = new Date(now.getTime() + state.config.maxDaysAhead * 86_400_000);
  $('prev').disabled = state.month <= current;
  $('next').disabled = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1) > last;
}

function chooseSlot(slot) {
  state.selectedSlot = slot;
  const end = new Date(slot.getTime() + state.config.durationMinutes * 60_000);
  $('chosen-text').textContent = `${capitalize(fmt.full.format(slot))} – ${fmt.time.format(end)}`;
  $('chosen').hidden = false;
  $('step-pick').hidden = true;
  $('step-form').hidden = false;
  $('form-error').textContent = '';
  $('step-form').elements.firstName.focus();
}

$('back').addEventListener('click', () => {
  $('step-form').hidden = true;
  $('step-pick').hidden = false;
  $('chosen').hidden = true;
});

$('prev').addEventListener('click', () => {
  state.month = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1);
  loadMonth();
});

$('next').addEventListener('click', () => {
  state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1);
  loadMonth();
});

$('step-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  const submit = $('submit');
  submit.disabled = true;
  submit.textContent = 'Réservation en cours…';
  $('form-error').textContent = '';
  try {
    const body = Object.fromEntries(new FormData(form));
    body.start = state.selectedSlot.toISOString();
    const result = await api('/api/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    $('step-form').hidden = true;
    $('step-done').hidden = false;
    $('done-text').textContent = `${capitalize(fmt.full.format(new Date(result.start)))} (${tz})`;
    if (result.meetLink) {
      $('meet-link').href = result.meetLink;
      $('done-meet').hidden = false;
    }
  } catch (err) {
    $('form-error').textContent = err.message;
    if (/plus disponible/.test(err.message)) loadMonth();
  } finally {
    submit.disabled = false;
    submit.textContent = 'Confirmer le rendez-vous';
  }
});

async function init() {
  $('tz').textContent = tz;
  try {
    state.config = await api('/api/config');
  } catch (err) {
    $('pick-status').textContent = err.message;
    return;
  }
  const c = state.config;
  document.title = c.title;
  $('title').textContent = c.title;
  $('intro').textContent = c.intro;
  $('organizer').textContent = c.organizerName;
  $('duration').textContent = `${c.durationMinutes} min`;
  $('meet-info').hidden = !c.addMeet;
  if (!c.ready) {
    $('pick-status').textContent = 'La prise de rendez-vous n’est pas encore ouverte.';
    return;
  }
  loadMonth({ autoAdvance: true });
}

init();
