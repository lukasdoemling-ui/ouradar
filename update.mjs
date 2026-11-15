// O&U Radar – automatischer Feed
// Läuft täglich über GitHub Actions. Sucht neue Publikationen (PubMed) und
// neue/aktualisierte AWMF-Leitlinien, lässt sie per KI auf Deutsch zusammenfassen
// und schreibt alles nach docs/feed.json. Die App lädt diese Datei.
//
// Benötigt: Node 20+ und EINEN KI-Schlüssel als GitHub-Secret:
//   GEMINI_API_KEY    (kostenlos über Google AI Studio)  – wird bevorzugt
//   ANTHROPIC_API_KEY (Claude, kostenpflichtig)           – Alternative
// Ohne Schlüssel läuft das Script trotzdem – dann ohne Zusammenfassungen.

import { readFile, writeFile } from "node:fs/promises";

const FEED_FILE = "docs/feed.json";
const BLOCK_FILE = "docs/blocked.json";
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
// Kostenlose Gemini-Modelle (Free Tier), in dieser Reihenfolge probiert:
const GEMINI_MODELS = (process.env.OURADAR_GEMINI_MODELS || "gemini-4-hydrogen,gemini-2.5-flash,gemini-2.5-flash-lite").split(",").map(s => s.trim()).filter(Boolean);
const LOCAL_URL = process.env.LOCAL_LLM_URL || "";   // z. B. http://127.0.0.1:8080 (freies Modell im Ablauf)
let LOCAL_OK = false;
const HAS_AI = () => !!(API_KEY || LOCAL_OK || GEMINI_KEY);
const MODEL_SUMMARY = process.env.OURADAR_MODEL_SUMMARY || "claude-haiku-5-5";
const MODEL_SEARCH = process.env.OURADAR_MODEL_SEARCH || "claude-sonnet-5-5";
const MAX_NEW_PER_RUN = 25;      // Kostenbremse: höchstens so viele neue Studien pro Lauf
const MAX_ITEMS = 400;           // so viele Einträge bleiben im Feed
const DAYS_BACK = 21;            // Suchfenster PubMed
const AWMF_EVERY_DAYS = 7;       // AWMF-Suche nur wöchentlich
const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";

const HIGH_EV = ' AND (randomized controlled trial[pt] OR meta-analysis[pt] OR guideline[pt] OR practice guideline[pt])';
const BEREICHE = {
  trauma:   '(fracture fixation[mh] OR fractures, bone[mh] OR "fracture-related infection")',
  alter:    '(hip fractures[mh] OR "fragility fracture" OR "geriatric trauma" OR orthogeriatric*)',
  endo:     '(arthroplasty, replacement, hip[mh] OR arthroplasty, replacement, knee[mh])',
  fuss:     '(ankle fractures[mh] OR ankle injuries[mh] OR hallux valgus[mh] OR "ankle osteoarthritis" OR foot deformities[mh])',
  knie:     '(anterior cruciate ligament reconstruction[mh] OR menisci, tibial[mh] OR "cartilage repair" OR athletic injuries[mh])',
  schulter: '(rotator cuff[mh] OR shoulder fractures[mh] OR "shoulder arthroplasty" OR elbow joint[mh])',
  ws:       '(spinal fractures[mh] OR spinal fusion[mh] OR "spine surgery" OR vertebroplasty[mh] OR kyphoplasty[mh])',
  kinder:   '(fractures, bone[mh] AND (child[mh] OR adolescent[mh]))',
  infekt:   '(prosthesis-related infections[mh] OR surgical wound infection[mh] OR "fracture-related infection" OR (venous thromboembolism[mh] AND orthopedic procedures[mh]))'
};
const BEREICH_KEYS = Object.keys(BEREICHE);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}
function dateStr(daysBack) {
  const d = new Date(Date.now() - daysBack * 864e5);
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
}
async function getText(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": "ouradar-feed/1.0" } });
      if (r.ok) return await r.text();
      log("HTTP", r.status, url.slice(0, 90));
    } catch (e) { log("Netzwerkfehler", e.message); }
    await sleep(1500 * (i + 1));
  }
  throw new Error("Abruf fehlgeschlagen: " + url.slice(0, 90));
}

