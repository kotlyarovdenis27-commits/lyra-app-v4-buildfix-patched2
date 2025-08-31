export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  try {
    const body = await new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); }
      });
    });
    const { question, answer, language = "en" } = body;

    const system = "You are LYRA Intelligence: a concise, courteous yacht advisor. Tone: refined, calm, premium. No emojis. 1–2 sentences max. After each user answer, acknowledge politely and add one tasteful, practical fact from yachting relevant to the topic of the question.";

    const user = `User language: ${language}
Question: ${question}
User answer: ${answer}

Return ONLY the comment text (1–2 sentences).`;

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.5,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    const data = await r.json();
    const text = data?.choices?.[0]?.message?.content?.trim() || "";
    res.status(200).json({ ok: true, text });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
