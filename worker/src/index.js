// ══════════════════════════════════════════════════════════════
// Morning Brief — Dedicated Cloudflare Worker
// Worker URL: https://nameless-math-87ca.jeongdael00.workers.dev/
//
// Environment Variables (Cloudflare Dashboard → Settings → Variables):
//   GEMINI_KEY_1    — Gemini API key
//   GEMINI_KEY_2    — Gemini API key (used by default)
//   TG_TOKEN        — Telegram bot token
//   TG_CHAT_ID      — Telegram group/channel chat ID
//   CRON_TOPIC      — (optional) news topic, default: "World News"
//   CRON_VOICE      — (optional) TTS voice, default: "Charon"
//   CRON_STORIES    — (optional) podcast story count, default: "3"
//
// R2 Binding (Cloudflare Dashboard → Settings → Bindings):
//   Binding name: AUDIO_BUCKET  →  R2 bucket: brief-audio
//
// Cron Trigger:
//   0 21 * * *  =  KST 06:00 daily
// ══════════════════════════════════════════════════════════════
// MODEL SETTINGS
const GEMINI_TEXT_MODEL = "gemini-3.1-flash-lite";
const FALLBACK_MODELS = [
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.5-flash-8b"
];
const GEMINI_TTS_MODEL = "gemini-2.5-flash-preview-tts";
const KEY_INDEX_DEFAULT = 2;
const R2_PUBLIC_BASE = "https://pub-cf8f191eed3d4357a77f8c51c526d31f.r2.dev";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ──────────────────────────────────────────────────────────────
// ENTRY POINTS
// ──────────────────────────────────────────────────────────────

export default {
  // Web app API requests
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }
    try {
      return await handleFetch(request, env, ctx);
    } catch (err) {
      return jsonRes({ error: err.message }, 500);
    }
  },

  // Cloudflare Cron Trigger
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyBrief(env));
  },
};

// ──────────────────────────────────────────────────────────────
// FETCH HANDLER — serves web app requests
// ──────────────────────────────────────────────────────────────

