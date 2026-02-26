#!/usr/bin/env python3
"""
VeloTrek — генератор каталога маршрутов.
Сканирует подпапки routes/, парсит KML/KMZ файлы, создаёт routes/index.json.
Имя подпапки = название раздела каталога.

Запуск локально:   python3 scripts/generate-index.py
Запуск в Actions:  python3 scripts/generate-index.py
"""

import json
import math
import os
import re
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree as ET

ROUTES_DIR = Path(__file__).parent.parent / "routes"
OUTPUT_FILE = ROUTES_DIR / "index.json"
KML_NS = "http://www.opengis.net/kml/2.2"


def calc_elevation_stats(segments: list) -> dict:
    """Вычисляет статистику высот из координат треков.

    Применяет скользящее среднее (окно 5 точек) перед суммированием
    подъёмов/спусков. Точки треков расположены через ~200–300 м, окно
    сглаживает суб-километровые артефакты SRTM-интерполяции, сохраняя
    реальный рельеф.
    """
    WINDOW = 5
    climb = 0.0
    descent = 0.0
    min_ele = float("inf")
    max_ele = float("-inf")
    has_ele = False

    for seg in segments:
        eles = [pt[2] for pt in seg if len(pt) > 2 and pt[2]]
        if len(eles) < 2:
            continue
        has_ele = True
        for e in eles:
            if e < min_ele:
                min_ele = e
            if e > max_ele:
                max_ele = e

        # Скользящее среднее
        half = WINDOW // 2
        smoothed = []
        for i in range(len(eles)):
            s = max(0, i - half)
            e_idx = min(len(eles) - 1, i + half)
            smoothed.append(sum(eles[s:e_idx + 1]) / (e_idx - s + 1))

        for i in range(1, len(smoothed)):
            diff = smoothed[i] - smoothed[i - 1]
            if diff > 0:
                climb += diff
            else:
                descent -= diff

    if not has_ele:
        return {}
    return {
        "elevation_min_m": round(min_ele),
        "elevation_max_m": round(max_ele),
        "climb_m": round(climb),
        "descent_m": round(descent),
    }


def haversine_km(lat1, lon1, lat2, lon2) -> float:
    """Расстояние между двумя точками в км (формула гаверсинуса)."""
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


def segment_length_km(points: list) -> float:
    """Суммарная длина ломаной по списку (lat, lon) точек."""
    total = 0.0
    for i in range(1, len(points)):
        total += haversine_km(points[i-1][0], points[i-1][1], points[i][0], points[i][1])
    return total


def bbox_span_km(bbox: dict) -> float:
    """Диагональ bounding box — 'размах' маршрута в км."""
    dlat_km = (bbox["maxLat"] - bbox["minLat"]) * 111.32
    mid_lat = (bbox["maxLat"] + bbox["minLat"]) / 2
    dlon_km = (bbox["maxLon"] - bbox["minLon"]) * 111.32 * math.cos(math.radians(mid_lat))
    return math.sqrt(dlat_km ** 2 + dlon_km ** 2)


def parse_coordinates(coords_text: str):
    """Парсит строку координат KML (lon,lat,ele ...) в список (lat, lon, ele)."""
    points = []
    for triplet in coords_text.strip().split():
        parts = triplet.split(",")
        if len(parts) >= 2:
            try:
                lon = float(parts[0])
                lat = float(parts[1])
                ele = float(parts[2]) if len(parts) >= 3 else 0.0
                points.append((lat, lon, ele))
            except ValueError:
                pass
    return points