// ---------- PubMed ----------
const decode = s => s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, "&").replace(/<\/?(i|b|sup|sub|em|strong|u)>/gi, "").replace(/\s+/g, " ").trim();
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`)); return m ? decode(m[1]) : ""; };
const tagsAll = (xml, name) => [...xml.matchAll(new RegExp(`<${name}(\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "g"))].map(m => ({ attrs: m[1] || "", text: decode(m[2]) }));
const MON = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };

export function parsePubmedXml(xml) {
  return xml.split("<PubmedArticle>").slice(1).map(a => {
    const pmid = tag(a, "PMID");
    const title = tag(a, "ArticleTitle");
    const journal = tag(a, "ISOAbbreviation") || tag(a, "Title");
    const pubDate = (a.match(/<PubDate>([\s\S]*?)<\/PubDate>/) || [, ""])[1];
    const y = tag(pubDate, "Year") || (tag(pubDate, "MedlineDate").match(/\d{4}/) || [""])[0];
    let m = tag(pubDate, "Month"); m = MON[m] || (/^\d+$/.test(m) ? m.padStart(2, "0") : "");
    const ad = (a.match(/<ArticleDate[^>]*>([\s\S]*?)<\/ArticleDate>/) || [, ""])[1];
    const datum = ad ? `${tag(ad, "Year")}-${tag(ad, "Month").padStart(2, "0")}` : (y ? (m ? `${y}-${m}` : y) : "");
    const author = (a.match(/<Author[\s>][\s\S]*?<\/Author>/) || [""])[0];
    const first = tag(author, "LastName") || tag(author, "CollectiveName");
    const types = tagsAll(a, "PublicationType").map(t => t.text);
    const abstract = tagsAll(a, "AbstractText").map(p => { const l = (p.attrs.match(/Label="([^"]*)"/) || [, ""])[1]; return (l ? l + ": " : "") + p.text; }).join("\n");
    const isLL = types.some(t => /Guideline|Consensus/i.test(t));
    const st = types.some(t => /Randomized Controlled Trial/.test(t)) ? "RCT"
      : types.some(t => /Meta-Analysis/.test(t)) ? "Meta-Analyse"
      : types.some(t => /Systematic Review/.test(t)) ? "Syst. Review"
      : isLL ? "Leitlinie" : (types[0] || "Artikel");
    return { pmid, title, journal, y, datum, first, isLL, st, abstract };
  }).filter(x => x.pmid && x.title);
}

async function pubmedNew(knownIds) {
  const found = new Map(); // pmid -> bereich[]
  for (const key of BEREICH_KEYS) {
    const term = `${BEREICHE[key]}${HIGH_EV} AND ("${dateStr(DAYS_BACK)}"[dp] : "3000"[dp])`;
    const url = `${EUTILS}esearch.fcgi?db=pubmed&retmode=json&sort=pub_date&retmax=12&tool=ouradar&term=${encodeURIComponent(term)}`;
    try {
      const ids = JSON.parse(await getText(url)).esearchresult?.idlist || [];
      for (const id of ids) {
        if (knownIds.has("pm" + id)) continue;
        if (!found.has(id)) found.set(id, []);
        found.get(id).push(key);
      }
    } catch (e) { log("PubMed-Suche", key, "fehlgeschlagen:", e.message); }
    await sleep(400); // NCBI: max. 3 Anfragen/Sekunde ohne Schlüssel
  }
  const pmids = [...found.keys()].slice(0, MAX_NEW_PER_RUN);
  if (!pmids.length) return [];
  const xml = await getText(`${EUTILS}efetch.fcgi?db=pubmed&retmode=xml&tool=ouradar&id=${pmids.join(",")}`);
  return parsePubmedXml(xml).map(a => ({ ...a, bereich: found.get(a.pmid) || [] }));
}

// ---------- Claude API ----------
async function claude(body, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (r.ok) return await r.json();
    const t = await r.text();
    log("Claude-API", r.status, t.slice(0, 200));
    if (r.status === 400 || r.status === 401 || r.status === 403) throw new Error("Claude-API " + r.status);
    await sleep(5000 * (i + 1));
  }
  throw new Error("Claude-API nicht erreichbar");
}
// ---------- Google Gemini (kostenloser Zugang) ----------
let geminiModelIdx = 0;
async function gemini(prompt, { search = false, json = true } = {}) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const model = GEMINI_MODELS[Math.min(geminiModelIdx, GEMINI_MODELS.length - 1)];
    const body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2 } };
    if (search) body.tools = [{ google_search: {} }];
    else if (json) body.generationConfig.responseMimeType = "application/json";
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY }, body: JSON.stringify(body)
    });
    if (r.ok) {
      const j = await r.json();
      const parts = j.candidates?.[0]?.content?.parts || [];
      return parts.map(p => p.text || "").join("\n");
    }
    const t = await r.text();
    log("Gemini", model, r.status, t.slice(0, 160));
    const modelProblem = r.status === 404 || ((r.status === 400 || r.status === 403) && /model|not (found|supported)|free tier|billing/i.test(t));
    if (modelProblem && geminiModelIdx < GEMINI_MODELS.length - 1) { geminiModelIdx++; continue; } // Modell nicht verfügbar -> nächstes
    if (r.status === 429 || r.status >= 500) { await sleep(20000 * (attempt + 1)); continue; }       // Limit erreicht -> warten
    throw new Error("Gemini " + r.status);
  }
  throw new Error("Gemini nicht erreichbar (Limit?)");
}

