import './style.css';

// ---------------- API helpers ----------------
async function api(path, options) {
  const res = await fetch(`/api/${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...options,
  });
  if (!res.ok) {
    // Invalid token → treat as logged out
    if (res.status === 401 && path !== 'auth/login') {
      token = '';
      me = null;
      localStorage.removeItem('willow_token');
    }
    throw new Error((await res.json().catch(() => ({}))).error || res.status);
  }
  return res.json();
}

// ---------------- State ----------------
let patients = [];
let currentPatientId = 'p1';
let view = 'patient';
let chatMessages = [];
let latestCheckin = null;
let me = null;
let token = localStorage.getItem('willow_token') || '';
let staffPatientId = 'p1';

function isStaff() {
  return me && ['nurse', 'doctor'].includes(me.role);
}

const CARE_ICONS = { medication: '💊', meal: '🥗', physio: '🏃', vitals: '🩻', other: '📋' };

const app = document.querySelector('#app');

// ---------------- Renderers ----------------
function render() {
  if (!me) return renderAuth();
  app.innerHTML = `
    <header class="topbar">
      <div class="brand"><span class="brand-logo">🩺</span> Willow <span class="brand-sub">care assistant</span></div>
      ${isStaff() ? `<nav class="views">
        <button class="view-btn ${view === 'patient' ? 'active' : ''}" data-view="patient">Patient &amp; Family</button>
        <button class="view-btn ${view === 'staff' ? 'active' : ''}" data-view="staff">Care Plans</button>
        <button class="view-btn ${view === 'nurse' ? 'active' : ''}" data-view="nurse">Nurse Dashboard</button>
      </nav>` : ''}
      <div class="role-chip">${me.role === 'doctor' ? '🩻 Doctor' : me.role === 'nurse' ? '👩‍⚕️ Nurse' : '🏠 Family'}</div>
      <button class="logout-btn" id="logout-btn">Log out (${escapeHtml(me.username)})</button>
    </header>
    ${view === 'patient' ? renderPatientView() : view === 'nurse' ? renderNurseView() : renderStaffView()}
  `;

  document.getElementById('logout-btn').addEventListener('click', logout);
  app.querySelectorAll('.view-btn').forEach((b) =>
    b.addEventListener('click', () => {
      view = b.dataset.view;
      render();
    })
  );

  if (view === 'patient') wirePatientView();
  else if (view === 'nurse') wireNurseView();
  else wireStaffView();
}

// ---------------- Patient view ----------------
function renderPatientView() {
  const p = patients.find((x) => x.id === currentPatientId) || patients[0] || { name: '?', room: '—' };
  return `
    <main class="patient-main">
      <aside class="sidebar">
        ${isStaff() ? `
        <h2>Ward 3B patients</h2>
        <div class="patient-tabs" id="patient-tabs">
          ${patients
            .map(
              (pt) => `
            <button class="patient-tab ${pt.id === currentPatientId ? 'active' : ''}" data-pid="${pt.id}">
              <span class="p-room">Room ${pt.room}</span>
              <span class="p-name">${escapeHtml(pt.name)}</span>
            </button>`
            )
            .join('')}
        </div>` : `
        <div class="checkin patient-bio">
          <div class="bio-avatar">${escapeHtml((p.name || '?').trim().charAt(0).toUpperCase())}</div>
          <h3>${escapeHtml(p.name)}</h3>
          <p class="bio-room">Room ${escapeHtml(String(p.room))}</p>
          <p class="bio-line">${escapeHtml(p.diagnosis || '')}</p>
          ${p.allergies ? `<p class="bio-line bio-allergy">⚠️ Allergies: ${escapeHtml(p.allergies)}</p>` : ''}
        </div>`}
        <div class="checkin" id="checkin-box">
          <h3>Today's check-in</h3>
          <div id="checkin-status">Loading…</div>
        </div>
        <div class="checkin" id="timeline-box">
          <h3>Today's schedule</h3>
          <div id="timeline-items">Loading…</div>
        </div>
      </aside>
      <section class="chat-card">
        <div class="chat-head">
          <div class="avatar">🌿</div>
          <div class="chat-head-txt">
            <h3>Willow · Room ${escapeHtml(String(p.room))}</h3>
            <p>Answers routine questions — urgent ones reach the care team.</p>
          </div>
          <button id="call-nurse-btn" class="btn danger call-nurse-top" title="Send an urgent request to a nurse"><span class="cn-bell">🔔</span><span>Call nurse</span></button>
        </div>
        <div class="chat-scroll" id="chat-scroll"><div class="chat-msgs" id="chat-msgs"></div></div>
        <div class="chips" id="chips">
          ${[
            'What are the visiting hours?',
            'When is my next medication?',
            'What should I eat for dinner?',
            'How do I do my physio exercises?',
          ]
            .map((q) => `<button class="chip" data-q="${q}">${q}</button>`)
            .join('')}
        </div>
        <form id="chat-form" class="chat-form">
          <input id="chat-input" placeholder="Type a question…" autocomplete="off" />
          <button type="submit" class="btn primary">Send</button>
        </form>
        <div class="chat-actions">
          <button id="checkin-btn" class="btn ghost">📝 Daily check-in</button>
        </div>
        <div id="checkin-form-box"></div>
        <div id="toast"></div>
      </section>
    </main>
  `;
}

function renderCheckinForm() {
  const pillRow = (name, opts) => `
    <div class="pill-row">${opts
      .map(
        ([v, t], i) =>
          `<label class="pill"><input type="radio" name="${name}" value="${v}" ${i === 0 ? 'checked' : ''}><span>${t}</span></label>`
      )
      .join('')}</div>`;
  return `
    <form id="checkin-form" class="checkin-form">
      <div class="cf-block cf-pain">
        <label>How much pain right now?</label>
        <div class="pain-control">
          <span class="pain-face" id="pain-face">🙂</span>
          <input type="range" id="cf-pain" min="0" max="10" value="3" step="1" />
          <span class="pain-num"><strong id="pain-val">3</strong>/10</span>
        </div>
        <div class="pain-scale"><span>0 · none</span><span>5 · bad</span><span>10 · worst</span></div>
      </div>
      <div class="cf-block">
        <label>😴 Sleep last night</label>
        ${pillRow('sleep', [
          ['Slept well', '😴 Well'],
          ['Woke a few times', '😐 Woke often'],
          ['Barely slept', '😵 Barely slept'],
        ])}
      </div>
      <div class="cf-block">
        <label>🍽 Appetite</label>
        ${pillRow('appetite', [
          ['Normal', '🍽 Normal'],
          ['Low, ate a little', '🥣 Low'],
          ["Couldn't eat", "❌ Couldn't eat"],
        ])}
      </div>
      <div class="cf-block">
        <label>💬 Mood / how you feel</label>
        ${pillRow('mood', [
          ['Okay', '🙂 Okay'],
          ['Stressed', '😟 Stressed'],
          ['Very uncomfortable', '😫 Uncomfortable'],
        ])}
      </div>
      <div class="cf-actions">
        <button type="submit" class="btn primary">Submit check-in</button>
        <button type="button" class="btn ghost" id="checkin-cancel">Cancel</button>
      </div>
    </form>
  `;
}

function wirePatientView() {
  const tabs = document.getElementById('patient-tabs');
  if (tabs) {
    tabs.querySelectorAll('.patient-tab').forEach((b) =>
      b.addEventListener('click', () => {
        currentPatientId = b.dataset.pid;
        render();
      })
    );
  }

  document.getElementById('chips').querySelectorAll('.chip').forEach((c) =>
    c.addEventListener('click', () => {
      document.getElementById('chat-input').value = c.dataset.q;
      document.getElementById('chat-form').dispatchEvent(new Event('submit'));
    })
  );

  document.getElementById('call-nurse-btn').addEventListener('click', async () => {
    try {
      await api('call-nurse', { method: 'POST', body: JSON.stringify({ patientId: currentPatientId, reason: 'Call button pressed (chat app)' }) });
      toast('Nurse called — they\'ll see this on their dashboard.');
    } catch (e) {
      toast(`Failed: ${e.message}`);
    }
  });

  document.getElementById('checkin-btn').addEventListener('click', () => {
    document.getElementById('checkin-form-box').innerHTML = renderCheckinForm();
    const form = document.getElementById('checkin-form');
    const pain = document.getElementById('cf-pain');
    const PAIN_FACES = ['😀', '🙂', '🙂', '😐', '😕', '😣', '😖', '😣', '😫', '😫', '😭'];
    const paintPain = () => {
      document.getElementById('pain-val').textContent = pain.value;
      document.getElementById('pain-face').textContent = PAIN_FACES[pain.value];
    };
    pain.addEventListener('input', paintPain);
    paintPain();
    document.getElementById('checkin-cancel').addEventListener('click', () => (document.getElementById('checkin-form-box').innerHTML = ''));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api(`checkin/${currentPatientId}`, {
          method: 'POST',
          body: JSON.stringify({
            pain: pain.value,
            sleep: form.querySelector('input[name="sleep"]:checked').value,
            appetite: form.querySelector('input[name="appetite"]:checked').value,
            mood: form.querySelector('input[name="mood"]:checked').value,
          }),
        });
        document.getElementById('checkin-form-box').innerHTML = '';
        await refreshCheckin();
        await refreshChat();
        toast('Check-in submitted — visible to your care team.');
      } catch (err) {
        toast(`Failed: ${err.message}`);
      }
    });
  });

  document.getElementById('chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    appendLocal('family', text);
    try {
      const data = await api(`chat/${currentPatientId}`, { method: 'POST', body: JSON.stringify({ text }) });
      // Only render what we don't already have locally
      const serverMsgs = data.messages;
      const alreadyLocal = chatMessages.filter((m) => m.local).length;
      if (serverMsgs.length > alreadyLocal) chatMessages.push(...serverMsgs.slice(alreadyLocal));
      chatMessages.forEach((m) => (m.local = false));
      renderChatMsgs();
      if (data.escalated) toast('🔔 Sent to the nurse dashboard — a nurse will reply here.');
    } catch (err) {
      appendLocal('bot', `⚠️ ${err.message}`);
    }
  });

  refreshChat();
  refreshCheckin();
  refreshTimeline();
}

// ---------------- Timeline (shared by patient & staff views) ----------------
function timelineHtml(items, { staff = false, pid = '' } = {}) {
  if (!items.length) {
    return '<p class="empty-tl">Nothing scheduled yet — the care team will add items.</p>';
  }
  const now = new Date();
  const nowHM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const today = now.toISOString().slice(0, 10);
  const sorted = [...items].sort((a, b) => a.time.localeCompare(b.time) || a.title.localeCompare(b.title));

  return sorted
    .map((item) => {
      const done = (item.doneDates || []).includes(today);
      const past = !done && item.time < nowHM;
      return `
      <div class="tl-row ${done ? 'done' : ''} ${past && staff ? 'past' : ''}">
        <span class="tl-time">${item.time}</span>
        <span class="tl-ico">${CARE_ICONS[item.type] || '📋'}</span>
        <div class="tl-body">
          <div class="tl-title">${escapeHtml(item.title)}${done ? ' ✅' : ''}</div>
          ${item.note ? `<div class="tl-note">${escapeHtml(item.note)}</div>` : ''}
          ${staff
            ? `<div class="tl-staff-row">
                <span class="tl-by">added by ${escapeHtml(item.createdBy || 'Care team')}</span>
                <span class="tl-staff-btns">
                  <button class="tl-btn tl-done-btn" data-pid="${pid}" data-id="${item.id}" ${done ? 'disabled' : ''}>${done ? '✔ done' : 'mark done'}</button>
                  <button class="tl-btn tl-del-btn" data-pid="${pid}" data-id="${item.id}">🗑</button>
                </span>
              </div>`
            : ''}
        </div>
      </div>`;
    })
    .join('');
}

async function refreshTimeline() {
  const box = document.getElementById('timeline-items');
  if (!box) return;
  try {
    const data = await api(`care/${currentPatientId}`);
    box.innerHTML = timelineHtml(data.items);
  } catch {
    box.innerHTML = '—';
  }
}

// ---------------- Staff home: patient status + care plan editor ----------------
function renderStaffView() {
  return `
    <main class="staff-main">
      <section class="staff-col">
        <h2>${isStaff() && me.role === 'doctor' ? '🩻' : '👩‍⚕️'} Ward 3B — patient status</h2>
        <div id="staff-patients">Loading…</div>
      </section>
      <section class="staff-col wide">
        <h2>📅 Care plan · <span id="care-patient-name">…</span></h2>
        <form id="care-add-form" class="care-add-form">
          <div class="caf-row">
            <label>Time</label><input type="time" id="ca-time" required />
            <label>Type</label>
            <select id="ca-type">
              <option value="medication">💊 Medication</option>
              <option value="meal">🥗 Meal / diet</option>
              <option value="physio">🏃 Physio</option>
              <option value="vitals">🩻 Vitals / checks</option>
              <option value="other">📋 Other</option>
            </select>
          </div>
          <div class="caf-row">
            <label>What to do</label><input id="ca-title" required placeholder="e.g. Evening medication — Ibuprofen 400mg" />
          </div>
          <div class="caf-row">
            <label>Note (optional)</label><input id="ca-note" placeholder="e.g. Only if pain above 5/10" />
          </div>
          <button type="submit" class="btn primary">+ Add to timeline</button>
        </form>
        <div id="staff-timeline" class="staff-timeline">Loading…</div>
      </section>
    </main>
  `;
}

function appendLocal(from, text) {
  chatMessages.push({ from, text, ts: new Date().toISOString(), local: true });
  renderChatMsgs();
}

function autoT() {
  const s = document.getElementById('chat-scroll');
  if (s) s.scrollTop = s.scrollHeight;
}

function renderChatMsgs() {
  const box = document.getElementById('chat-msgs');
  if (!box) return;
  box.innerHTML = chatMessages
    .map((m) => {
      const who = m.from === 'family' ? 'family' : m.from === 'nurse' ? 'nurse' : 'bot';
      return `<div class="msg ${who}">
        <div class="msg-who">${who === 'family' ? 'You' : who === 'nurse' ? '👩‍⚕️ Nurse (in-app)' : 'Willow'}</div>
        <div class="msg-bubble">${escapeHtml(m.text)}</div>
      </div>`;
    })
    .join('');
  autoT();
}

async function refreshChat() {
  try {
    const data = await api(`chat/${currentPatientId}`);
    const hadLocal = chatMessages.filter((m) => m.local).length;
    chatMessages = data.messages;
    if (hadLocal) {
      const pending = window.__pending || [];
      pending.forEach(() => {}); // local optimistic messages already sent with request
    }
    renderChatMsgs();
  } catch {
    /* backend offline */
  }
}

async function refreshCheckin() {
  const box = document.getElementById('checkin-status');
  try {
    const data = await api(`checkin/${currentPatientId}`);
    latestCheckin = data.latest;
    box.innerHTML = latestCheckin
      ? `<div class="checkin-done">✅ Pain <b>${latestCheckin.pain}/10</b> · Sleep: ${escapeHtml(latestCheckin.sleep)}<br>Appetite: ${escapeHtml(latestCheckin.appetite)} · Mood: ${escapeHtml(latestCheckin.mood)}</div>`
      : 'No check-in yet today.';
  } catch {
    box.innerHTML = '—';
  }
}

// ---------------- Nurse view ----------------
function renderNurseView() {
  return `
    <main class="nurse-main">
      <section class="queue">
        <h2>🔔 Escalation queue <span class="queue-count" id="queue-count">…</span></h2>
        <div id="queue-list"></div>
        <h2>Recently handled</h2>
        <div id="done-list"></div>
      </section>
      <aside class="nurse-side">
        <h2>Tapient summary</h2>
        <div id="patient-cards"></div>
      </aside>
    </main>
  `;
}

function wireNurseView() {
  refreshNurse();
}

function wireStaffView() {
  document.getElementById('staff-patients').addEventListener('click', (e) => {
    const card = e.target.closest('.pcard[data-pid]');
    if (!card) return;
    staffPatientId = card.dataset.pid;
    refreshStaff(false); // don't wipe the add-form while typing
  });

  const pats = patients.find((p) => p.id === staffPatientId);
  const nameEl = document.getElementById('care-patient-name');
  if (nameEl && pats) nameEl.textContent = `${pats.name} · Room ${pats.room}`;

  document.getElementById('care-add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`care/${staffPatientId}`, {
        method: 'POST',
        body: JSON.stringify({
          time: document.getElementById('ca-time').value,
          type: document.getElementById('ca-type').value,
          title: document.getElementById('ca-title').value,
          note: document.getElementById('ca-note').value,
        }),
      });
      await refreshStaff();
      toastN('Added to the patient\'s timeline — they can see it now.');
    } catch (err) {
      toastN(`Failed: ${err.message}`);
    }
  });

  document.getElementById('staff-timeline').addEventListener('click', async (e) => {
    const doneBtn = e.target.closest('.tl-done-btn');
    const delBtn = e.target.closest('.tl-del-btn');
    if (!doneBtn && !delBtn) return;
    const { pid, id: itemId } = doneBtn?.dataset || delBtn.dataset;
    try {
      if (doneBtn) await api(`care/${pid}/${itemId}/complete`, { method: 'POST' });
      else await api(`care/${pid}/${itemId}`, { method: 'DELETE' });
      refreshStaff(null, true);
    } catch (err) {
      toastN(`Failed: ${err.message}`);
    }
  });

  refreshStaff();
}

let lastCareRender = 0; // poll guard while a form is open
async function refreshStaff(full = true, force = false) {
  const holder = document.getElementById('staff-patients');
  const tl = document.getElementById('staff-timeline');
  if (!holder || !tl) return;
  if (!force && full && Date.now() - lastCareRender < 2500) return;
  try {
    const [summary, care] = await Promise.all([api('staff/summary'), api(`care/${staffPatientId}`)]);
    if (full) {
      holder.innerHTML = summary
        .map(
          (p) => `
        <div class="pcard staff-sel ${p.id === staffPatientId ? 'active' : ''}" data-pid="${p.id}">
          <div class="pc-top"><b>${escapeHtml(p.name)}</b><span class="tk-room">Room ${p.room}</span>
            ${p.openTickets ? `<span class="tk-urgent">🔔 ${p.openTickets} open</span>` : ''}</div>
          <p class="p-diag">${escapeHtml(p.diagnosis)}</p>
          ${p.latestCheckin
            ? `<p class="p-checkin">Pain ${p.latestCheckin.pain}/10 · Sleep: ${escapeHtml(p.latestCheckin.sleep)} · Mood: ${escapeHtml(p.latestCheckin.mood)}</p>`
            : '<p class="p-checkin dim">No check-in yet today</p>'}
          <p class="p-checkin dim">Timeline: ${p.careCount} items today</p>
        </div>`
        )
        .join('');
    }
    const pats = patients.find((p) => p.id === staffPatientId);
    const nameEl = document.getElementById('care-patient-name');
    if (nameEl && pats) nameEl.textContent = `${pats.name} · Room ${pats.room}`;
    tl.innerHTML = timelineHtml(care.items, { staff: true, pid: staffPatientId });
    lastCareRender = Date.now();
  } catch {
    /* backend offline */
  }
}

async function refreshNurse() {
  if (view !== 'nurse' || !document.getElementById('queue-list')) return;
  try {
    const [{ open, all }, pats] = await Promise.all([api('nurse/queue'), api('patients')]);

    const count = document.getElementById('queue-count');
    count.textContent = `${open.length} open`;

    const ql = document.getElementById('queue-list');
    ql.innerHTML =
      open
        .map(
          (t) => `
      <div class="ticket ${t.channel}">
        <div class="tk-top">
          <span class="tk-room">${roomOf(t.patientId)}</span>
          <span class="tk-patient">${nameOf(t.patientId)}</span>
          <span class="tk-channel">via ${t.channel === 'button' ? '🔔 call button' : t.channel === 'checkin' ? '📝 check-in' : '💬 chatbot'}</span>
        </div>
        <p class="tk-reason"><b>${escapeHtml(t.reason)}</b></p>
        ${t.question ? `<p class="tk-q">"${escapeHtml(t.question)}"</p>` : ''}
        <form class="tk-reply-form" data-tid="${t.id}">
          <input placeholder="Reply to ${nameOf(t.patientId)}…" required />
          <button class="btn primary" type="submit">Reply</button>
        </form>
      </div>`
        )
        .join('') || '<p class="empty">✨ Queue empty — the chatbot is handling it.</p>';

    ql.querySelectorAll('.tk-reply-form').forEach((f) =>
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = f.querySelector('input');
        const reply = input.value.trim();
        if (!reply) return;
        try {
          await api(`nurse/tickets/${f.dataset.tid}/reply`, {
            method: 'POST',
            body: JSON.stringify({ reply, nurse: 'Nurse J. Chen' }),
          });
          toastN('Reply delivered to the patient chat.');
          refreshNurse();
        } catch (err) {
          toastN(`Failed: ${err.message}`);
        }
      })
    );

    document.getElementById('done-list').innerHTML =
      all
        .filter((t) => t.status !== 'open')
        .slice(0, 6)
        .map(
          (t) => `
      <div class="ticket handled">
        <div class="tk-top"><span class="tk-room">${roomOf(t.patientId)}</span><span class="tk-patient">${nameOf(t.patientId)}</span><span class="tk-status">${t.status} · ${t.nurse || ''}</span></div>
        <p class="tk-reason">${escapeHtml(t.reason)}${t.reply ? ` — <i>"${escapeHtml(t.reply)}"</i>` : ''}</p>
      </div>`
        )
        .join('') || '<p class="empty">Nothing handled yet.</p>';

    document.getElementById('patient-cards').innerHTML = pats
      .map((p) => {
        const c = p.checkins[p.checkins.length - 1];
        return `<div class="pcard">
          <div class="pc-top"><b>${escapeHtml(p.name)}</b><span class="tk-room">Room ${p.room}</span></div>
          <p class="p-diag">${escapeHtml(p.diagnosis)}</p>
          ${c ? `<p class="p-checkin">Pain ${c.pain}/10 · Sleep: ${escapeHtml(c.sleep)} · ${escapeHtml(c.appetite)}</p>` : '<p class="p-checkin dim">No check-in yet</p>'}
        </div>`;
      })
      .join('');
  } catch {
    /* backend offline */
  }
}

function roomOf(pid) {
  return patients.find((p) => p.id === pid)?.room ?? '?';
}
function nameOf(pid) {
  return patients.find((p) => p.id === pid)?.name ?? pid;
}

// ---------------- Toasts ----------------
function toast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3500);
}
const toastN = toast;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------------- Auth ----------------
function renderAuth() {
  app.innerHTML = `
    <header class="topbar">
      <div class="brand"><span class="brand-logo">🩺</span> Willow <span class="brand-sub">care assistant</span></div>
    </header>
    <main class="auth-wrap">
      <div class="auth-card">
        <h1>Welcome to Willow 🌿</h1>
        <p class="auth-sub">One account per family. Sign up once with the ward's patient number — then log in any time, from any device.</p>
        <div class="auth-tabs">
          <button class="auth-tab active" data-mode="login">Log in</button>
          <button class="auth-tab" data-mode="signup">First time? Sign up</button>
          <button class="auth-tab" data-mode="staff">👩‍⚕️ Staff</button>
        </div>
        <div class="auth-error" id="auth-error"></div>
        <form id="auth-form" autocomplete="on"></form>
      </div>
    </main>
  `;

  let mode = 'login';
  const form = document.getElementById('auth-form');
  const tabs = app.querySelectorAll('.auth-tab');

  const loginHtml = `
    <div class="auth-field"><label>Username</label><input name="username" required autocomplete="username" /></div>
    <div class="auth-field"><label>Password</label><input name="password" type="password" required autocomplete="current-password" /></div>
    <button type="submit" class="btn primary auth-submit">Log in</button>
    <div class="auth-hint">Nurses &amp; doctors log in here too — demo: nurse1 / nurse123 · doctor1 / doctor123</div>
  `;
  const signupHtml = `
    <div class="auth-field"><label>Patient's full name</label><input name="name" required placeholder="e.g. Mrs. Tan Mei Ling" /></div>
    <div class="auth-field"><label>Patient number (on the wristband / ward slip)</label><input name="patientNumber" required placeholder="e.g. MRN-1024" /></div>
    <div class="auth-hint">Demo numbers: MRN-1024 · MRN-2048 · MRN-3072</div>
    <div class="auth-field"><label>Username — what you'll remember</label><input name="username" required minlength="3" autocomplete="username" placeholder="e.g. tan-family" /></div>
    <div class="auth-field"><label>Password — mine, 6+ characters</label><input name="password" type="password" required minlength="6" autocomplete="new-password" /></div>
    <button type="submit" class="btn primary auth-submit">Create account &amp; continue</button>
  `;
  const staffHtml = `
    <div class="auth-sub">Doctors &amp; nurses: create your account with the ward access code, then log in above.</div>
    <div class="auth-field"><label>Your full name</label><input name="name" required placeholder="e.g. Jamie Chen" /></div>
    <div class="auth-field"><label>Role</label>
      <select name="role"><option value="nurse">Nurse</option><option value="doctor">Doctor</option></select>
    </div>
    <div class="auth-field"><label>Ward access code (on the ward roster)</label><input name="accessCode" required placeholder="e.g. WARD-3B" /></div>
    <div class="auth-field"><label>Username</label><input name="username" required minlength="3" autocomplete="username" /></div>
    <div class="auth-field"><label>Password — 6+ characters</label><input name="password" type="password" required minlength="6" autocomplete="new-password" /></div>
    <button type="submit" class="btn primary auth-submit">Create staff account</button>
  `;

  function paint() {
    form.innerHTML = mode === 'login' ? loginHtml : mode === 'signup' ? signupHtml : staffHtml;
  }

  tabs.forEach((t) =>
    t.addEventListener('click', () => {
      mode = t.dataset.mode;
      tabs.forEach((x) => x.classList.toggle('active', x === t));
      document.getElementById('auth-error').textContent = '';
      paint();
    })
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const errBox = document.getElementById('auth-error');
    try {
      const endpoint = mode === 'login' ? 'auth/login' : mode === 'signup' ? 'auth/signup' : 'auth/staff-signup';
      const out = await api(endpoint, { method: 'POST', body: JSON.stringify(data) });
      token = out.token;
      me = out.account;
      localStorage.setItem('willow_token', token);
      await initApp();
    } catch (err) {
      errBox.textContent = err.message;
    }
  });

  paint();
}

async function logout() {
  try {
    await api('auth/logout', { method: 'POST' });
  } catch {
    /* best effort */
  }
  token = '';
  me = null;
  localStorage.removeItem('willow_token');
  chatMessages = [];
  renderAuth();
}

// ---------------- Boot ----------------
async function boot() {
  // Reuse a saved session if it's still valid
  if (token) {
    try {
      const data = await api('auth/me');
      me = data.account;
    } catch {
      token = '';
      me = null;
      localStorage.removeItem('willow_token');
    }
  }
  if (!me) {
    renderAuth();
    return;
  }
  await initApp();

  // Polling: dashboards + chat + timeline sync every 3s (single poller, survives logins)
  setInterval(() => {
    if (!me) return;
    if (view === 'nurse') refreshNurse();
    else if (view === 'staff') refreshStaff();
    else {
      refreshChat();
      refreshTimeline();
    }
  }, 3000);
}async function initApp() {
  if (isStaff()) {
    try {
      patients = await api('patients');
    } catch {
      patients = [{ id: 'p1', name: 'Backend offline', room: '—', diagnosis: '', checkins: [] }];
    }
    view = 'staff';
  } else {
    // Families see ONLY their own patient — enforced server-side too
    currentPatientId = me.patientId;
    try {
      patients = [await api(`patients/${me.patientId}`)];
    } catch {
      patients = [{ id: me.patientId, name: 'Backend offline', room: '—', diagnosis: '', checkins: [] }];
    }
    view = 'patient';
  }
  chatMessages = [];
  render();
}

boot();
