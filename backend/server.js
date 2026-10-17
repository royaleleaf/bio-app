require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const store = require('./store');
const llm = require('./llm');

const app = express();
const PORT = process.env.PORT || 5001; // 5000 is AirPlay on macOS
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', ai: llm.hasKey() ? 'configured' : 'fallback', uptime: process.uptime() });
});

// ---- Auth ----
// Sessions are in-memory tokens; accounts themselves persist to disk so the
// SAME username + password keeps working across restarts.
const sessions = new Map(); // token -> accountId

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

function authAccount(req) {
  return store.getAccountById(sessions.get(bearer(req)));
}

// A logged-in family account may only access its own patient's data; staff see all.
function requirePatientAccess(req, res, patientId) {
  const acc = authAccount(req);
  if (!acc) {
    res.status(401).json({ error: 'Please log in first.' });
    return null;
  }
  if (!['nurse', 'doctor'].includes(acc.role) && acc.patientId !== patientId) {
    res.status(403).json({ error: "You can only view your own patient's info." });
    return null;
  }
  return acc;
}

app.post('/api/auth/signup', (req, res) => {
  try {
    const { name, patientNumber, username, password } = req.body || {};
    if (!name || String(name).trim().length < 2) {
      return res.status(400).json({ error: `Please enter the patient's full name.` });
    }
    if (!username || String(username).trim().length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters.' });
    }
    if (!password || String(password).length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    const patient = [...store.patients.values()].find(
      (p) => p.mrn === String(patientNumber || '').trim().toUpperCase()
    );
    if (!patient) {
      return res.status(400).json({
        error: "Patient number not found — please check with the ward staff. (Demo numbers: MRN-1024, MRN-2048, MRN-3072)",
      });
    }
    if (store.findAccountByUsername(username)) {
      return res.status(400).json({ error: 'That username is taken — please pick another.' });
    }
    const acc = store.newAccount({
      name: String(name).trim(),
      username: String(username).trim(),
      password,
      patientId: patient.id,
    });
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, acc.id);
    res.json({ token, account: store.sanitizeAccount(acc) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const acc = store.findAccountByUsername(username || '');
  if (!acc || !store.verifyAccount(acc, password || '')) {
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, acc.id);
  res.json({ token, account: store.sanitizeAccount(acc) });
});

app.get('/api/auth/me', (req, res) => {
  const acc = store.getAccountById(sessions.get(bearer(req)));
  if (!acc) return res.status(401).json({ error: 'Not logged in' });
  res.json({ account: store.sanitizeAccount(acc) });
});

app.post('/api/auth/logout', (req, res) => {
  sessions.delete(bearer(req));
  res.json({ ok: true });
});

// Staff = nurses & doctors. Signup needs the ward access code.
app.post('/api/auth/staff-signup', (req, res) => {
  try {
    const { name, role, accessCode, username, password } = req.body || {};
    const code = process.env.STAFF_ACCESS_CODE || 'WARD-3B';
    if (String(accessCode || '').trim().toUpperCase() !== code.toUpperCase()) {
      return res.status(403).json({
        error: "Wrong ward access code — staff signup needs the code from the ward roster.",
      });
    }
    if (!name || String(name).trim().length < 2) {
      return res.status(400).json({ error: 'Please enter your full name.' });
    }
    if (!['nurse', 'doctor'].includes(role)) {
      return res.status(400).json({ error: 'Role must be nurse or doctor.' });
    }
    if (!username || String(username).trim().length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters.' });
    }
    if (!password || String(password).length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    if (store.findAccountByUsername(username)) {
      return res.status(400).json({ error: 'That username is taken — please pick another.' });
    }
    const acc = store.newAccount({
      name: String(name).trim(),
      username: String(username).trim(),
      password,
      role,
    });
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, acc.id);
    res.json({ token, account: store.sanitizeAccount(acc) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

function requireStaff(req, res, next) {
  const acc = store.getAccountById(sessions.get(bearer(req)));
  if (!acc || !['nurse', 'doctor'].includes(acc.role)) {
    return res.status(403).json({ error: 'Staff login required' });
  }
  req.account = acc;
  next();
}

// Staff home page: every patient's current status at a glance
app.get('/api/staff/summary', requireStaff, (req, res) => {
  res.json(
    [...store.patients.values()].map((p) => ({
      id: p.id,
      name: p.name,
      room: p.room,
      diagnosis: p.diagnosis,
      medications: p.medications,
      allergies: p.allergies,
      latestCheckin: p.checkins[p.checkins.length - 1] || null,
      openTickets: store.openTickets().filter((t) => t.patientId === p.id).length,
      careCount: store.listCareItems(p.id).length,
    }))
  );
});

// ---- Care plan timeline (reads open to families; edits staff-only) ----
app.get('/api/care/:patientId', (req, res) => {
  if (!requirePatientAccess(req, res, req.params.patientId)) return;
  const p = store.patients.get(req.params.patientId);
  if (!p) return res.status(404).json({ error: 'Unknown patient' });
  res.json({ items: store.listCareItems(req.params.patientId) });
});

app.post('/api/care/:patientId', requireStaff, (req, res) => {
  const p = store.patients.get(req.params.patientId);
  if (!p) return res.status(404).json({ error: 'Unknown patient' });
  const { title, type, time, note } = req.body || {};
  if (!title || !time) return res.status(400).json({ error: 'title and time are required' });
  const okTypes = ['medication', 'meal', 'physio', 'vitals', 'other'];
  const item = store.addCareItem(p.id, {
    title: String(title).trim(),
    type: okTypes.includes(type) ? type : 'other',
    time: String(time).slice(0, 5),
    note: note || '',
    createdBy: `${req.account.role === 'doctor' ? 'Dr. ' : 'Nurse '}${req.account.name}`,
  });
  res.json({ item });
});

app.post('/api/care/:patientId/:itemId/complete', requireStaff, (req, res) => {
  const item = store.completeCareItem(req.params.patientId, req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Care item not found' });
  res.json({ item });
});

app.delete('/api/care/:patientId/:itemId', requireStaff, (req, res) => {
  const removed = store.deleteCareItem(req.params.patientId, req.params.itemId);
  if (!removed) return res.status(404).json({ error: 'Care item not found' });
  res.json({ item: removed });
});

// ---- Patients (staff see the whole ward; families fetch only their own) ----
app.get('/api/patients', requireStaff, (req, res) => {
  res.json([...store.patients.values()]);
});

app.get('/api/patients/:id', (req, res) => {
  if (!requirePatientAccess(req, res, req.params.id)) return;
  try {
    res.json(store.getPatient(req.params.id));
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// ---- Chat ----
app.get('/api/chat/:patientId', (req, res) => {
  if (!requirePatientAccess(req, res, req.params.patientId)) return;
  try {
    store.getPatient(req.params.patientId);
    res.json({ messages: store.getHistory(req.params.patientId) });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.post('/api/chat/:patientId', async (req, res) => {
  try {
    if (!requirePatientAccess(req, res, req.params.patientId)) return;
    const patient = store.getPatient(req.params.patientId);
    const text = String(req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text is required' });

    const userMsg = store.addMessage(patient.id, 'family', text);

    const latestCheckin = patient.checkins[patient.checkins.length - 1] || null;
    const history = store.getHistory(patient.id).slice(-12); // keep prompt small

    let botText;
    let escalated = false;
    if (llm.hasKey()) {
      try {
        botText = await llm.callGemini(llm.buildSystemPrompt(patient, latestCheckin), history);
      } catch (e) {
        console.error('LLM call failed:', e.message);
        botText = llm.fallbackReply(text);
      }
    } else {
      botText = llm.fallbackReply(text);
    }

    // Detect the escalation marker and convert it into a nurse ticket
    const marker = botText.match(/CALL_NURSE:\s*(.+)/i);
    let ticket = null;
    if (marker) {
      botText = botText.replace(marker[0], '').trim();
      ticket = store.createTicket({
        patientId: patient.id,
        reason: marker[1].trim(),
        question: text,
        channel: 'chat',
      });
      escalated = true;
    }
    // Explicit nurse request even if the model forgot the marker
    if (!escalated && /\b(call|get|see|talk to)\b.*\b(nurse|doctor)\b|\bnurse\b/i.test(text)) {
      ticket = store.createTicket({
        patientId: patient.id,
        reason: 'Patient/family asked for a nurse via chat',
        question: text,
        channel: 'chat',
      });
      escalated = true;
    }
    // Symptom safety-net: escalate urgent words when no AI is available to judge
    if (!escalated && !llm.hasKey() && /chest pain|trouble breathing|can'?t breathe|bleeding|fever|diz?zy|vomit|emergency|unbearable|pain [7-9]|pain 10/i.test(text)) {
      ticket = store.createTicket({
        patientId: patient.id,
        reason: 'Urgent symptom reported in chat (auto-detected)',
        question: text,
        channel: 'chat',
      });
      escalated = true;
    }

    const botMsg = store.addMessage(patient.id, 'bot', botText);
    res.json({ messages: [userMsg, botMsg], escalated, ticket });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- Call-nurse button (no chat needed) ----
app.post('/api/call-nurse', (req, res) => {
  try {
    const { patientId, reason } = req.body;
    if (!requirePatientAccess(req, res, patientId)) return;
    const t = store.createTicket({
      patientId,
      reason: reason || 'Call button pressed',
      question: null,
      channel: 'button',
    });
    res.json({ ticket: t });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- Daily check-in ----
app.get('/api/checkin/:patientId', (req, res) => {
  if (!requirePatientAccess(req, res, req.params.patientId)) return;
  const p = store.patients.get(req.params.patientId);
  if (!p) return res.status(404).json({ error: 'Unknown patient' });
  res.json({ list: p.checkins, latest: p.checkins[p.checkins.length - 1] || null });
});

app.post('/api/checkin/:patientId', (req, res) => {
  try {
    if (!requirePatientAccess(req, res, req.params.patientId)) return;
    const { pain, sleep, appetite, mood } = req.body;
    const entry = store.addCheckin(req.params.patientId, {
      pain: Number(pain) || 0,
      sleep: String(sleep || ''),
      appetite: String(appetite || ''),
      mood: String(mood || ''),
    });
    const p = store.getPatient(req.params.patientId);
    store.addMessage(
      p.id,
      'bot',
      `Thanks for checking in! You reported pain ${entry.pain}/10, sleep "${entry.sleep}", appetite "${entry.appetite}", mood "${entry.mood}". ${
        entry.pain >= 7 ? "That's high — I'm telling the nurses right away." : "I'll share this with your care team."
      }`
    );
    if (entry.pain >= 7) {
      var t = store.createTicket({
        patientId: req.params.patientId,
        reason: `Check-in reported pain ${entry.pain}/10`,
        question: null,
        channel: 'checkin',
      });
    }
    res.json({ entry, ticket: t || null });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- Nurse dashboard (staff only) ----
app.get('/api/nurse/queue', requireStaff, (req, res) => {
  res.json({ open: store.openTickets(), all: store.listTickets() });
});

app.post('/api/nurse/tickets/:id/reply', requireStaff, (req, res) => {
  const { reply, nurse } = req.body;
  if (!reply) return res.status(400).json({ error: 'reply is required' });
  const t = store.replyTicket(req.params.id, reply, nurse || 'Nurse on duty');
  if (!t) return res.status(404).json({ error: 'Ticket not found' });
  res.json({ ticket: t });
});

app.post('/api/nurse/tickets/:id/close', requireStaff, (req, res) => {
  const t = store.resolveTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'Ticket not found' });
  res.json({ ticket: t });
});

// ---- Fallbacks ----
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT} (AI: ${llm.hasKey() ? llm.GEMINI_MODEL : 'fallback mode'})`);
});