def parse_kml(kml_text: str) -> dict:
    """Парсит KML-текст и возвращает метаданные маршрута."""
    ns = {"k": KML_NS}

    try:
        root = ET.fromstring(kml_text.encode("utf-8"))
    except ET.ParseError as e:
        raise ValueError(f"Ошибка парсинга KML: {e}")

    # Ищем Document (может быть в корне или вложен)
    doc = root.find("k:Document", ns)
    if doc is None:
        doc = root  # Fallback

    # Название и описание документа
    name_el = doc.find("k:name", ns)
    doc_name = name_el.text.strip() if name_el is not None and name_el.text else ""

    desc_el = doc.find("k:description", ns)
    doc_desc = desc_el.text.strip() if desc_el is not None and desc_el.text else ""

    pois = []
    segments = []  # список сегментов: каждый — list of (lat, lon, ele)
    track_km = 0.0
    bbox = {"minLat": 90, "maxLat": -90, "minLon": 180, "maxLon": -180}

    def update_bbox(lat, lon):
        bbox["minLat"] = min(bbox["minLat"], lat)
        bbox["maxLat"] = max(bbox["maxLat"], lat)
        bbox["minLon"] = min(bbox["minLon"], lon)
        bbox["maxLon"] = max(bbox["maxLon"], lon)

    # Все плейсмарки на любой глубине
    for pm in root.iter(f"{{{KML_NS}}}Placemark"):
        point = pm.find(f"{{{KML_NS}}}Point")
        multi = pm.find(f"{{{KML_NS}}}MultiGeometry")
        line = pm.find(f"{{{KML_NS}}}LineString")

        if point is not None:
            coords_el = point.find(f"{{{KML_NS}}}coordinates")
            if coords_el is not None and coords_el.text:
                pts = parse_coordinates(coords_el.text)
                if pts:
                    lat, lon = pts[0][0], pts[0][1]
                    name_el = pm.find(f"{{{KML_NS}}}name")
                    pois.append({
                        "name": name_el.text.strip() if name_el is not None and name_el.text else "",
                        "lat": lat,
                        "lon": lon,
                    })
                    update_bbox(lat, lon)

        elif multi is not None:
            for ls in multi.iter(f"{{{KML_NS}}}LineString"):
                coords_el = ls.find(f"{{{KML_NS}}}coordinates")
                if coords_el is not None and coords_el.text:
                    pts = parse_coordinates(coords_el.text)
                    if pts:
                        segments.append(pts)
                        track_km += segment_length_km(pts)
                        for pt in pts:
                            update_bbox(pt[0], pt[1])

        elif line is not None:
            coords_el = line.find(f"{{{KML_NS}}}coordinates")
            if coords_el is not None and coords_el.text:
                pts = parse_coordinates(coords_el.text)
                if pts:
                    segments.append(pts)
                    track_km += segment_length_km(pts)
                    for pt in pts:
                        update_bbox(pt[0], pt[1])

    # Если bbox не обновился — нет координат
    if bbox["minLat"] == 90:
        bbox = None

    # Все статистики из координат
    stats = {}
    stats["track_km"] = round(track_km, 1)
    if bbox:
        stats["span_km"] = round(bbox_span_km(bbox), 1)
    stats.update(calc_elevation_stats(segments))

    return {
        "name": doc_name,
        "description": re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", doc_desc)).strip(),
        "stats": stats,
        "pois": pois,
        "segmentCount": len(segments),
        "bbox": bbox,
    }


def load_route_file(filepath: Path) -> dict:
    """Загружает KML или KMZ файл и возвращает метаданные."""
    if filepath.suffix.lower() == ".kmz":
        try:
            with zipfile.ZipFile(filepath) as z:
                # Ищем doc.kml или любой .kml внутри
                kml_names = [n for n in z.namelist() if n.lower().endswith(".kml")]
                if not kml_names:
                    raise ValueError("В KMZ не найден KML-файл")
                kml_name = "doc.kml" if "doc.kml" in kml_names else kml_names[0]
                kml_text = z.read(kml_name).decode("utf-8")
        except zipfile.BadZipFile:
            raise ValueError("Файл повреждён или не является KMZ")
    else:
        kml_text = filepath.read_text(encoding="utf-8")

    return parse_kml(kml_text)


def generate_index():
    if not ROUTES_DIR.exists():
        print(f"Папка {ROUTES_DIR} не найдена", file=sys.stderr)
        sys.exit(1)

    # Сканируем подпапки — каждая папка = раздел каталога
    section_dirs = sorted([
        d for d in ROUTES_DIR.iterdir()
        if d.is_dir()
    ])

    if not section_dirs:
        print("Подпапки с маршрутами не найдены в routes/")
        sections = []
    else:
        sections = []
        for section_dir in section_dirs:
            section_name = section_dir.name
            route_files = sorted([
                f for f in section_dir.iterdir()
                if f.is_file() and f.suffix.lower() in (".kml", ".kmz")
            ])
            if not route_files:
                continue

            print(f"\n[{section_name}]")
            routes = []
            for filepath in route_files:
                print(f"  Обработка: {filepath.name} ...", end=" ")
                try:
                    meta = load_route_file(filepath)
                    route_entry = {
                        "filename": f"{section_name}/{filepath.name}",
                        "name": meta["name"] or filepath.stem.replace("-", " ").replace("_", " "),
                        "description": "",
                        "stats": meta["stats"],
                        "poiCount": len(meta["pois"]),
                        "segmentCount": meta["segmentCount"],
                        "bbox": meta["bbox"],
                    }
                    routes.append(route_entry)
                    track = meta["stats"].get("track_km", "?")
                    span = meta["stats"].get("span_km", "?")
                    poi = len(meta["pois"])
                    print(f"OK (трек {track} км, размах {span} км, {poi} POI)")
                except Exception as e:
                    print(f"ОШИБКА: {e}", file=sys.stderr)
                    # Добавляем запись с ошибкой, чтобы файл всё равно попал в каталог
                    routes.append({
                        "filename": f"{section_name}/{filepath.name}",
                        "name": filepath.stem.replace("-", " ").replace("_", " "),
                        "description": "",
                        "stats": {},
                        "poiCount": 0,
                        "segmentCount": 0,
                        "bbox": None,
                        "error": str(e),
                    })

            sections.append({
                "name": section_name,
                "routes": routes,
            })

    total_routes = sum(len(s["routes"]) for s in sections)
    index = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sections": sections,
    }

    OUTPUT_FILE.write_text(
        json.dumps(index, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )
    print(f"\nГотово: {OUTPUT_FILE}")
    print(f"Разделов: {len(sections)}, маршрутов всего: {total_routes}")


if __name__ == "__main__":
    print("VeloTrek — генерация каталога маршрутов")
    print("=" * 40)
    generate_index()