async function handleFetch(request, env, ctx) {
  const path = new URL(request.url).pathname;

  // ── BACKGROUND AUDIO WEBHOOK (Avoids 30s cron limit) ──
  if (path === "/run-audio" && request.method === "POST") {
    const body = await request.json();
    if (body.secret !== env.RUN_SECRET && env.RUN_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
    // Process audio in the background where execution time is more generous
    if (ctx && ctx.waitUntil) {
      ctx.waitUntil(generateAndSendAudio(env, body.brief, body.topic, body.voice, body.stories, body.dateStr));
    } else {
      // Fallback if ctx is missing
      generateAndSendAudio(env, body.brief, body.topic, body.voice, body.stories, body.dateStr).catch(console.error);
    }
    return new Response("Audio generation started in background", { status: 202, headers: CORS });
  }

  // ── TEST endpoint: GET /run → manually trigger daily brief ──
  // Remove this block after confirming everything works
  if (path === "/run" && request.method === "GET") {
    const secret = new URL(request.url).searchParams.get("key");
    if (secret !== env.RUN_SECRET && env.RUN_SECRET) {
      return new Response("Unauthorized", { status: 401, headers: CORS });
    }
    try {
      await runDailyBrief(env, request);
      return new Response("✅ Daily brief ran. Check Telegram.", {
        headers: { ...CORS, "Content-Type": "text/plain" }
      });
    } catch (e) {
      return new Response("❌ Error: " + e.message, {
        status: 500,
        headers: { ...CORS, "Content-Type": "text/plain" }
      });
    }
  }

  // ── STEP TEST: test individual steps ──
  if (path === "/run-step" && request.method === "GET") {
    const step = new URL(request.url).searchParams.get("step") || "brief";
    const key = getKey(env, KEY_INDEX_DEFAULT);
    const logs = [];
    try {
      if (step === "brief") {
        const brief = await generateBrief(key, env.CRON_TOPIC || "World News", new Date().toDateString());
        return new Response(JSON.stringify(brief, null, 2), {
          headers: { ...CORS, "Content-Type": "application/json" }
        });
      }
      if (step === "tg") {
        await tgSendText(env, "🧪 Morning Brief test message. Telegram is working!");
        return new Response("✅ Telegram message sent.", {
          headers: { ...CORS, "Content-Type": "text/plain" }
        });
      }
      if (step === "r2") {
        // Upload a tiny test file
        await env.AUDIO_BUCKET.put("test.txt", "Morning Brief R2 test", {
          httpMetadata: { contentType: "text/plain" }
        });
        const url = R2_PUBLIC_BASE + "/test.txt";
        return new Response("✅ R2 upload OK. URL: " + url, {
          headers: { ...CORS, "Content-Type": "text/plain" }
        });
      }
    } catch (e) {
      return new Response("❌ Step '" + step + "' failed: " + e.message, {
        status: 500, headers: { ...CORS, "Content-Type": "text/plain" }
      });
    }
  }

  const body = await (request.method === "POST" ? request.clone().json() : {});
  const { mode, telegramMode, prompt, systemInstruction,
    model, keyIndex, useSearch, ttsConfig,
    telegramText, telegramAudio } = body;

  // ── Telegram send (from web app "Send Now") ──
  if (telegramMode) {
    if (telegramText) {
      await tgSendText(env, telegramText);
    }
    if (telegramAudio) {
      // Web app sends raw PCM base64 → upload to R2 → send link
      const { url, key } = await uploadAudioToR2(env, telegramAudio, "web");
      await tgSendText(env, `🎙 <b>Morning Brief Podcast</b>\n\n<a href="${url}">▶ Listen now</a>\n\n<i>Link expires in 30 days</i>`);
    }
    return jsonRes({ ok: true });
  }

  // ── TTS generation ──
  if (mode === "tts") {
    const key = getKey(env, keyIndex || KEY_INDEX_DEFAULT);
    const audio = await geminiTTS(key, prompt, ttsConfig?.voiceName || "Charon");
    return jsonRes(audio);
  }

  // ── Gemini text generation ──
  const key = getKey(env, keyIndex || KEY_INDEX_DEFAULT);
  const data = await geminiText(
    key,
    model || GEMINI_TEXT_MODEL,
    prompt,
    systemInstruction,
    useSearch
  );
  return jsonRes(data);
}

// ──────────────────────────────────────────────────────────────
// CRON: DAILY BRIEF
// ──────────────────────────────────────────────────────────────

async function runDailyBrief(env, request = null) {
  const topic = env.CRON_TOPIC || "World News";
  const voice = env.CRON_VOICE || "Charon";
  const stories = parseInt(env.CRON_STORIES || "5");
  const key = getKey(env, KEY_INDEX_DEFAULT);
  const dateStr = new Date().toDateString();

  console.log(`[Cron] Starting — topic: ${topic}, voice: ${voice}, stories: ${stories}`);

  // ── Step 1: Generate Brief ────────────────────────────────
  let brief;
  try {
    brief = await generateBrief(key, topic, dateStr);
    console.log(`[Cron] Brief ready: "${brief.title}"`);
  } catch (e) {
    console.error("[Cron] Brief failed:", e.message);
    await tgSendText(env, `⚠️ Morning Brief failed.\n\n${e.message}`);
    return;
  }

  // ── Step 2: Send text brief to Telegram (split by section) ──
  // Send text first — even if audio fails, brief still goes out
  try {
    await sendBriefToTelegram(env, brief, topic);
    console.log("[Cron] Text brief sent");
  } catch (e) {
    console.error("[Cron] Text send failed:", e.message);
  }

  // ── Step 3: Trigger Background Audio ──────────────────────
  // Instead of blocking the cron job (which dies at 30s), we hit our own webhook
  // using an un-awaited background fetch to trigger the webhook.
  try {
    const targetUrl = new URL(request ? request.url : "https://nameless-math-87ca.jeongdael00.workers.dev/run-audio");
    targetUrl.pathname = "/run-audio";

    // We intentionally don't await this so the cron returns quickly
    fetch(targetUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: env.RUN_SECRET,
        brief,
        topic,
        voice,
        stories,
        dateStr
      })
    }).catch(e => console.error("Fetch background audio trigger error:", e));

    console.log(`[Cron] Background audio trigger fired to ${targetUrl}`);
  } catch (e) {
    console.error("[Cron] Background trigger failed:", e.message);
  }
}

