// Gemini LLM integration with graceful fallback if no key is present.
// Uses the REST endpoint directly — no SDK needed.

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

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

function fallbackReply(text) {
  const t = text.toLowerCase();
  const needsNurse =
    /nurse|help|pain|bleed|breath|dizzy|fever|nause|emergency|doctor/.test(t);
  return needsNurse
    ? "I'm a demo assistant running without an AI key right now. A nurse has been notified of your message."
    : "I'm a demo assistant running without an AI key right now. Ask a visitor-facing question like \"What are the visiting hours?\" or add a GEMINI_API_KEY to backend/.env to enable the real assistant.";
}

module.exports = { hasKey, buildSystemPrompt, callGemini, fallbackReply, GEMINI_MODEL };
