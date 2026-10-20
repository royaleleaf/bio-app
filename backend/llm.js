// Gemini LLM integration with graceful fallback if no key is present.
// Uses the REST endpoint directly — no SDK needed.

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

function hasKey() {
  return Boolean(process.env.GEMINI_API_KEY);
}

function buildSystemPrompt(patient, latestCheckin) {
  return `You are "Willow", the in-room care assistant for ${patient.name}, a hospital patient in room ${patient.room}. You are used by the patient AND their visiting family members.

## Important context about this patient
- Condition: ${patient.diagnosis}
- Current medications: ${patient.medications}
- Allergies: ${patient.allergies}
- Physiotherapy: ${patient.physio}
- Diet: ${patient.diet}
- Visitor policy: ${patient.visitorPolicy}
${latestCheckin ? `- Latest daily check-in (${latestCheckin.ts}): pain ${latestCheckin.pain}/10, sleep "${latestCheckin.sleep}", appetite "${latestCheckin.appetite}", mood "${latestCheckin.mood}"` : '- No daily check-in completed yet today.'}

## Your job
1. Answer routine questions from the info above and general care guidance (meal times, visitor rules, how call buttons work, what a medication is for, etc).
2. Reduce nurse interruptions: if a question can be answered without a nurse, just answer it.
3. ESCALATION RULE: If the patient or family (a) reports worrying symptoms — chest pain, trouble breathing, sudden severe pain, bleeding, fever above 38C, numbness, confusion, or pain above 7/10, (b) explicitly asks for a nurse, or (c) asks something you cannot answer from the context — then END your reply with a final line in this exact format:
CALL_NURSE: <one short sentence reason>
Everything before that line will be shown to the family, the request will be surfaced in the nurse dashboard.
4. Never prescribe, change doses, or give medical instructions that contradict the care plan. Never reveal other patients' info.
5. Keep replies warm, short (under 120 words), and plain-language. If the visitor asks who you are, say you're Willow, the ward's care assistant.
6. If a check-in exists, you may reference it (e.g. "I see you reported pain 3/10 this morning").`;
}

async function callGemini(systemPrompt, history) {
  const key = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: history.map((m) => ({
      role: m.from === 'bot' ? 'model' : 'user',
      parts: [{ text: m.text }],
    })),
    generationConfig: { temperature: 0.4, maxOutputTokens: 400 },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000), // this network stalls sometimes; never hang the chat
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Gemini API ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((p) => p.text || '')
    .join('')
    .trim();
  if (!text) throw new Error('Empty response from Gemini');
  return text;
}

// Keyword safety-net shared with server.js: anything matched here is escalated
// into a nurse ticket, and the fallback reply below tells the family so.
function needsNurse(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(nurse|doctor)\b/.test(t)) return true;
  if (
    /chest pain|trouble breathing|can'?t breathe|short of breath|bleeding|blood|fever|dizz|vomit|emergency|unbearable|collaps|faint|numb|confus|swelling|swollen/.test(
      t
    )
  ) {
    return true;
  }
  const score = t.match(/\b(\d{1,2})\s*(?:\/|out of)\s*10\b/) || t.match(/pain\D{0,10}?(\d{1,2})/);
  return Boolean(score && Number(score[1]) >= 7);
}

function timeNow() {
  return new Date().toTimeString().slice(0, 5);
}