// ──────────────────────────────────────────────────────────────
// BACKGROUND AUDIO GENERATION
// ──────────────────────────────────────────────────────────────
async function generateAndSendAudio(env, brief, topic, voice, stories, dateStr) {
  const key = getKey(env, KEY_INDEX_DEFAULT);

  // ── Step 1: Generate podcast script ──────────────────────
  let podScript;
  try {
    podScript = await generatePodcastScript(key, brief, stories, dateStr);
    console.log(`[AudioBg] Podcast script ready (${podScript.length} chars)`);
  } catch (e) {
    console.error("[AudioBg] Podcast script failed:", e.message);
    await tgSendText(env, "⚠️ Podcast script generation failed.");
    return;
  }

  // ── Step 2: Generate TTS audio ───────────────────────────
  let audioBase64, audioMime;
  try {
    const ttsResult = await geminiTTS(key, podScript, voice);
    audioBase66 = ttsResult.audioData;
    audioMime = ttsResult.mimeType || "audio/wav";
    if (!audioBase64) throw new Error("Empty audio data");
    console.log(`[AudioBg] TTS ready (${audioBase64.length} base64 chars), mime: ${audioMime}`);
  } catch (e) {
    console.error("[AudioBg] TTS failed:", e.message);
    await tgSendText(env, "⚠️ Podcast audio generation failed. Brief text was sent above.");
    return;
  }

  // ── Step 3: Upload to R2 → get public URL ────────────────
  let audioUrl;
  try {
    const result = await uploadAudioToR2(env, audioBase64, "cron", audioMime);
    audioUrl = result.url;
    console.log(`[AudioBg] Audio uploaded: ${audioUrl}`);
  } catch (e) {
    console.error("[AudioBg] R2 upload failed:", e.message);
    await tgSendText(env, "⚠️ Audio upload failed. Brief text was sent above.");
    return;
  }

  // ── Step 4: Send audio link to Telegram ──────────────────
  try {
    const kstDate = new Date().toLocaleDateString("en-US", {
      timeZone: "Asia/Seoul",
      weekday: "long", month: "long", day: "numeric"
    });
    await tgSendText(env,
      `🎙 <b>Morning Brief Podcast</b>\n` +
      `${kstDate}\n\n` +
      `Voice: ${voice} · ${stories} stories\n\n` +
      `<a href="${audioUrl}">▶ Listen now</a>\n\n` +
      `<i>Audio available for 30 days</i>`
    );
    console.log("[AudioBg] Audio link sent. All done.");
  } catch (e) {
    console.error("[AudioBg] Audio link send failed:", e.message);
  }
}

// ──────────────────────────────────────────────────────────────
// BRIEF GENERATION
// ──────────────────────────────────────────────────────────────

async function generateBrief(apiKey, topic, dateStr) {
  const system =
    `You are a senior international news editor. Today is ${dateStr}. ` +
    `Draw from Reuters, AP, BBC, NYT, FT, Bloomberg, WSJ, The Economist. ` +
    `Be specific: names, figures, dates. Write authoritatively. Respond ONLY in English.`;

  const prompt =
    `Search for the most significant international news from the past 24 hours on: "${topic}". ` +
    `Return ONLY valid JSON, no markdown, no preamble:\n` +
    `{"title":"compelling headline","summary":"one sharp sentence capturing the day",` +
    `"sections":[{"label":"SECTION TAG","headline":"specific factual headline",` +
    `"context":"1-2 sentences of essential background",` +
    `"bullets":["key fact with specific names/numbers","another distinct development",` +
    `"consequence or reaction","what to watch next"],` +
    `"significance":"one sentence on why this matters strategically"}]}\n` +
    `Include exactly 5 sections. Stories must be from past 24-48 hours. ` +
    `Each bullet must be a complete sentence with specific facts. Do not fabricate.`;

  const data = await geminiText(apiKey, GEMINI_TEXT_MODEL, prompt, system, true);
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const clean = raw.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("JSON parse failed. Raw: " + raw.slice(0, 300));
  return JSON.parse(match[0]);
}

