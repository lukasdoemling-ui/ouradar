# O&U Radar – automatischer Feed

Dieser Ordner sorgt dafür, dass die App **O&U Radar** ohne Pflege immer aktuelle Inhalte hat.

## Was passiert automatisch?
Jeden Tag gegen 5 Uhr (UTC) läuft hier auf GitHub ein kleiner Ablauf (`.github/workflows/update.yml`):

1. **PubMed:** Für alle O&U-Teilbereiche werden neue RCTs, Meta-Analysen und Leitlinien der letzten 3 Wochen gesucht.
2. **AWMF (einmal pro Woche):** Eine KI mit Websuche sucht neue oder aktualisierte AWMF-Leitlinien aus O&U.
3. **Zusammenfassung:** Jeder neue Eintrag wird von einer KI (Claude) auf Deutsch zusammengefasst: Kurzfassung + „Was ändert sich?“ + Link zum Original. Irrelevante Treffer werden aussortiert.
4. **Ergebnis:** Alles landet in `docs/feed.json`. Diese Datei ist öffentlich unter
   `https://<benutzername>.github.io/<repository>/feed.json` erreichbar. Die App lädt sie beim Öffnen.

Alle KI-Texte sind in der App als **„KI-Zusammenfassung · nicht ärztlich geprüft“** gekennzeichnet und verlinken auf die Originalquelle.

## Laufende Kosten
- GitHub (Ablauf + Hosting): kostenlos.
- KI-Nutzung über die Claude API: Studien-Zusammenfassungen laufen mit dem günstigen Modell (Claude Haiku), die wöchentliche AWMF-Suche mit Claude Sonnet + Websuche. Erwartung: wenige Euro pro Monat. Das Guthaben verwaltet man in der Claude Console (platform.claude.com). Dort kann man ein Ausgabenlimit setzen.
- Ohne API-Schlüssel oder ohne Guthaben läuft der Ablauf weiter, dann nur mit Originaltiteln und Links ohne Zusammenfassung.

## Einstellungen
- **API-Schlüssel:** Repository → *Settings* → *Secrets and variables* → *Actions* → Secret `ANTHROPIC_API_KEY`.
- **Häufigkeit:** in `.github/workflows/update.yml` die Zeile `cron`.
- **Suchbegriffe pro Bereich, Anzahl, Zeitfenster:** oben in `scripts/update.mjs` (`BEREICHE`, `MAX_NEW_PER_RUN`, `DAYS_BACK`).
- **Manuell starten:** Reiter *Actions* → „Feed aktualisieren“ → *Run workflow*.

## Einen fehlerhaften Eintrag entfernen
1. In `docs/feed.json` den Eintrag suchen (z. B. nach dem Titel), seine `id` merken und den Eintrag löschen.
2. Die `id` in `docs/blocked.json` in die Liste `ids` eintragen, damit er nicht wieder auftaucht.
3. Speichern („Commit changes“). Die App zeigt es beim nächsten Öffnen nicht mehr an.

## Übergabe an jemand anderen
- Repository übertragen: *Settings* → ganz unten *Transfer ownership*, oder die Person als Mitarbeiter hinzufügen.
- Der neue Träger hinterlegt seinen eigenen API-Schlüssel als Secret.
- Wenn sich die Adresse der Datei ändert, muss in der App die Konstante `FEED_URL` angepasst werden (einmaliges App-Update).

## Rechtliches
Siehe `docs/rechtliches.html` und `docs/datenschutz.html`. Diese Seiten sind auch öffentlich erreichbar und können im App Store als Datenschutz-Link angegeben werden.