// ---------- Freies Modell (llama.cpp-Server im GitHub-Ablauf) ----------
async function localHealth() {
  if (!LOCAL_URL) return false;
  try { const r = await fetch(LOCAL_URL + "/health"); return r.ok; } catch { return false; }
}
async function local(prompt) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(LOCAL_URL + "/v1/chat/completions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [
            { role: "system", content: "Du bist ein sorgfältiger medizinischer Fachübersetzer. Du gibst ausschließlich Informationen wieder, die im gelieferten Text stehen. Du erfindest nichts. Du antwortest nur mit gültigem JSON." },
            { role: "user", content: prompt }
          ],
          temperature: 0, top_p: 1, max_tokens: 600, response_format: { type: "json_object" }
        })
      });
      if (r.ok) { const j = await r.json(); return j.choices?.[0]?.message?.content || ""; }
      log("Lokales Modell HTTP", r.status);
    } catch (e) { log("Lokales Modell Fehler", e.message); }
    await sleep(3000);
  }
  throw new Error("Lokales Modell nicht erreichbar");
}

// ---------- Prüfungen gegen erfundene Inhalte ----------
const NUMWORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, twenty: 20, hundred: 100, single: 1, double: 2, twice: 2, half: 0.5, first: 1, second: 2, third: 3 };
const normNum = x => { let v = x.replace(/\s/g, "").replace(/(\d)[.,](\d{3})(?!\d)/g, "$1$2").replace(",", "."); const n = Number(v); return isFinite(n) ? String(n) : v; };
function numbersIn(text) { return (String(text).match(/\d+(?:[.,]\d+)*(?:[.,]\d+)?/g) || []).map(normNum); }
function sourceNumbers(src) {
  const set = new Set(numbersIn(src));
  for (const [w, n] of Object.entries(NUMWORDS)) if (new RegExp("\\b" + w + "\\b", "i").test(src)) set.add(String(n));
  return set;
}
// Liefert null, wenn der Text sauber ist, sonst den Grund
export function checkAgainstSource(out, src) {
  if (!out) return null;
  const allowed = sourceNumbers(src);
  const bad = numbersIn(out).filter(n => !allowed.has(n));
  if (bad.length) return "Zahl nicht in der Quelle: " + bad.slice(0, 3).join(", ");
  // Empfehlungen nur, wenn die Quelle selbst eine ausspricht
  if (/(empfehl|sollte[n]? |sollen |muss |müssen |indiziert|Therapie der Wahl)/i.test(out) && !/(recommend|should|must|guideline|suggest|advis)/i.test(src))
    return "Empfehlung, die nicht in der Quelle steht";
  if (out.length > 600) return "zu lang";
  return null;
}

