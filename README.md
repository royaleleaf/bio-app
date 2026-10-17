# Willow — Patient Care Chatbot

Hackathon project: a chatbot that answers routine patient/family questions, replaces the call button for small issues, and escalates anything a human nurse needs — to a nurse dashboard where nurses can reply in-app.

## The two sides

| Patient & Family (`/` → login first) | Nurse Dashboard (`/` → "Nurse Dashboard" tab) |
| --- | --- |
| Sign up once with the ward's patient number (MRN), log in with your own username + password after that | Staff accounts (nurse & doctor) see every patient's status (check-in pain, open tickets) |
| Quick-reply chips for common questions | 📅 **Timeline / care plan editor**: add "what to do at what time" — meds, meals, physio, vitals — and mark done |
| 🗓️ **Today's schedule timeline**: see what happens when (💊 medicine at 8:30, 🥗 meals, 🏃 physio…) | Live escalation queue (chat / call-button / check-in tickets) |
| 🔔 Call-nurse button for anything | Reply in-app → appears instantly in the patient's chat |
| 📝 Daily check-in (pain, sleep, appetite, mood) — high pain auto-escalates | Patient summaries with latest daily check-in |

When Willow can't (or shouldn't) answer — worrying symptoms, pain ≥ 7, "please call a nurse" — it stamps the reply with an escalation and it lands on the nurse dashboard, via the LLM's judgment or a keyword safety-net.

**Timeline:** nurses/doctors build each patient's daily schedule (medication times, meals, physio sessions) in the Care Plans view; patients and families see the same timeline on their homepage and can stop asking staff "what time do I take my medicine?".

## Run it

Quick way (from the project root):
```bash
npm run install:all   # first time only — installs backend + frontend
npm start             # → backend on http://localhost:5001
npm run app           # (new terminal) → web app on http://localhost:5173
```

Or run each subproject manually:
```bash
# 1. Backend
cd backend
npm install
cp .env.example .env        # paste your free GEMINI_API_KEY in here
npm start                   # → http://localhost:5001

# 2. Frontend (new terminal)
cd frontend
npm install
npm run dev                 # → http://localhost:5173
```

Open **http://localhost:5173** in two windows to demo the full loop: sign up with a demo patient number (`MRN-1024`, `MRN-2048`, `MRN-3072`), then chat as the family member in one window and answer as a nurse in the other.

### Accounts
- Family signup requires the patient number (MRN). Accounts are hashed (salted SHA-256, never plaintext) and persisted in `backend/data/accounts.json`, so the same username + password works forever, even after a server restart.
- **Staff (nurses & doctors)** log in on the same screen — the *Log in* tab works for everyone. New staff can register via the **Staff** tab with the ward access code (default `WARD-3B`, override with `STAFF_ACCESS_CODE` in `.env` — set your own for production!).
- Seeded demo staff: **nurse1 / nurse123** and **doctor1 / doctor123**.
- Once logged in: families land in their patient's chat; staff land on **Care Plans** (patient status + timeline editing) with the escalation queue one tab away. Sessions survive page refreshes; "Log out" clears it.

### Getting a free AI key
1. Go to https://aistudio.google.com/apikey
2. Sign in → "Create API key" (free tier, no credit card, ~1,500 requests/day)
3. Paste it into `backend/.env` as `GEMINI_API_KEY=...` and restart the backend

Without a key the app still fully works in **fallback mode** — canned replies plus keyword-based escalation — so the demo never breaks.

> Port note: the backend uses **5001** (5000 is AirPlay on macOS).
>
> npm tip: only run npm commands inside the project folders (`backend/`, `frontend/`) or use the root scripts above. Running npm directly in your home folder creates a stray install that hijacks every later command.

## Data

Everything is in-memory (`backend/store.js`) with 3 seeded patients and resets on restart — fine for a demo. Swap `store.js` for a real DB (Supabase/Firebase) before production.

## Stack

Express 5 + vanilla JS (Vite) frontend. LLM via Gemini REST API (no SDK).
