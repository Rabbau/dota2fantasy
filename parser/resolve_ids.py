"""
Автоматически подставляет steam_id (account_id) в data/players.json,
используя GET /proPlayers из OpenDota — единый список известных про-игроков
(без ключа). Это надёжнее, чем /search, потому что там нет смурфов и
рандомных аккаунтов с совпадающим именем — только реальные про-игроки
с привязкой к команде.

Запуск:
    python parser/resolve_ids.py

Матчинг:
    1. точное совпадение по полю "name" (сценический ник в проф. базе OpenDota)
    2. если не найдено — точное совпадение по "personaname" (текущий Steam-ник)
    3. если не найдено — совпадение без учёта регистра/спецсимволов (~ ` - и т.д.)
    Если найдено несколько кандидатов с разными team_name — печатаются все,
    подставляется тот, чей team_name ближе всего к data/players.json (team),
    иначе оставляется на ручной выбор.
"""
import json
import re
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
PLAYERS_PATH = ROOT / "data" / "players.json"
PRO_PLAYERS_URL = "https://api.opendota.com/api/proPlayers"

HEADERS = {"User-Agent": "Mozilla/5.0 (dota2fantasy-ti15 resolver)"}
TIMEOUT = 30
MAX_RETRIES = 4
RETRY_BACKOFF = 5


def fetch_pro_players() -> list[dict]:
    last_err = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = requests.get(PRO_PLAYERS_URL, headers=HEADERS, timeout=TIMEOUT)
            resp.raise_for_status()
            return resp.json() or []
        except Exception as e:
            last_err = e
            if attempt < MAX_RETRIES:
                wait = RETRY_BACKOFF * attempt
                print(f"(попытка {attempt}/{MAX_RETRIES} не удалась: {e}; жду {wait}с)")
                time.sleep(wait)
    raise last_err


def norm(s: str) -> str:
    if not s:
        return ""
    return re.sub(r"[^a-z0-9]", "", s.lower())


def main():
    players = json.loads(PLAYERS_PATH.read_text(encoding="utf-8"))
    print("Качаю список про-игроков OpenDota...")
    pro = fetch_pro_players()
    print(f"Получено {len(pro)} про-игроков.\n")

    # индексы для быстрого поиска
    by_name = {}
    by_persona = {}
    for pp in pro:
        by_name.setdefault(norm(pp.get("name")), []).append(pp)
        by_persona.setdefault(norm(pp.get("personaname")), []).append(pp)

    changed = False
    for p in players:
        if p.get("steam_id"):
            continue
        nick = p["nickname"]
        key = norm(nick)

        candidates = by_name.get(key) or by_persona.get(key) or []

        if not candidates:
            print(f"[none] {nick}: не найден в proPlayers (мог не играть про-матчи в базе OpenDota, впиши вручную)")
            continue

        if len(candidates) == 1:
            best = candidates[0]
        else:
            # пытаемся отфильтровать по совпадению команды
            team_key = norm(p.get("team", ""))
            team_matches = [c for c in candidates if norm(c.get("team_name")) == team_key]
            if len(team_matches) == 1:
                best = team_matches[0]
            else:
                print(f"[ambiguous] {nick}: несколько кандидатов, выбери руками:")
                for c in candidates:
                    print(f"    account_id={c['account_id']:<12} name={c.get('name')!r} team={c.get('team_name')!r}")
                continue

        p["steam_id"] = best["account_id"]
        p["_resolved_team"] = best.get("team_name")
        print(f"[ok] {nick} -> {best['account_id']} (team: {best.get('team_name')})")
        changed = True

    if changed:
        PLAYERS_PATH.write_text(json.dumps(players, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\nОбновлено -> {PLAYERS_PATH}")
    else:
        print("\nНичего не изменилось.")


if __name__ == "__main__":
    main()
