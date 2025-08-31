
import React, { useEffect, useRef, useState } from "react";

async function loadLyraData(base = "/lyra-data") {
  async function getJSON(url) {
    const res = await fetch(url, { cache: "no-store" });
    const ct = res.headers.get("content-type") || "";
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status} for ${url} — ${text.slice(0, 100)}...`);
    }
    const preview = (await res.clone().text()).slice(0, 80);
    if (!ct.includes("application/json") && /^\s*[<]/.test(preview)) {
      throw new Error(`Not JSON at ${url} (got HTML/XML). Check path/base.`);
    }
    try { return JSON.parse(preview); } catch { return res.json(); }
  }

  const [questions, effects, classes, tipsLinks, config] = await Promise.all([
    getJSON(`${base}/questions.json`),
    getJSON(`${base}/effects.json`),
    getJSON(`${base}/classes.json`),
    getJSON(`${base}/tips_links.json`),
    getJSON(`${base}/config.json`).catch(() => ({ webhookUrl: "" })),
  ]);
  return { questions, effects, classes, tipsLinks, config };
}

async function sendLog(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      mode: "no-cors",
    });
  } catch {}
}

async function commentWithGPT({ question, answer, language = "en" }) {
  try {
    const resp = await fetch(`/api/gpt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, answer, language }),
    });
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => null);
    return data?.text || null;
  } catch {
    return null;
  }
}

function initSession(classes) {
  return {
    asked: [], answers: {}, excluded: new Set(),
    scores: Object.fromEntries(classes.map((c) => [c.class_id, 0])),
    userLanguage: "en",
  };
}

function firstFiveQuestions(questions) {
  return questions.filter((q) => Number(q.phase) === 1)
                  .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

function applyAnswer(session, effects, questionId, optionLabel) {
  const hits = effects.filter(
    (e) => e.question_id === questionId && String(e.option).trim() === String(optionLabel).trim()
  );
  for (const h of hits) {
    (h.exclude || []).forEach((cls) => session.excluded.add(cls));
    (h.up || []).forEach((cls) => (session.scores[cls] = (session.scores[cls] ?? 0) + 1));
    (h.down || []).forEach((cls) => (session.scores[cls] = (session.scores[cls] ?? 0) - 1));
  }
}

function pickNextQuestion(session, questions, effects) {
  const remaining = questions.filter((q) => Number(q.phase) !== 1 && !session.asked.includes(q.id));
  if (!remaining.length) return null;
  const alive = (id) => !session.excluded.has(id);

  let best = null, bestImpact = -1, bestPrio = -1;
  for (const q of remaining) {
    const qEff = effects.filter((e) => e.question_id === q.id);
    const impacted = new Set();
    for (const e of qEff) {
      [...(e.exclude || []), ...(e.up || []), ...(e.down || [])].forEach((c) => {
        if (alive(c)) impacted.add(c);
      });
    }
    const impact = impacted.size;
    const prio = q.priority ?? 0;
    if (impact > bestImpact || (impact === bestImpact && prio > bestPrio)) {
      best = q; bestImpact = impact; bestPrio = prio;
    }
  }
  return best;
}

function shouldStop(session, maxQ = 15) {
  if (session.asked.length >= maxQ) return true;
  const aliveScores = Object.entries(session.scores)
    .filter(([cls]) => !session.excluded.has(cls))
    .map(([, v]) => v)
    .sort((a, b) => b - a);
  if (aliveScores.length >= 2) {
    const lead = aliveScores[0] - aliveScores[1];
    const aliveCount = Object.keys(session.scores).filter((c) => !session.excluded.has(c)).length;
    if (lead >= 2 && aliveCount <= 3) return true;
  }
  return false;
}

function getResult(session, classes, tipsLinks) {
  const alive = Object.keys(session.scores).filter((c) => !session.excluded.has(c));
  alive.sort((a, b) => session.scores[b] - session.scores[a]);
  const best = alive[0];
  const cls = classes.find((x) => x.class_id === best);
  const tl = tipsLinks[best] || { tips: [], links: [] };
  return {
    class_id: best,
    name: cls?.name ?? best,
    summary: cls?.summary ?? "",
    why: [
      "Matches your comfort and usage profile.",
      "Suitable for your guest count and trip length.",
      "Aligned with your stability and propulsion preferences.",
    ],
    tips: (tl.tips || []).slice(0, 7),
    links: (tl.links || []).slice(0, 5),
  };
}

function normalizeOptions(q) {
  const raw = q.options || [];
  if (Array.isArray(raw) && raw.length && typeof raw[0] === "object" && raw[0].label) {
    return raw.map((o) => ({ id: o.id || String(o.label), label: String(o.label).trim() }));
  }
  if (Array.isArray(raw) && raw.length === 1 && typeof raw[0] === "object" && raw[0].label) {
    const s = String(raw[0].label);
    return s.split(/\n|\||;|\,|\s\d+\)|\s\d+\.|\s\d+\-/)
      .map((x) => x.trim()).filter(Boolean)
      .map((label, i) => ({ id: String(i + 1), label }));
  }
  if (typeof raw === "string") {
    return raw.split(/\n|\||;|\,/).map((x) => x.trim()).filter(Boolean)
      .map((label, i) => ({ id: String(i + 1), label }));
  }
  return [];
}