// ──────────────────────────────────────────────────────────────
// PODCAST SCRIPT GENERATION
// ──────────────────────────────────────────────────────────────

async function generatePodcastScript(apiKey, brief, storyCount, dateStr) {
  const topStories = (brief.sections || []).slice(0, storyCount);
  const storiesText = topStories
    .map((s, i) =>
      `THEME ${i + 1} — ${s.label || ""}:\nHeadline: ${s.headline}\n` +
      (s.context ? `Background: ${s.context}\n` : "") +
      `Key facts:\n${(Array.isArray(s.bullets) ? s.bullets : []).map(b => "- " + b).join("\n")}\n` +
      (s.significance ? `Strategic significance: ${s.significance}` : "")
    )
    .join("\n\n════════\n\n");

  const system =
    "You are an award-winning narrative podcast host — intelligent, warm, measured. " +
    "NOT a news anchor. A thoughtful storyteller. " +
    "Think NPR's intimacy meets The Economist's depth meets Hardcore History's narrative pull. " +
    "You speak slowly, clearly, and deliberately. You never rush.";

  // Target ~1500-1800 words = ~10-12 minutes at natural speaking pace
  const targetWords = storyCount * 320;

  const prompt =
    `Write a morning news podcast script for 'Morning Brief'.\n` +
    `Date: ${dateStr}\n` +
    `Themes today: ${storyCount}\n\n` +
    `Source material:\n${storiesText}\n\n` +
    `═══ STRUCTURE ═══\n\n` +
    `OPENING (60-80 words):\n` +
    `- One arresting observation that stops the listener cold — NOT "Good morning"\n` +
    `- Briefly introduce today's ${storyCount} themes by name\n` +
    `- End with a sentence that makes the listener lean in\n\n` +
    `FOR EACH THEME (${storyCount} total):\n` +
    `- Label clearly: "Theme One —", "Theme Two —", etc.\n` +
    `- MINIMUM 300 words per theme. Do not cut short.\n` +
    `- Structure: Hook (scene/paradox/human moment) → Context → What happened → Stakes → What to watch\n` +
    `- Each theme ends with a complete, satisfying thought\n` +
    `- Separate themes with exactly: [PAUSE]\n\n` +
    `CLOSING (50-70 words):\n` +
    `- A lingering thought or open question\n` +
    `- Something the listener will think about after the episode ends\n` +
    `- Never a summary\n\n` +
    `═══ PACING — THIS IS THE MOST IMPORTANT INSTRUCTION ═══\n` +
    `- Write SHORT paragraphs. Maximum 3 sentences per paragraph.\n` +
    `- After every paragraph, the speaker takes a breath. Design for this.\n` +
    `- NEVER write more than 3 sentences in a row without a line break.\n` +
    `- Use [BEAT] for a half-second pause within a sentence\n` +
    `- Use ellipses (...) sparingly for dramatic effect only\n` +
    `- Em-dashes (—) for natural asides and rhythm\n` +
    `- The LAST theme must be as long and detailed as the FIRST. No tapering.\n` +
    `- Imagine the script being read aloud at 130 words per minute. Write enough.\n\n` +
    `═══ STYLE ═══\n` +
    `- Write entirely for the ear. Read each sentence aloud mentally.\n` +
    `- Contractions always. Varied sentence length always.\n` +
    `- Dry, understated intelligence. No forced humor. No jargon. No passive voice.\n` +
    `- Speak to ONE intelligent adult with 12 minutes and a coffee.\n\n` +
    `WORD COUNT TARGET: ${targetWords}-${targetWords + 200} words total.\n` +
    `This is non-negotiable. Count carefully before finishing.\n\n` +
    `Return ONLY the spoken script with [PAUSE] and [BEAT] markers. Nothing else.`;

  const data = await geminiText(apiKey, GEMINI_TEXT_MODEL, prompt, system, false);
  let script = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!script) throw new Error("Empty podcast script returned");

  // Convert markers to natural pauses for TTS
  script = script
    .replace(/\[PAUSE\]/gi, "\n\n\n")   // longer pause between themes
    .replace(/\[pause\]/gi, "\n\n\n")
    .replace(/\[BEAT\]/gi, ", ")            // comma = slight pause in TTS
    .replace(/\[beat\]/gi, ", ");

  return script;
}

