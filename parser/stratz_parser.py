"""УСТАРЕЛО / НЕ ИСПОЛЬЗУЕТСЯ.

Проект перешёл на OpenDota Explorer (parser/fetch_stats.py): токен не нужен, а
все нужные фэнтези-статы (стаки, руны, варды, оглушения, убийства Рошана,
Терзателей, курьеров, применения Smoke, первая кровь) достаются одним SQL.

У Stratz те же поля разбросаны по вложенным event-типам внутри `match.players.stats`
и требуют куда больше запросов и разбора. Если Explorer у OpenDota отключат,
Stratz — резервный вариант; токен можно положить в .env как STRATZ_TOKEN.
"""
import sys

if __name__ == "__main__":
    sys.exit("Используй: python parser/fetch_stats.py")