export default function LyraIntelligenceChat({ dataBaseUrl = "/lyra-data" }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [introVisible, setIntroVisible] = useState(true);
  const [isFinished, setIsFinished] = useState(false);
  const [lyraData, setLyraData] = useState(null);
  const [dataError, setDataError] = useState(null);
  const [session, setSession] = useState(null);
  const [currentQuestion, setCurrentQuestion] = useState(null);
  const [mode, setMode] = useState("intro");

  const textareaRef = useRef(null);
  const scrollRef = useRef(null);

  const maxChars = 500;
  const charsUsed = input.length;
  const charsCapped = charsUsed > maxChars ? maxChars : charsUsed;

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    const next = Math.min(200, ta.scrollHeight);
    ta.style.height = next + "px";
  }, [input]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    (async () => {
      try {
        const data = await loadLyraData(dataBaseUrl);
        setLyraData(data);
        setSession(initSession(data.classes));
      } catch (e) {
        setDataError(e?.message || "Failed to load LYRA data");
      }
    })();
  }, [dataBaseUrl]);

  function handleInput(e) {
    const next = e.target.value.slice(0, maxChars);
    setInput(next);
  }

  function pushAssistant(text) { setMessages((p) => [...p, { role: "assistant", content: text }]); }
  function pushUser(text) { setMessages((p) => [...p, { role: "user", content: text }]); }

  async function startQuizWithIntroDescription(desc) {
    pushUser(desc);
    setIntroVisible(false);
    setMode("quiz");

    const q5 = firstFiveQuestions(lyraData.questions);
    const q1 = q5[0] || lyraData.questions[0];
    if (q1) {
      setCurrentQuestion(q1);
      pushAssistant(q1.text);
    }
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || isSending || isFinished) return;
    setIsSending(true);
    if (mode === "intro") {
      await new Promise((r) => setTimeout(r, 120));
      await startQuizWithIntroDescription(text);
      setInput("");
    }
    setIsSending(false);
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }

  async function handleOptionClick(optLabel) {
    if (!currentQuestion || !session || !lyraData) return;

    pushUser(optLabel);

    try {
      const lang = session?.userLanguage || "en";
      const gptNote = await commentWithGPT({ question: currentQuestion.text, answer: optLabel, language: lang });
      if (gptNote) {
        pushAssistant(gptNote);
        sendLog(lyraData?.config?.webhookUrl, { type: "step", ts: new Date().toISOString(), question_id: currentQuestion.id, question_text: currentQuestion.text, answer: optLabel, gpt_comment: gptNote, scores: session?.scores });
      } else {
        sendLog(lyraData?.config?.webhookUrl, { type: "step", ts: new Date().toISOString(), question_id: currentQuestion.id, question_text: currentQuestion.text, answer: optLabel, scores: session?.scores });
      }
    } catch (e) {
      sendLog(lyraData?.config?.webhookUrl, { type: "step", ts: new Date().toISOString(), question_id: currentQuestion.id, question_text: currentQuestion.text, answer: optLabel, scores: session?.scores, gpt_error: String(e?.message || e) });
    }

    const s = { ...session, excluded: new Set([...session.excluded]) };
    s.answers[currentQuestion.id] = optLabel;
    s.asked = [...s.asked, currentQuestion.id];
    applyAnswer(s, lyraData.effects, currentQuestion.id, optLabel);

    if (shouldStop(s)) {
      const result = getResult(s, lyraData.classes, lyraData.tipsLinks);
      pushAssistant(renderResultText(result));
      setSession(s);
      setIsFinished(true);
      setMode("result");
      setCurrentQuestion(null);
      sendLog(lyraData?.config?.webhookUrl, { type: "result", ts: new Date().toISOString(), result, answers: s.answers, asked: s.asked, scores: s.scores });
      return;
    }

    const fixed = firstFiveQuestions(lyraData.questions).map((q) => q.id);
    let nextQ = null;
    const remainingFixed = fixed.filter((id) => !s.asked.includes(id));
    if (remainingFixed.length) {
      nextQ = lyraData.questions.find((q) => q.id === remainingFixed[0]);
    } else {
      nextQ = pickNextQuestion(s, lyraData.questions, lyraData.effects);
    }

    if (nextQ) {
      setCurrentQuestion(nextQ);
      pushAssistant(nextQ.text);
    } else {
      const result = getResult(s, lyraData.classes, lyraData.tipsLinks);
      pushAssistant(renderResultText(result));
      setIsFinished(true);
      setMode("result");
      setCurrentQuestion(null);
      sendLog(lyraData?.config?.webhookUrl, { type: "result", ts: new Date().toISOString(), result, answers: s.answers, asked: s.asked, scores: s.scores });
    }
    setSession(s);
  }

  function renderResultText(result) {
    const tips = result.tips.slice(0, 5).map((t) => `• ${t}`).join("\n");
    const links = result.links.slice(0, 5).map((l) => `- ${l.label}: ${l.href}`).join("\n");
    
const bullets = Array.isArray(result.why) ? result.why.map(w => `\u2022 ${String(w).trim()}`).join("\n") : "";
      const tipsBlock = tips ? `Top tips:\n${tips}\n\n` : "";
      const linksBlock = links ? `Links:\n${links}` : "";
      const resultText =
        `Your recommended class: ${result.name}\n\n` +
        `${result.summary ? result.summary + "\n\n" : ""}` +
        `${bullets ? bullets + "\n\n" : ""}` +
        `${tipsBlock}${linksBlock}`;
return (
      
      
 + "`Links:\n${links}`" + ` : ""}`
    );
  }

  const fontStack = "Roboto, system-ui, -apple-system, Segoe UI, Arial, sans-serif";
  const container = { width: 360, height: 640, backgroundColor: "#000000", borderRadius: 12, border: "1px solid #FFFFFF", display: "flex", flexDirection: "column", overflow: "hidden", boxSizing: "border-box", padding: 12, fontFamily: fontStack };
  const header = { padding: "8px 8px 4px 8px", textAlign: "center" };
  const title = { color: "#FFFFFF", fontWeight: 700, fontSize: 16, textTransform: "uppercase", letterSpacing: 0.6 };
  const messagesWrap = { flex: 1, overflowY: "auto", padding: "8px 4px", display: "flex", flexDirection: "column", gap: 8 };
  const bubbleBase = { color: "#FFFFFF", fontSize: 12, lineHeight: 1.4, opacity: 1, maxWidth: "92%", padding: "8px 10px", borderRadius: 51, wordBreak: "break-word" };
  const userBubble = { ...bubbleBase, alignSelf: "flex-end", backgroundColor: "#000000", border: "2px solid #FFFFFF" };
  const aiBubble = { ...bubbleBase, alignSelf: "flex-start", backgroundColor: "transparent", border: "none", whiteSpace: "pre-wrap" };
  const inputArea = { position: "relative", marginTop: 8, padding: 8, border: "2px solid #FFFFFF", borderRadius: 51, backgroundColor: "#000000", display: "flex", alignItems: "center" };
  const counter = { fontSize: 10, color: "#FFFFFF", opacity: 1, marginRight: 8, whiteSpace: "nowrap" };
  const textarea = { flex: 1, maxHeight: 200, background: "transparent", color: "#FFFFFF", fontSize: 12, lineHeight: 1.5, border: "none", outline: "none", resize: "none" };
  const sendWrap = { marginLeft: 8, display: "flex", alignItems: "center" };
  const sendBtn = { width: 28, height: 28, borderRadius: 999, backgroundColor: "#FFFFFF", border: "none", outline: "none", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: isSending || isFinished ? "default" : "pointer", opacity: isSending || isFinished ? 0.6 : 1 };
  const ArrowIcon = () => (<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden><path d="M20 12 L6 6 L10 12 L6 18 Z" fill="black" /></svg>);

  const Intro = () => (
    <div style={{ marginTop: 6 }}>
      <div style={{ color: "#FFFFFF", fontSize: 10, lineHeight: 1.35, opacity: 1, textTransform: "uppercase", textAlign: "left", whiteSpace: "pre-wrap" }}>
{`LYRA helps you discover the yacht or boat that truly fits your lifestyle from all 20 different classes, ranging from 6 to 100 meters.

- Answer just 15 questions and receive:
- Your recommended yacht or boat class with a detailed, tailored description
- Clear reasoning why it’s the perfect match for you
- Five (5) expert recommendations
- Five (5) direct links to the world’s leading shipyards

Write to me in the language most comfortable for you - we’ll speak your language.`}
      </div>
    </div>
  );

  return (
    <div style={container}>
      <div style={header}><div style={title}>LYRA INTELLIGENCE™</div></div>

      <div ref={scrollRef} style={messagesWrap}>
        {introVisible && messages.length === 0 && <Intro />}
        {messages.map((m, i) => (<div key={i} style={m.role === "user" ? userBubble : aiBubble}>{m.content}</div>))}
        {lyraData && (<div style={{ color: "#fff", fontSize: 10, opacity: 0.6, alignSelf: "center" }}>Data: Q{lyraData.questions.length} / E{lyraData.effects.length} / C{lyraData.classes.length}</div>)}
        {dataError && (<div style={{ color: "#ff6", fontSize: 10, alignSelf: "center" }}>{dataError}</div>)}
        {mode === "quiz" && currentQuestion && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
            {normalizeOptions(currentQuestion).map((o) => (
              <button key={o.id} onClick={() => handleOptionClick(o.label)} disabled={isFinished}
                style={{ borderRadius: 28, border: "2px solid #FFFFFF", background: "#000000", color: "#FFFFFF", fontSize: 12, padding: "6px 10px", cursor: "pointer" }}>
                {o.label}
              </button>
            ))}
          </div>
        )}
        {isFinished && (<button onClick={() => window.location.reload()} style={{ marginTop: 10, padding: "6px 12px", borderRadius: 8, border: "1px solid #FFFFFF", backgroundColor: "transparent", color: "#FFFFFF", fontSize: 12, cursor: "pointer", alignSelf: "center" }}>Start Over</button>)}
      </div>

      {!isFinished && mode === "intro" && (
        <div style={inputArea}>
          <div style={counter}>{`${charsCapped}/${maxChars}`}</div>
          <textarea ref={textareaRef} value={input} onChange={handleInput} onKeyDown={onKeyDown} placeholder="Tell Me" style={{ ...textarea, fontSize: 12, color: "#FFFFFF", opacity: 1 }} disabled={isFinished} />
          <div style={sendWrap}>
            <button type="button" onClick={handleSend} disabled={isSending || !input.trim() || isFinished} aria-label="Send" style={sendBtn} title="Send"><ArrowIcon /></button>
          </div>
        </div>
      )}
    </div>
  );
}