// ──────────────────────────────────────────────────────────────
// R2 UPLOAD
// ──────────────────────────────────────────────────────────────

async function uploadAudioToR2(env, audioBase64, source, mimeType) {
  if (!env.AUDIO_BUCKET) throw new Error("AUDIO_BUCKET binding not set");

  // Decode base64 PCM
  const binary = atob(audioBase64);
  const pcmBytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) pcmBytes[i] = binary.charCodeAt(i);

  // Try to get MP3 directly from Gemini — if mimeType says mp3, use as-is
  // Otherwise wrap raw PCM in WAV (Gemini TTS returns PCM by default)
  let finalBytes;
  let finalMime;
  let ext;

  if (mimeType && mimeType.includes("mp3")) {
    // Gemini returned MP3 — use directly
    finalBytes = pcmBytes;
    finalMime = "audio/mpeg";
    ext = "mp3";
  } else {
    // Wrap PCM in WAV container
    finalBytes = buildWavBytes(pcmBytes);
    finalMime = "audio/wav";
    ext = "wav";
  }

  // File name: morning-brief-YYYY-MM-DD-{source}.{ext}
  const kstDate = new Date(Date.now() + 9 * 3600000)
    .toISOString().slice(0, 10);
  const fileName = `morning-brief-${kstDate}-${source}.${ext}`;

  await env.AUDIO_BUCKET.put(fileName, finalBytes, {
    httpMetadata: { contentType: finalMime },
  });

  const url = `${R2_PUBLIC_BASE}/${fileName}`;
  console.log(`[R2] Uploaded ${fileName} (${finalBytes.length} bytes, ${finalMime})`);
  return { url, key: fileName };
}

// ──────────────────────────────────────────────────────────────
// GEMINI HELPERS
// ──────────────────────────────────────────────────────────────

function getKey(env, index) {
  const key = env[`GEMINI_KEY_${index}`];
  if (!key) throw new Error(`GEMINI_KEY_${index} not set in environment variables`);
  return key;
}

async function geminiText(apiKey, initialModel, prompt, systemInstruction, useSearch) {
  const modelsToTry = [initialModel];
  // Mix in fallbacks, ensuring we don't duplicate the initial model
  for (const m of FALLBACK_MODELS) {
    if (m !== initialModel && !modelsToTry.includes(m)) {
      modelsToTry.push(m);
    }
  }

  const delays = [1000, 2000, 4000];
  let lastError = null;

  for (let modelIndex = 0; modelIndex < modelsToTry.length; modelIndex++) {
    const currentModel = modelsToTry[modelIndex];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${apiKey}`;

    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    };
    if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
    if (useSearch) body.tools = [{ googleSearch: {} }];

    for (let attempt = 0; attempt < delays.length; attempt++) {
      try {
        if (modelIndex > 0 && attempt === 0) {
          console.warn(`[Fallback] Primary model failed. Trying fallback model: ${currentModel}`);
        }

        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        const data = await res.json();

        if (data.error) {
          const errorMsg = data.error.message || JSON.stringify(data.error);
          const isQuotaError = res.status === 429 || res.status === 503 ||
            errorMsg.includes("CAPACITY_EXHAUSTED") ||
            errorMsg.includes("quota") ||
            errorMsg.includes("rate limit");

          if (isQuotaError && modelIndex < modelsToTry.length - 1) {
            console.warn(`[API] Model ${currentModel} exhausted (${errorMsg}). Switching to next fallback.`);
            throw new Error("MODEL_EXHAUSTED"); // Break inner loop
          }
          throw new Error(`Gemini text error (${currentModel}): ${errorMsg}`);
        }

        return data; // Success
      } catch (error) {
        lastError = error;

        if (error.message === "MODEL_EXHAUSTED") {
          break; // Move to next model immediately
        }

        console.error(`Attempt ${attempt + 1} for ${currentModel} failed:`, error.message);
        if (attempt < delays.length - 1) {
          await new Promise(r => setTimeout(r, delays[attempt]));
        }
      }
    }
  }

  throw lastError;
}

async function geminiTTS(apiKey, text, voiceName) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName },
          },
        },
      },
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Gemini TTS error: ${data.error.message}`);

  const part = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  const audioData = part?.data || null;
  const mimeType = part?.mimeType || "audio/wav";
  return { audioData, mimeType };
}

