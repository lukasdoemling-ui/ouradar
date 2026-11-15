// O&U Radar – automatischer Feed
// Läuft täglich über GitHub Actions. Sucht neue Publikationen (PubMed) und
// neue/aktualisierte AWMF-Leitlinien, lässt sie per KI auf Deutsch zusammenfassen
// und schreibt alles nach docs/feed.json. Die App lädt diese Datei.
//
// Benötigt: Node 20+, Umgebungsvariable ANTHROPIC_API_KEY (als GitHub-Secret).
// Ohne Schlüssel läuft das Script trotzdem – dann ohne Zusammenfassungen.

import { readFile, writeFile } from "node:fs/promises";

const FEED_FILE = "docs/feed.json";
const BLOCK_FILE = "docs/blocked.json";
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL_SUMMARY = process.env.OURADAR_MODEL_SUMMARY || "claude-haiku-5-5";
const MODEL_SEARCH = process.env.OURADAR_MODEL_SEARCH || "claude-sonnet-5-5";
const MAX_NEW_PER_RUN = 30;      // Kostenbremse: höchstens so viele neue Studien pro Lauf
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

async function summarizeStudy(a) {
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
  const res = await claude({ model: MODEL_SUMMARY, max_tokens: 900, messages: [{ role: "user", content: prompt }] });
  return extractJson(textOf(res));
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
  const res = await claude({
    model: MODEL_SEARCH, max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }]
  });
  const arr = extractJson(textOf(res), "[");
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
    if (API_KEY && a.abstract) {
      try {
        const s = await summarizeStudy(a);
        if (s.relevant === false) { log("nicht relevant:", a.pmid); blocked.add(id); continue; }
        Object.assign(base, {
          titel: s.titel || a.title, originaltitel: a.title, kurz: s.kurz || "", praxis: s.praxis || "",
          bereich: cleanBereich(s.bereich).length ? cleanBereich(s.bereich) : a.bereich, ki: true
        });
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