// Offline mode (no GEMINI_API_KEY): answer routine questions from the patient's
// own record and care-plan timeline instead of nagging about the missing key.
function fallbackReply(text, patient = {}, careItems = []) {
  const t = String(text || '').toLowerCase();
  const has = (re) => re.test(t);
  const name = patient.name || 'the patient';
  const room = patient.room ? `room ${patient.room}` : 'the ward';
  const today = new Date().toISOString().slice(0, 10);
  const now = timeNow();
  const pending = (careItems || [])
    .filter((i) => i.time >= now && !(i.doneDates || []).includes(today))
    .sort((a, b) => a.time.localeCompare(b.time));
  const listOf = (items, n = 3) =>
    items
      .slice(0, n)
      .map((i) => `${i.time} – ${i.title}`)
      .join('; ');

  const urgent = needsNurse(t);
  if (urgent) {
    return "That needs a nurse's attention, so I've flagged it on the nurse dashboard — they'll reply here as soon as they can. Please press the call-nurse button too if it's urgent.";
  }

  if (has(/\b(hi|hello|hey|good (morning|afternoon|evening))\b|who are you|your name|^help$/)) {
    return `Hi! I'm Willow, the care assistant for ${name} in ${room}. I can tell you about visiting hours, ${patient.room ? 'the room, ' : ''}meals, medication and physio times, allergies, or today's schedule. What would you like to know?`;
  }

  if (has(/visit|visitor|family|guest|hours|come and see|see (him|her|them)/)) {
    return `Visiting for ${name}: ${patient.visitorPolicy || 'please check with the ward staff'}.`;
  }

  if (has(/\broom\b|where (is|are)|location|which floor|ward/)) {
    return `${name} is in ${room} (patient number ${patient.mrn || 'on file'}).`;
  }

  if (has(/medic|medicine|meds?|pills?|tablet|drug|dose|morphine|paracetamol|aspirin|ibuprofen|antibiotic/)) {
    const meds = pending.filter((i) => i.type === 'medication');
    const line = meds.length
      ? `Next up today: ${listOf(meds)}.`
      : "There's nothing further on today's medication timeline.";
    const allergy = patient.allergies ? ` Known allergies: ${patient.allergies}.` : '';
    return `${line}${allergy} I can't change doses or give advice that differs from the care plan — please ask the nurse if you're unsure.`;
  }

  if (has(/physio|physiotherap|therap|exercise|rehab|knee|walk|mobil/)) {
    const physio = pending.filter((i) => i.type === 'physio');
    const when = physio.length ? ` Today's sessions: ${listOf(physio)}.` : '';
    return `Physiotherapy plan: ${patient.physio || 'as scheduled by the care team'}.${when}`;
  }

  if (has(/meal|food|eat|breakfast|lunch|dinner|diet|drink|fluid|menu|snack|hungry/)) {
    const meals = pending.filter((i) => i.type === 'meal');
    const when = meals.length ? ` Coming up: ${listOf(meals)}.` : '';
    return `Diet plan: ${patient.diet || 'as set by the care team'}.${when}`;
  }

  if (has(/schedul|timeline|plan|what'?s next|what time|agenda|today|appointment|happening/)) {
    if (pending.length) {
      return `Still to come today for ${name}: ${listOf(pending, 5)}. You can see the full day on the schedule tab.`;
    }
    return `Today's scheduled care for ${name} is done — nothing else is on the timeline. The care team may still drop by.`;
  }

  if (has(/allerg/)) {
    return `Allergies on file for ${name}: ${patient.allergies || 'none known'}.`;
  }

  if (has(/diagnos|condition|what'?s wrong|why (is|are)|surgery|operation|illness/)) {
    return `${name}'s current condition: ${patient.diagnosis || 'ask the care team for details'}.`;
  }

  if (has(/pain|hurt|sore|ache|discomfort/)) {
    const last = (patient.checkins || [])[patient.checkins.length - 1];
    const ref = last ? ` Your last check-in reported pain ${last.pain}/10.` : '';
    return `I'm sorry it's uncomfortable.${ref} If pain is 7/10 or higher, or suddenly much worse, say so and I'll flag the nurse right away — otherwise they can also offer your scheduled pain relief.`;
  }

  if (has(/check.?in|how (are|is) (you|he|she|they)|feeling|sleep|appetite|mood/)) {
    const last = (patient.checkins || [])[patient.checkins.length - 1];
    return last
      ? `Latest check-in: pain ${last.pain}/10, sleep "${last.sleep}", appetite "${last.appetite}", mood "${last.mood}".`
      : `There's no check-in recorded yet today — the check-in tab takes about 20 seconds and helps the care team.`;
  }

  return `I'm running in offline demo mode (no AI key), but I can still help with: visiting hours, ${patient.room ? 'room number, ' : ''}medication and physio times, meals and diet, allergies, the day's schedule, or the latest check-in. Tap a quick-reply chip or ask one of those.`;
}

module.exports = { hasKey, buildSystemPrompt, callGemini, fallbackReply, needsNurse, GEMINI_MODEL };