// ──────────────────────────────────────────────────────────────
// WAV HEADER BUILDER
// ──────────────────────────────────────────────────────────────

function buildWavBytes(pcmBytes) {
  const sampleRate = 24000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = pcmBytes.length;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);

  const s = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
  s(0, "RIFF");
  v.setUint32(4, 36 + dataSize, true);
  s(8, "WAVE");
  s(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, numChannels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, byteRate, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bitsPerSample, true);
  s(36, "data");
  v.setUint32(40, dataSize, true);
  new Uint8Array(buf).set(pcmBytes, 44);
  return new Uint8Array(buf);
}

// ──────────────────────────────────────────────────────────────
// TELEGRAM HELPERS
// ──────────────────────────────────────────────────────────────

async function tgSendText(env, text) {
  const token = env.TG_TOKEN;
  const chatId = env.TG_CHAT_ID;
  if (!token || !chatId) throw new Error("TG_TOKEN or TG_CHAT_ID not set");

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text.slice(0, 4090),
      parse_mode: "HTML",
      disable_web_page_preview: false, // allow link preview for audio
    }),
  });
  const d = await res.json();
  if (!d.ok) throw new Error(`Telegram sendMessage failed: ${d.description}`);
}

// ──────────────────────────────────────────────────────────────
// TELEGRAM TEXT FORMATTER
// ──────────────────────────────────────────────────────────────

// Send brief as multiple messages — one header + one per section
async function sendBriefToTelegram(env, brief, topic) {
  const date = new Date().toLocaleDateString("en-US", {
    timeZone: "Asia/Seoul",
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });

  // Message 1: Header + summary
  const header =
    `🗞 <b>Morning Brief</b>\n` +
    `<b>${topic}</b> · ${date}\n\n` +
    `<i>${brief.summary || ""}</i>`;
  await tgSendText(env, header);

  // Messages 2-6: One per section, concise
  const sections = brief.sections || [];
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const num = ["①", "②", "③", "④", "⑤"][i] || `${i + 1}.`;

    // Pick only the 2 most important bullets to keep it readable
    const bullets = (sec.bullets || []).slice(0, 2);

    let msg = `${num} <b>${sec.headline || ""}</b>\n`;
    if (sec.context) msg += `<i>${sec.context.slice(0, 150)}</i>\n\n`;
    for (const b of bullets) msg += `• ${b}\n`;
    if (sec.significance) msg += `\n↳ <i>${sec.significance.slice(0, 120)}</i>`;

    await tgSendText(env, msg.slice(0, 900));

    // Small delay between messages to avoid Telegram rate limit
    await new Promise(r => setTimeout(r, 400));
  }

  // Final message: footer
  await tgSendText(env, `🎙 <i>Podcast coming next...</i>`);
}

// Keep old single-message builder for fallback
function buildTgText(brief, topic) {
  const date = new Date().toLocaleDateString("en-US", {
    timeZone: "Asia/Seoul",
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });

  let msg = `🗞 <b>Morning Brief</b> — ${topic}\n${date}\n\n`;
  msg += `<i>${brief.summary || ""}</i>\n\n`;

  for (const sec of brief.sections || []) {
    msg += `<b>${sec.label || ""}</b> — ${sec.headline || ""}\n`;
    for (const b of (sec.bullets || []).slice(0, 2)) msg += `• ${b}\n`;
    if (sec.significance) msg += `↳ <i>${sec.significance}</i>\n`;
    msg += "\n";
  }

  msg += `<i>🎙 Podcast coming next</i>`;
  return msg.slice(0, 4090);
}

// ──────────────────────────────────────────────────────────────
// UTILITY
// ──────────────────────────────────────────────────────────────

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
