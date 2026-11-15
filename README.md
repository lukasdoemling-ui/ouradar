# O&U Radar – automatischer Feed

Dieser Ordner sorgt dafür, dass die App **O&U Radar** ohne Pflege immer aktuelle Inhalte hat.

## Was passiert automatisch?
Jeden Tag gegen 3 Uhr (UTC) läuft hier auf GitHub ein kleiner Ablauf (`.github/workflows/update.yml`):

1. **PubMed:** Für alle O&U-Teilbereiche werden neue RCTs, Meta-Analysen und Leitlinien der letzten 3 Wochen gesucht.
2. **AWMF (einmal pro Woche, nur mit optionalem Claude-Schlüssel):** Eine KI mit Websuche sucht neue oder aktualisierte AWMF-Leitlinien aus O&U.
3. **Zusammenfassung:** Jeder neue Eintrag wird von einer KI auf Deutsch wiedergegeben (Fragestellung, Ergebnis, Fazit der Autoren) und automatisch auf erfundene Inhalte geprüft. Irrelevante Treffer werden aussortiert.
4. **Ergebnis:** Alles landet in `docs/feed.json`. Diese Datei ist öffentlich unter
   `https://<benutzername>.github.io/<repository>/feed.json` erreichbar. Die App lädt sie beim Öffnen.

Alle KI-Texte sind in der App als **„KI-Zusammenfassung · nicht ärztlich geprüft“** gekennzeichnet und verlinken auf die Originalquelle.

## Laufende Kosten: 0 €
- Ablauf und Hosting laufen kostenlos bei GitHub (öffentliches Repository).
- Die Zusammenfassungen schreibt ein **freies KI-Modell** (Qwen2.5-7B-Instruct, Lizenz Apache 2.0), das bei jedem Lauf direkt auf GitHubs Rechnern mit llama.cpp ausgeführt wird. Es gibt **keinen externen KI-Anbieter, kein Konto, keinen Schlüssel**.
- Das Modell wird beim ersten Lauf heruntergeladen (ca. 4,7 GB) und danach zwischengespeichert. Ein Lauf dauert dadurch 20–60 Minuten – das ist egal, er läuft nachts.

## Schutz vor erfundenen Inhalten
- Das Modell bekommt nur Titel und Abstract und darf nur wiedergeben, was dort steht.
- Statt einer eigenen Bewertung wird nur das **Fazit der Autoren laut Abstract** angezeigt.
- Jede Zusammenfassung wird **automatisch geprüft**: Enthält sie eine Zahl, die nicht im Abstract vorkommt, oder eine Empfehlung, die die Quelle nicht ausspricht, wird sie verworfen. Dann erscheint nur der übersetzte Titel mit Link.
- Alle KI-Texte sind in der App als „KI-Zusammenfassung · nicht ärztlich geprüft“ gekennzeichnet.

## Optional: bessere Qualität und AWMF-Suche
Wird ein Secret `ANTHROPIC_API_KEY` (Claude API, ca. 1 $/Monat) hinterlegt, nutzt der Ablauf automatisch Claude statt des freien Modells und sucht zusätzlich wöchentlich nach neuen AWMF-Leitlinien. Die automatischen Prüfungen bleiben aktiv.

## Einstellungen
- **Optionaler KI-Schlüssel:** Repository → *Settings* → *Secrets and variables* → *Actions* → Secret `ANTHROPIC_API_KEY`.
- **Häufigkeit:** in `.github/workflows/update.yml` die Zeile `cron`.
- **Suchbegriffe pro Bereich, Anzahl, Zeitfenster:** oben in `scripts/update.mjs` (`BEREICHE`, `MAX_NEW_PER_RUN`, `DAYS_BACK`).
- **Manuell starten:** Reiter *Actions* → „Feed aktualisieren“ → *Run workflow*.

## Einen fehlerhaften Eintrag entfernen
1. In `docs/feed.json` den Eintrag suchen (z. B. nach dem Titel), seine `id` merken und den Eintrag löschen.
2. Die `id` in `docs/blocked.json` in die Liste `ids` eintragen, damit er nicht wieder auftaucht.
3. Speichern („Commit changes“). Die App zeigt es beim nächsten Öffnen nicht mehr an.

## Übergabe an jemand anderen
- Repository übertragen: *Settings* → ganz unten *Transfer ownership*, oder die Person als Mitarbeiter hinzufügen.
- Ohne Schlüssel läuft alles kostenlos weiter. **Die Nutzer der App brauchen keinerlei Konto oder Schlüssel.**
- Wenn sich die Adresse der Datei ändert, muss in der App die Konstante `FEED_URL` angepasst werden (einmaliges App-Update).

## Rechtliches
Siehe `docs/rechtliches.html` und `docs/datenschutz.html`. Diese Seiten sind auch öffentlich erreichbar und können im App Store als Datenschutz-Link angegeben werden.
