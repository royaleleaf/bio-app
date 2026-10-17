// In-memory store — intentionally simple for the hackathon demo.
// All state lives here and resets on server restart.
// Accounts are the exception: they persist to backend/data/accounts.json.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let nextId = 1;
function id(prefix) {
  return `${prefix}_${nextId++}`;
}

const patients = new Map([
  [
    'p1',
    {
      id: 'p1',
      mrn: 'MRN-1024',
      name: 'Mrs. Tan Mei Ling',
      room: '304',
      diagnosis: 'Post-op total knee replacement (Day 2)',
      medications: 'Morphine 2.5mg every 4h PRN; Aspirin 75mg daily; Ibuprofen 400mg 3x/day',
      allergies: 'Penicillin',
      physio: 'Knee bends 10 reps, 3x/day',
      diet: 'Soft diet for dysphagia; no grapefruit with BP meds; Asian dietary preferences',
      visitorPolicy: '2 visitors per day, 10am-8pm, no children under 12',
      checkins: [],
    },
  ],
  [
    'p2',
    {
      id: 'p2',
      mrn: 'MRN-2048',
      name: 'Mr. Rajesh Kumar',
      room: '312',
      diagnosis: 'Pneumonia, on IV antibiotics',
      medications: 'IV Ceftriaxone 1g daily; Paracetamol 500mg for fever >38C; Vitamin D supplement',
      allergies: 'None known',
      physio: 'Breathing exercises every 2 hours with incentive spirometer',
      diet: 'Regular diet 3x/day; increase fluids',
      visitorPolicy: '2 visitors per day, 10am-8pm',
      checkins: [],
    },
  ],
  [
    'p3',
    {
      id: 'p3',
      mrn: 'MRN-3072',
      name: 'Ms. Sarah Lim',
      room: '308',
      diagnosis: 'Induced labor - active phase',
      medications: 'Epidural; IV fluids; Oxytocin drip at 12 mU/min',
      allergies: 'Latex',
      physio: 'Bed mobility only',
      diet: 'Clear fluids only until delivery',
      visitorPolicy: 'Partner + 1 other visitor, 24/7 during active labor',
      checkins: [],
    },
  ],
]);

const conversations = new Map(); // patientId -> [{ from: 'family'|'bot'|'nurse', text, ts }]

// ---- Care plan items: the "what to do at what time" timeline ----
const careItems = new Map(); // patientId -> [items sorted by time]

function addCareItem(patientId, { title, type = 'other', time, note = '', createdBy = 'Care team' }) {
  const list = careItems.get(patientId) || [];
  const item = {
    id: id('care'),
    patientId,
    title,
    type,
    time: String(time).slice(0, 5),
    note,
    createdBy,
    doneDates: [],
  };
  list.push(item);
  list.sort((a, b) => a.time.localeCompare(b.time));
  careItems.set(patientId, list);
  return item;
}

function listCareItems(patientId) {
  return [...(careItems.get(patientId) || [])];
}

function deleteCareItem(patientId, itemId) {
  const list = careItems.get(patientId) || [];
  const i = list.findIndex((x) => x.id === itemId);
  if (i === -1) return null;
  const [removed] = list.splice(i, 1);
  return removed;
}

function completeCareItem(patientId, itemId) {
  const list = careItems.get(patientId) || [];
  const item = list.find((x) => x.id === itemId);
  if (!item) return null;
  const today = new Date().toISOString().slice(0, 10);
  if (!item.doneDates.includes(today)) item.doneDates.push(today);
  return item;
}

// Seed each patient's day so the timeline is never empty in the demo
[
  [
    'p1',
    [
      ['medication', '08:30', 'Morning medication — Aspirin 75mg + Ibuprofen 400mg', ''],
      ['physio', '10:00', 'Physio: knee bends — 10 reps', 'With nurse supervision'],
      ['meal', '12:00', 'Lunch — soft diet tray', ''],
      ['medication', '15:00', 'Afternoon pain relief if needed — morphine 2.5mg', 'Only if pain above plan'],
      ['physio', '15:30', 'Physio: knee bends — 10 reps (session 2)', ''],
      ['meal', '18:00', 'Dinner — soft diet tray', ''],
      ['medication', '21:00', 'Night medication — Ibuprofen 400mg', ''],
    ],
  ],
  [
    'p2',
    [
      ['medication', '09:00', 'IV Ceftriaxone 1g', 'Nurse administration'],
      ['meal', '12:00', 'Lunch — regular diet, extra fluids', ''],
      ['physio', '14:00', 'Breathing exercises + incentive spirometer 10 min', ''],
      ['medication', '18:30', 'Paracetamol 500mg if temp >38C', ''],
    ],
  ],
  [
    'p3',
    [
      ['vitals', '08:00', 'Vitals + epidural level check', 'Ward midwife'],
      ['meal', '11:00', 'Clear fluid break', ''],
      ['vitals', '14:00', 'Vitals + epidural level check', 'Ward midwife'],
      ['vitals', '17:00', 'Vitals + fetal monitoring check', 'Ward midwife'],
    ],
  ],
]
  .forEach(([pid, items]) =>
    items.forEach(([type, time, title, note]) => addCareItem(pid, { type, time, title, note }))
  );
