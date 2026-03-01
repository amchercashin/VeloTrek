#!/usr/bin/env python3
"""
Фикс многодневных маршрутов:
1. Переименовывает файлы 01- → 1- (убирает ведущий ноль)
2. Обновляет <Document><name> → формат «N) Название»
3. Перемещает ссылку-источник из конца описания в начало, делает её активной (<a>)
"""

import os
import re

ROUTES_DIR = os.path.join(os.path.dirname(__file__), "..", "routes", "Походы 2-3 дня МО")
SOURCE_URL = "https://bikelifeforms.ru/articles/velo-pvd-routes-podmoskovye"
SOURCE_HOST = "bikelifeforms.ru"


def fix_kml(kml_path: str, new_path: str) -> None:
    with open(kml_path, "r", encoding="utf-8") as f:
        content = f.read()

    # 1. Обновляем Document/name: «0N Название» → «N) Название»
    def replace_doc_name(m):
        old_name = m.group(1)
        # Меняем разделитель: «0N » или «N » → «N) »
        fixed = re.sub(r'^0*(\d+)\s+', r'\1) ', old_name)
        return f"<name>{fixed}</name>"

    content = re.sub(r'<name>(\d+ [^<]+)</name>', replace_doc_name, content, count=1)

    # 2. Перемещаем «Источник» из конца CDATA в начало
    def fix_cdata(m):
        cdata = m.group(1)

        # Убираем существующие строки источника (текстовые и ссылочные) — любое количество
        cdata = re.sub(
            r'\n?<p>Источник:\s*' + re.escape(SOURCE_URL) + r'</p>\n?',
            '',
            cdata
        )
        cdata = re.sub(
            r'\n?<p><a href="' + re.escape(SOURCE_URL) + r'">[^<]*</a></p>\n?',
            '',
            cdata
        )
        cdata = cdata.strip()

        # Добавляем активную ссылку в начало
        source_line = f'<p><a href="{SOURCE_URL}">{SOURCE_HOST} — источник маршрута</a></p>'
        cdata = source_line + '\n' + cdata

        return f"<description><![CDATA[{cdata}]]></description>"

    content = re.sub(
        r'<description><!\[CDATA\[(.*?)\]\]></description>',
        fix_cdata,
        content,
        count=1,
        flags=re.DOTALL,
    )

    with open(new_path, "w", encoding="utf-8") as f:
        f.write(content)


def main():
    files = sorted(os.listdir(ROUTES_DIR))
    for fname in files:
        if not fname.endswith(".kml"):
            continue

        path = os.path.join(ROUTES_DIR, fname)
        fix_kml(path, path)
        print(f"  fixed: {fname}")

    print("Done.")


if __name__ == "__main__":
    main()
