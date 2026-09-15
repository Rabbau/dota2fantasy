"""
Собирает docs/data.js из data/formulas.json + data/players_stat.json.

Нужен, потому что docs/index.html больше не делает fetch() (это не работает ни
через file://, ни на GitHub Pages, когда сайт публикуется из папки docs/ — всё,
что выше её корня, недоступно). Вместо этого страница просто подключает
data.js обычным <script src="data.js">, а он кладёт данные в window.TI_DATA.

Запуск вручную — после правки data/formulas.json без обновления статы:
    python parser/build_docs_data.py

После python parser/fetch_stats.py вызывается автоматически.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def build() -> Path:
    formulas = json.loads((ROOT / "data" / "formulas.json").read_text(encoding="utf-8"))
    players_stat = json.loads((ROOT / "data" / "players_stat.json").read_text(encoding="utf-8"))

    payload = {"formulas": formulas, "playersStat": players_stat}
    js = (
        "// Автогенерируется parser/build_docs_data.py — не редактировать руками.\n"
        "window.TI_DATA = " + json.dumps(payload, ensure_ascii=False, indent=2) + ";\n"
    )

    out_path = ROOT / "docs" / "data.js"
    out_path.write_text(js, encoding="utf-8")
    return out_path


if __name__ == "__main__":
    path = build()
    print(f"Готово -> {path}")