// Einheitlicher Zugang: Claude (falls Schlüssel) > freies Modell > Gemini
async function llm(prompt, { search = false, open = "{" } = {}) {
  if (!API_KEY && LOCAL_OK && !search) {
    return extractJson(await local(prompt), open);
  }
  if (GEMINI_KEY && !API_KEY && search) {
    // Google verbietet, Ergebnisse der Google-Suche (Grounding) zu speichern/weiterzuverbreiten -> AWMF-Suche nur mit Claude
    throw new Error("AWMF-Suche benötigt ANTHROPIC_API_KEY");
  }
  if (GEMINI_KEY && !API_KEY && !search) {
    const out = await gemini(prompt, { search: false });
    await sleep(Number(process.env.OURADAR_SLEEP ?? 7000)); // Free Tier: wenige Anfragen pro Minute
    return extractJson(out, open);
  }
  const res = await claude(search
    ? { model: MODEL_SEARCH, max_tokens: 4000, messages: [{ role: "user", content: prompt }], tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }] }
    : { model: MODEL_SUMMARY, max_tokens: 900, messages: [{ role: "user", content: prompt }] });
  return extractJson(textOf(res), open);
}

const textOf = res => (res.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
function extractJson(s, open = "{") {
  const close = open === "{" ? "}" : "]";
  const a = s.indexOf(open), b = s.lastIndexOf(close);
  if (a < 0 || b < a) throw new Error("Kein JSON in Antwort");
  return JSON.parse(s.slice(a, b + 1));
}

const SUMMARY_RULES = `Du fasst medizinische Fachpublikationen für Ärztinnen und Ärzte in Orthopädie und Unfallchirurgie (Deutschland) zusammen.
Regeln:
- Gib NUR wieder, was im gelieferten Text steht. Erfinde keine Zahlen, keine Studiendetails, keine Empfehlungen.
- Keine Dosierungen oder Therapieanweisungen, die nicht ausdrücklich in der Quelle stehen.
- Formuliere vorsichtig und sachlich. Bei kleiner Fallzahl, Pilotstudie oder unklarer Aussage weise darauf hin.
- Eigene Worte, keine wörtlichen Sätze aus der Quelle übernehmen.
- Deutsch, prägnant.`;

async function summarizeStudyStrict(a) {
  const prompt = `Aufgabe: Gib die folgende englische Publikation auf Deutsch wieder. STRENGE REGELN:
1. Verwende NUR Informationen aus Titel und Abstract unten. Nichts hinzufügen, nichts schlussfolgern, kein Hintergrundwissen.
2. Übernimm Zahlen exakt so, wie sie im Abstract stehen. Keine Zahl, die nicht im Abstract steht. Keine Dosierungen, keine Rechenergebnisse.
3. Keine eigenen Empfehlungen. "fazit" ist ausschließlich die Schlussfolgerung der Autoren aus dem Abstract (Abschnitt CONCLUSION/INTERPRETATION), sinngemäß übersetzt. Gibt es keine, dann "".
4. Wenn du etwas nicht sicher aus dem Text entnehmen kannst, lass das Feld leer ("").
5. Kurz und sachlich.

Titel: ${a.title}
Typ: ${a.st}
Abstract:
${a.abstract}

Antworte nur mit JSON:
{"titel": "deutsche Übersetzung des Titels",
 "worum": "1 Satz: Fragestellung und Studiendesign/Fallzahl laut Abstract",
 "ergebnis": "1–2 Sätze: Hauptergebnis laut Abstract",
 "fazit": "1 Satz: Schlussfolgerung der Autoren laut Abstract",
 "relevant": true oder false (false nur, wenn das Thema nichts mit Orthopädie/Unfallchirurgie zu tun hat),
 "bereich": Liste aus "trauma","alter","endo","fuss","knie","schulter","ws","kinder","infekt"}`;
  const s = await llm(prompt);
  return { titel: s.titel, kurz: [s.worum, s.ergebnis].filter(Boolean).join(" "), praxis: s.fazit || "", relevant: s.relevant, bereich: s.bereich, praxisLabel: "Fazit der Autoren (laut Abstract)" };
}

async function summarizeStudy(a) {
  if (!API_KEY) return summarizeStudyStrict(a); // freie Modelle: nur striktes, quellentreues Format
  const prompt = `${SUMMARY_RULES}

Publikation:
Titel: ${a.title}
Journal: ${a.journal} ${a.y}
Typ: ${a.st}
Abstract:
${a.abstract || "(kein Abstract vorhanden)"}

Antworte nur mit JSON:
{"relevant": true|false (false, wenn für Orthopädie/Unfallchirurgie klinisch kaum relevant),
 "titel": "prägnanter deutscher Titel, max. 110 Zeichen, Studienakronym voran falls vorhanden",
 "kurz": "2–3 Sätze: Fragestellung, Design/Fallzahl, Hauptergebnis mit Zahlen aus dem Abstract",
 "praxis": "1 Satz: Was bedeutet das für die Praxis? Vorsichtig; bei schwacher Evidenz sagen",
 "bereich": ["trauma"|"alter"|"endo"|"fuss"|"knie"|"schulter"|"ws"|"kinder"|"infekt", ...]}`;
  return await llm(prompt);
}

async function awmfNew(knownLL) {
  const prompt = `${SUMMARY_RULES}

Aufgabe: Finde AWMF-Leitlinien aus Orthopädie und Unfallchirurgie (z. B. federführend oder beteiligt: DGOU, DGU, DGOOC, Sektionen wie D.A.F., AE, DWG, AGA, DVSE, Alterstraumatologie, Kindertraumatologie, Frakturassoziierte Infektionen, VTE-Prophylaxe in O&U), die in den letzten 60 Tagen im AWMF-Leitlinienregister NEU erschienen oder AKTUALISIERT wurden.
Bereits bekannt (nicht nochmal liefern): ${[...knownLL].join(", ") || "keine"}.

Nutze die Websuche. Liefere nur Leitlinien, die du in den Suchergebnissen tatsächlich gesehen hast, mit echter Registernummer (Format NNN-NNN).
Antworte am Ende nur mit einem JSON-Array (leer, wenn nichts Neues):
[{"registernummer":"187-051","titel":"S2e-Leitlinie …","klasse":"S1|S2k|S2e|S3","stand":"JJJJ-MM",
  "status":"Neu"|"Aktualisiert",
  "quelle":"AWMF NNN-NNN · federführende Fachgesellschaft",
  "kurz":"2–3 Sätze: Worum geht es, was ist neu/zentral",
  "praxis":"1 Satz: Was ändert sich für die Praxis (nur wenn in Quellen erkennbar, sonst 'Details in der Leitlinie')",
  "bereich":["trauma"|"alter"|"endo"|"fuss"|"knie"|"schulter"|"ws"|"kinder"|"infekt"]}]`;
  const arr = await llm(prompt, { search: true, open: "[" });
  return (Array.isArray(arr) ? arr : []).filter(x =>
    x && /^\d{3}-\d{3}[A-Z]?$/.test(x.registernummer || "") && x.titel && /^\d{4}-\d{2}$/.test(x.stand || "")
  );
}

// ---------- Hauptablauf ----------
const cleanBereich = b => (Array.isArray(b) ? b : []).filter(k => BEREICH_KEYS.includes(k));

export async function main() {
  const feed = await readJson(FEED_FILE, { items: [] });
  const blocked = new Set((await readJson(BLOCK_FILE, { ids: [] })).ids || []);
  const items = (feed.items || []).filter(i => !blocked.has(i.id));
  const known = new Set(items.map(i => i.id));
  const added = [];

  LOCAL_OK = await localHealth();
  log("KI:", API_KEY ? "Claude" : LOCAL_OK ? "freies Modell (lokal)" : GEMINI_KEY ? "Gemini" : "keine – nur Titel/Links");

  // 1) PubMed
  log("PubMed-Suche …");
  let studies = [];
  try { studies = await pubmedNew(known); } catch (e) { log("PubMed übersprungen:", e.message); }
  log(studies.length, "neue Publikationen gefunden");
  for (const a of studies) {
    const id = "pm" + a.pmid;
    if (blocked.has(id)) continue;
    const base = {
      id, typ: a.isLL ? "leitlinie" : "studie", status: `${a.st} · ${a.journal}`, datum: a.datum,
      bereich: a.bereich, titel: a.title,
      quelle: `${a.first ? a.first + " et al., " : ""}${a.journal} ${a.y} · PMID ${a.pmid}`,
      kurz: "", praxis: "", link: `https://pubmed.ncbi.nlm.nih.gov/${a.pmid}/`, ki: false, quelleTyp: "pubmed"
    };
    if (HAS_AI() && a.abstract) {
      try {
        const s = await summarizeStudy(a);
        if (s.relevant === false) { log("nicht relevant:", a.pmid); blocked.add(id); continue; }
        const src = a.title + "\n" + a.abstract;
        const pTitel = checkAgainstSource(s.titel, src);
        const pKurz = checkAgainstSource(s.kurz, src);
        const pPraxis = checkAgainstSource(s.praxis, src);
        if (pTitel) log("Titel verworfen", a.pmid, pTitel);
        if (pKurz) log("Kurzfassung verworfen", a.pmid, pKurz);
        if (pPraxis) log("Fazit verworfen", a.pmid, pPraxis);
        const kurzOk = !pKurz && s.kurz;
        Object.assign(base, {
          titel: (!pTitel && s.titel) ? s.titel : a.title, originaltitel: a.title,
          kurz: kurzOk ? s.kurz : "",
          praxis: (kurzOk && !pPraxis) ? (s.praxis || "") : "",
          bereich: cleanBereich(s.bereich).length ? cleanBereich(s.bereich) : a.bereich,
          ki: !!(kurzOk || (!pTitel && s.titel))
        });
        if (s.praxisLabel && base.praxis) base.praxisLabel = s.praxisLabel;
      } catch (e) { log("Zusammenfassung fehlgeschlagen", a.pmid, e.message); }
    }
    added.push(base);
  }

  // 2) AWMF (wöchentlich)
  const lastAwmf = feed.lastAwmfCheck ? Date.parse(feed.lastAwmfCheck) : 0;
  let lastAwmfCheck = feed.lastAwmfCheck || null;
  if (API_KEY && Date.now() - lastAwmf > (AWMF_EVERY_DAYS - 0.5) * 864e5) {
    log("AWMF-Suche …");
    try {
      const knownLL = new Set(items.filter(i => i.quelleTyp === "awmf").map(i => i.id.replace(/^awmf-/, "")));
      const lls = await awmfNew(knownLL);
      for (const l of lls) {
        const id = `awmf-${l.registernummer}-${l.stand}`;
        if (known.has(id) || blocked.has(id)) continue;
        added.push({
          id, typ: "leitlinie", status: `${l.status || "Neu"} · ${l.klasse || "AWMF"}`, datum: l.stand,
          bereich: cleanBereich(l.bereich), titel: l.titel, quelle: l.quelle || `AWMF ${l.registernummer}`,
          kurz: l.kurz || "", praxis: l.praxis || "",
          link: `https://register.awmf.org/de/leitlinien/detail/${l.registernummer}`, ki: true, quelleTyp: "awmf"
        });
      }
      log(lls.length, "AWMF-Treffer");
      lastAwmfCheck = new Date().toISOString();
    } catch (e) { log("AWMF übersprungen:", e.message); }
  }

  const all = [...added, ...items]
    .sort((a, b) => (b.datum || "").localeCompare(a.datum || ""))
    .slice(0, MAX_ITEMS);
  const out = {
    version: 1,
    generated: new Date().toISOString(),
    lastAwmfCheck,
    hinweis: "KI-erstellte Zusammenfassungen (ki: true) sind nicht ärztlich geprüft. Maßgeblich ist die verlinkte Originalquelle. Publikationsdaten: PubMed®/NLM.",
    items: all
  };
  await writeFile(FEED_FILE, JSON.stringify(out, null, 1) + "\n");
  await writeFile(BLOCK_FILE, JSON.stringify({ ids: [...blocked] }, null, 1) + "\n");
  log(`Fertig: ${added.length} neu, ${all.length} gesamt.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