const tickets = []; // escalation tickets for the nurse queue

function getPatient(p) {
  const found = patients.get(p);
  if (!found) throw new Error('Unknown patient');
  return found;
}

function getHistory(p) {
  if (!conversations.has(p)) conversations.set(p, []);
  return conversations.get(p);
}

function addMessage(p, from, text) {
  const msg = { from, text, ts: new Date().toISOString() };
  getHistory(p).push(msg);
  return msg;
}

function addCheckin(p, data) {
  getPatient(p); // validates
  const entry = { id: id('chk'), ts: new Date().toISOString(), ...data };
  patients.get(p).checkins.push(entry);
  return entry;
}

function createTicket({ patientId, reason, question, channel }) {
  getPatient(patientId);
  const t = {
    id: id('tk'),
    patientId,
    reason,
    question,
    channel,
    status: 'open',
    reply: null,
    nurse: null,
    ts: new Date().toISOString(),
  };
  tickets.unshift(t);
  return t;
}

function listTickets() {
  return [...tickets];
}

function openTickets() {
  return tickets.filter((t) => t.status === 'open');
}

function replyTicket(tid, reply, nurse) {
  const t = tickets.find((x) => x.id === tid);
  if (!t) return null;
  t.reply = reply;
  t.nurse = nurse;
  t.status = 'answered';
  // Deliver nurse reply into the patient conversation
  addMessage(t.patientId, 'nurse', reply);
  return t;
}

function resolveTicket(tid) {
  const t = tickets.find((x) => x.id === tid);
  if (!t) return null;
  t.status = 'closed';
  return t;
}

// ---- Accounts (survive restarts; passwords are salted + hashed, never stored plain) ----

const DATA_DIR = path.join(__dirname, 'data');
const ACCOUNT_FILE = path.join(DATA_DIR, 'accounts.json');

let accounts = (() => {
  try {
    return JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8'));
  } catch {
    return [];
  }
})();

function saveAccounts() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(accounts, null, 2));
}

function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex');
}

function newAccount({ name, username, password, patientId, role = 'family' }) {
  const salt = crypto.randomBytes(16).toString('hex');
  const acc = {
    id: id('acc'),
    name,
    username: username.toLowerCase(),
    patientId,
    role,
    salt,
    passwordHash: hashPassword(password, salt),
    createdAt: new Date().toISOString(),
  };
  accounts.push(acc);
  saveAccounts();
  return acc;
}

function findAccountByUsername(username) {
  return accounts.find((a) => a.username === String(username).toLowerCase()) || null;
}

function getAccountById(accId) {
  return accounts.find((a) => a.id === accId) || null;
}

function verifyAccount(acc, password) {
  return acc && hashPassword(password, acc.salt) === acc.passwordHash;
}

function sanitizeAccount(acc) {
  const { passwordHash, salt, ...rest } = acc;
  return rest;
}

// Seed demo staff accounts so the demo works instantly (created once, persisted)
function ensureStaffAccounts() {
  const staff = [
    { name: 'Jamie Chen', username: 'nurse1', password: 'nurse123', role: 'nurse' },
    { name: 'Sofia Ng', username: 'doctor1', password: 'doctor123', role: 'doctor' },
  ];
  staff.forEach((s) => {
    if (!findAccountByUsername(s.username)) newAccount({ ...s, patientId: undefined });
  });
}
ensureStaffAccounts();

module.exports = {
  patients,
  conversations,
  getPatient,
  getHistory,
  addMessage,
  addCheckin,
  createTicket,
  listTickets,
  openTickets,
  replyTicket,
  resolveTicket,
  newAccount,
  findAccountByUsername,
  getAccountById,
  verifyAccount,
  sanitizeAccount,
  addCareItem,
  listCareItems,
  deleteCareItem,
  completeCareItem,
};
