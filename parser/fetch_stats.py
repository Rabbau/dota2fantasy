"""
Тянет статистику игроков ростера за конкретный турнир через OpenDota Explorer
(публичный SQL-эндпоинт по их базе про-матчей). Токен не нужен.

Один HTTP-запрос на всех игроков сразу (GROUP BY account_id) — быстро и без
упора в rate limit.

Запуск:
    python parser/fetch_stats.py            # лига из .env (LEAGUE_ID) или TI2026
    python parser/fetch_stats.py 18324      # конкретная лига (напр. TI2025)
    python parser/fetch_stats.py --last 30  # без лиги: последние N про-матчей

Результат: data/players_stat.json — усреднённые за турнир показатели каждого
игрока по ключам из data/formulas.json, плюс `matches` (размер выборки) и
`updated_at`.
"""
import argparse
import datetime as dt
import json
import sys
import time
from pathlib import Path

import requests

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except Exception:
    pass
import os

ROOT = Path(__file__).resolve().parent.parent
EXPLORER_URL = "https://api.opendota.com/api/explorer"
HEADERS = {"User-Agent": "Mozilla/5.0 (dota2fantasy-ti parser)"}
TIMEOUT = 60
MAX_RETRIES = 4
RETRY_BACKOFF = 5

# The International 2026 (main event) в базе OpenDota.
DEFAULT_LEAGUE_ID = int(os.getenv("LEAGUE_ID", "19719"))

# Выражения агрегации -> ключи из formulas.json.
# Всё, что реально лежит в таблице player_matches у OpenDota. Три стата
# (watchers / lotuses / emeralds) в их схеме отсутствуют — заполняются нулём
# и помечены в formulas.json как "available": false.
AGG_COLUMNS = """
  count(*) AS matches,
  round(avg(kills)::numeric, 3)                                   AS kills,
  round(avg(deaths)::numeric, 3)                                  AS deaths,
  round((avg(last_hits) + avg(denies))::numeric, 2)              AS creeps,
  round(avg(gold_per_min)::numeric, 2)                            AS gpm,
  round(avg(towers_killed)::numeric, 3)                           AS towers,
  round(avg(obs_placed)::numeric, 3)                              AS wards,
  round(avg(camps_stacked)::numeric, 3)                           AS camp_stacks,
  round(avg(rune_pickups)::numeric, 3)                            AS runes,
  round(avg(roshans_killed)::numeric, 3)                          AS roshan_kills,
  round(avg(teamfight_participation)::numeric, 4)                 AS teamfights,
  round(avg(stuns)::numeric, 2)                                   AS stun_seconds,
  round(avg(firstblood_claimed)::numeric, 4)                      AS first_blood,
  round(avg(COALESCE((killed->>'npc_dota_miniboss')::int, 0))::numeric, 3)     AS tormentor_kills,
  round(avg(COALESCE((killed->>'npc_dota_courier')::int, 0))::numeric, 3)      AS courier_kills,
  round(avg(COALESCE((item_uses->>'smoke_of_deceit')::int, 0))::numeric, 3)    AS smoke_uses
"""

UNAVAILABLE = {"emeralds": 0, "watchers": 0, "lotuses": 0}


def build_sql(account_ids: list[int], league_id: int | None, last_n: int) -> str:
    ids = ",".join(str(i) for i in account_ids)
    if league_id:
        where = f"m.leagueid = {league_id} AND pm.account_id IN ({ids})"
        scope = "JOIN matches m USING(match_id)"
        limit = ""
    else:
        # без лиги: берём последние N про-матчей каждого игрока через оконную функцию
        return f"""
        WITH ranked AS (
          SELECT pm.*, row_number() OVER (
            PARTITION BY pm.account_id ORDER BY m.start_time DESC
          ) AS rn
          FROM player_matches pm
          JOIN matches m USING(match_id)
          WHERE pm.account_id IN ({ids})
        )
        SELECT account_id, {AGG_COLUMNS}
        FROM ranked WHERE rn <= {last_n}
        GROUP BY account_id
        """
    return f"""
    SELECT pm.account_id, {AGG_COLUMNS}
    FROM player_matches pm
    {scope}
    WHERE {where}
    GROUP BY pm.account_id {limit}
    """


def run_explorer(sql: str) -> list[dict]:
    last_err = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = requests.get(
                EXPLORER_URL, params={"sql": sql}, headers=HEADERS, timeout=TIMEOUT
            )
            resp.raise_for_status()
            payload = resp.json()
            if payload.get("err"):
                raise RuntimeError(payload["err"])
            return payload.get("rows", [])
        except Exception as e:  # noqa: BLE001
            last_err = e
            if attempt < MAX_RETRIES:
                wait = RETRY_BACKOFF * attempt
                print(f"  (попытка {attempt}/{MAX_RETRIES}: {e}; жду {wait}с)")
                time.sleep(wait)
    raise last_err


def to_stats(row: dict) -> dict:
    out = {}
    for k, v in row.items():
        if k in ("account_id", "matches"):
            continue
        out[k] = float(v) if v is not None else 0.0
    out.update(UNAVAILABLE)
    out["sample_size"] = int(row.get("matches") or 0)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("league_id", nargs="?", type=int, default=DEFAULT_LEAGUE_ID,
                    help=f"ID лиги OpenDota (по умолчанию {DEFAULT_LEAGUE_ID} = TI2026)")
    ap.add_argument("--last", type=int, default=0,
                    help="игнорировать лигу, взять последние N про-матчей игрока")
    args = ap.parse_args()

    players_path = ROOT / "data" / "players.json"
    out_path = ROOT / "data" / "players_stat.json"
    players = json.loads(players_path.read_text(encoding="utf-8"))

    with_id = [p for p in players if p.get("steam_id")]
    ids = sorted({int(p["steam_id"]) for p in with_id})
    missing = [p["nickname"] for p in players if not p.get("steam_id")]
    if missing:
        print(f"[warn] нет steam_id (запусти resolve_ids.py): {', '.join(missing)}")
    if not ids:
        print("[error] ни у одного игрока нет steam_id")
        return 1

    league = None if args.last else args.league_id
    scope = f"последние {args.last} матчей" if args.last else f"лига {league}"
    print(f"Запрашиваю OpenDota Explorer ({scope}, {len(ids)} игроков)...")
    rows = run_explorer(build_sql(ids, league, args.last or 20))
    by_id = {int(r["account_id"]): r for r in rows}
    print(f"Получено строк: {len(rows)}")

    result, empty = [], []
    for p in players:
        sid = p.get("steam_id")
        row = by_id.get(int(sid)) if sid else None
        stats = to_stats(row) if row else {}
        if not stats:
            empty.append(p["nickname"])
        result.append({**p, "stats": stats})

    if empty:
        print(f"[warn] нет матчей в этой лиге: {', '.join(empty)}")

    payload = {
        "league_id": league,
        "scope": scope,
        "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "players": result,
    }
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    covered = sum(1 for r in result if r["stats"])
    print(f"\nГотово -> {out_path}  ({covered}/{len(result)} игроков со статой)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
