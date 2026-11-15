#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
generate-tab-icons.py — 3D-иконки второй шеренги вкладок (запрос владельца 2026-10-31).

ЧТО ДЕЛАЕТ
  Рисует 4 иконки «стекла» в палитре существующего набора tab-*-3d.png
  (cyan-свечение, стекло — голубые градиенты, объём — тёмная сдвиг-экструзия,
  фон — тёмный navy radial-градиент) и пишет PNG 1024x1024 в public/:

    tab-settings-3d.png   — шестерня «Настройки»
    tab-community-3d.png  — пузырь «Чаты»
    tab-faq-3d.png        — линза с «?» — FAQ
    tab-archiver-3d.png   — zip-пакет «Архиватор»
    tab-owner-3d.png      — ключ доступа «Владелец» (был плоский inline-SVG)

ЗАЧЕМ СКРИПТ
  PNG в public/ — детерминированный артефакт: владельцу/агенту можно
  перегенерировать иконки после правок палитры/форм, не рисуя заново.
  Палитра снята пипеткой с tab-shop-3d.png (фона #0A1C34..#111F2C,
  стекло cyan-blue).

ВСЯ ГЕОМЕТРИЯ — В ЛОКАЛЬНОЙ СК (-330..330, центр 0,0), один общий приём:
  экструзия = та же фигура, сдвинутая вниз-влево и залитая градиентом «deep»;
  лицо = фигура с градиентом «glass» + блики/оправа/ядро.
  Градиенты glass/deep/rim/core/hole заданы в ЛОКАЛЬНОЙ системе координат
  (gradientUnits="userSpaceOnUse") — материал единый у всей фигуры.

ИСПОЛЬЗОВАНИЕ
  python3 scripts/generate-tab-icons.py [--svg-dir DIR]
    — rsvg-convert рендерит PNG в public/;
      при --svg-dir дополнительно сохраняет исходники SVG.

Требуется rsvg-convert (Linux dev-машина).
"""

from __future__ import annotations

import argparse
import os
import subprocess
import tempfile

SIZE = 1024
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # desktop-electron/
PUBLIC = os.path.join(ROOT, "public")

# ── Палитра (пипетка с tab-shop-3d.png) ─────────────────────────────────────
BG_CENTER = "#0d2436"
BG_MID = "#0e1e30"
BG_EDGE = "#08101a"
AURA = "#2fb4e8"
GLOW_CORE = "#8ff0ff"
GLASS_TOP = "#d8f7ff"
GLASS_MID = "#6cc6ee"
GLASS_LOW = "#2e6da8"
DEEP_TOP = "#2f6f9e"
DEEP_LOW = "#123c5e"
INK = "#123a5c"          # тёмно-синий контент на стекле (точки, «?», бегунок)
RIM_TOP = "#e9f7ff"
RIM_MID = "#9cc7e4"
RIM_LOW = "#48759b"

ROT = -12                # общий наклон «камеры»
DX, DY = 26, 38          # сдвиг экструзии (глубина)


def svg_header() -> str:
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{SIZE}" height="{SIZE}" viewBox="0 0 {SIZE} {SIZE}">'


def common_defs() -> str:
    return f"""
  <defs>
    <radialGradient id="bg" cx="50%" cy="34%" r="78%">
      <stop offset="0%" stop-color="{BG_CENTER}"/>
      <stop offset="55%" stop-color="{BG_MID}"/>
      <stop offset="100%" stop-color="{BG_EDGE}"/>
    </radialGradient>
    <radialGradient id="aura" gradientUnits="userSpaceOnUse" cx="512" cy="450" r="560">
      <stop offset="0%" stop-color="{AURA}" stop-opacity="0.42"/>
      <stop offset="55%" stop-color="{AURA}" stop-opacity="0.20"/>
      <stop offset="100%" stop-color="{AURA}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="aura2" gradientUnits="userSpaceOnUse" cx="512" cy="470" r="330">
      <stop offset="0%" stop-color="{GLOW_CORE}" stop-opacity="0.55"/>
      <stop offset="70%" stop-color="{GLOW_CORE}" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="{GLOW_CORE}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="glass" gradientUnits="userSpaceOnUse" x1="-280" y1="-300" x2="300" y2="330">
      <stop offset="0%" stop-color="{GLASS_TOP}"/>
      <stop offset="46%" stop-color="{GLASS_MID}"/>
      <stop offset="100%" stop-color="{GLASS_LOW}"/>
    </linearGradient>
    <linearGradient id="deep" gradientUnits="userSpaceOnUse" x1="-280" y1="-270" x2="280" y2="330">
      <stop offset="0%" stop-color="{DEEP_TOP}"/>
      <stop offset="100%" stop-color="{DEEP_LOW}"/>
    </linearGradient>
    <radialGradient id="core" gradientUnits="userSpaceOnUse" cx="-20" cy="-60" r="280">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.95"/>
      <stop offset="45%" stop-color="{GLOW_CORE}" stop-opacity="0.8"/>
      <stop offset="100%" stop-color="{GLOW_CORE}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="hole" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="210">
      <stop offset="0%" stop-color="#0b1a26"/>
      <stop offset="100%" stop-color="#07111a"/>
    </radialGradient>
    <linearGradient id="rim" gradientUnits="userSpaceOnUse" x1="-300" y1="-320" x2="340" y2="360">
      <stop offset="0%" stop-color="{RIM_TOP}"/>
      <stop offset="55%" stop-color="{RIM_MID}"/>
      <stop offset="100%" stop-color="{RIM_LOW}"/>
    </linearGradient>
    <filter id="soft" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="16"/>
    </filter>
  </defs>
"""


def base_canvas() -> str:
    return (
        f'<rect width="{SIZE}" height="{SIZE}" fill="url(#bg)"/>'
        '<ellipse cx="512" cy="512" rx="620" ry="580" fill="url(#aura)"/>'
        '<ellipse cx="512" cy="500" rx="360" ry="360" fill="url(#aura2)"/>'
    )


def tx(dx: int, dy: int, rot: int = ROT) -> str:
    return f'transform="translate({512 + dx} {512 + dy}) rotate({rot})"'


def front(dx: int = 0, dy: int = 0) -> str:
    return tx(dx, dy)


def back() -> str:
    return tx(-DX, DY)


def gloss(dx: int, dy: int, w: int, h: int, rx: int, opacity: float = 0.5) -> str:
    """Мягкий белый блик в верхней части фигуры (локальная СК)."""
    return (
        f'<g {front()} opacity="0.68">'
        f'<rect x="{dx}" y="{dy}" width="{w}" height="{h}" rx="{rx}"'
        f' fill="#ffffff" opacity="{opacity}" filter="url(#soft)"/></g>'
    )


# ── Настройки: шестерня (8 зубьев + кольцо + тёмный «зрачок») ───────────────

def gear_teeth() -> str:
    return "".join(
        f'<rect x="-86" y="-408" width="172" height="162" rx="34" transform="rotate({a})"/>'
        for a in (0, 45, 90, 135, 180, 225, 270, 315)
    )


def group_settings() -> str:
    return (
        f'<g {back()} fill="url(#deep)">{gear_teeth()}<circle r="292"/></g>'
        f'<g {front()} fill="url(#glass)">{gear_teeth()}<circle r="292"/></g>'
        # «зрачок»: тёмное стекло с подсветкой — то же стекло, глубже
        f'<g {front()}>'
        '<circle r="200" fill="url(#deep)"/>'
        '<circle r="150" fill="url(#core)" opacity="0.7"/></g>'
        f'<g {front()} fill="none">'
        '<circle r="200" stroke="url(#rim)" stroke-width="9"/>'
        '<circle r="168" stroke="url(#rim)" stroke-width="4" opacity="0.5"/></g>'
        # тонкая оправа внешнего контура кольца + блик сверху
        f'<g {front()} fill="none">'
        '<circle r="326" stroke="url(#rim)" stroke-width="7" opacity="0.75"/></g>'
        f'<g {front()} opacity="0.6">'
        '<path d="M -180 -264 A 320 320 0 0 1 216 -258" stroke="#ffffff" stroke-width="26"'
        ' stroke-linecap="round" fill="none" opacity="0.55"/></g>'
    )


# ── Чаты: пузырь с хвостом + 3 точки набора ─────────────────────────────────

BUBBLE_PATH = (
    "M -174 -266 h 348 a 96 96 0 0 1 96 96 v 274 a 96 96 0 0 1 -96 96 h -150"
    " c -28 58 -92 106 -176 132 c 58 -62 62 -98 58 -134 h -80"
    " a 96 96 0 0 1 -96 -96 v -272 a 96 96 0 0 1 96 -96 z"
)


def group_community() -> str:
    return (
        f'<g {back()} fill="url(#deep)"><path d="{BUBBLE_PATH}"/></g>'
        f'<g {front()} fill="url(#glass)"><path d="{BUBBLE_PATH}"/></g>'
        # ядро-свечение внутри пузыря (материал «стекло с подсветкой»)
        f'<g {front()}><ellipse cx="-10" cy="-80" rx="215" ry="150" fill="url(#core)" opacity="0.75"/></g>'
        # точки «печатают»
        f'<g {front()} fill="{INK}" opacity="0.95">'
        '<circle cx="-104" cy="-66" r="30"/><circle cx="0" cy="-66" r="30"/>'
        '<circle cx="104" cy="-66" r="30"/></g>'
        # контур-оправа
        f'<g {front()} fill="none">'
        f'<path d="{BUBBLE_PATH}" stroke="url(#rim)" stroke-width="8" opacity="0.85"/></g>'
        + gloss(-226, -230, 268, 50, 25)
    )


# ── FAQ: линза с «?» (без ручки — отличие от «Поиск») ────────────────────────

QMARK = (
    "M -104 -78 C -92 -148 -38 -192 24 -192 C 102 -192 150 -142 150 -80"
    " C 150 -26 120 -2 80 22 C 50 40 38 58 38 88 v 12"
)


def group_faq() -> str:
    return (
        f'<g transform="translate({512 - DX} {512 + DY})" fill="url(#deep)"><circle r="324"/></g>'
        f'<g transform="translate(512 512)">'
        '<circle r="324" fill="url(#glass)"/>'
        '<circle r="258" fill="url(#core)" opacity="0.8"/>'
        "</g>"
        # «?» двойным ходом: светлая тень-объём + плотный контент
        f'<g transform="translate(512 512) rotate(-10)">'
        f'<path d="{QMARK}" stroke="#bfe9ff" stroke-width="66" stroke-linecap="round" fill="none" opacity="0.55" transform="translate(10 14)"/>'
        f'<path d="{QMARK}" stroke="{INK}" stroke-width="56" stroke-linecap="round" fill="none"/>'
        f'<circle cx="40" cy="188" r="34" fill="{INK}"/></g>'
        # оправа линзы (stroke-only!) + блик по верху
        f'<g transform="translate(512 512)" fill="none">'
        '<circle r="324" stroke="url(#rim)" stroke-width="9" opacity="0.9"/></g>'
        '<g transform="translate(512 512)" opacity="0.55">'
        '<path d="M -244 -180 A 306 306 0 0 1 140 -262" stroke="#ffffff" stroke-width="26"'
        ' stroke-linecap="round" fill="none" filter="url(#soft)"/></g>'
    )


# ── Архиватор: zip-пакет (вертикальная молния + бегунок) ────────────────────

def group_archiver() -> str:
    return (
        f'<g {back()} fill="url(#deep)"><rect x="-256" y="-294" width="512" height="588" rx="122"/></g>'
        f'<g {front()} fill="url(#glass)"><rect x="-256" y="-294" width="512" height="588" rx="122"/></g>'
        # ядро-свечение в верхней половине пакета
        f'<g {front()}><ellipse cx="-30" cy="-140" rx="210" ry="130" fill="url(#core)" opacity="0.7"/></g>'
        # молния: светлая тень + тёмная линия (объём), от верха к бегунку
        f'<g {front()}>'
        '<path d="M 8 -256 V 88" stroke="#bfe9ff" stroke-width="26" stroke-dasharray="46 38"'
        ' stroke-linecap="round" opacity="0.5" transform="translate(10 12)"/>'
        f'<path d="M 8 -256 V 88" stroke="{INK}" stroke-width="22" stroke-dasharray="46 38" stroke-linecap="round"/></g>'
        # бегунок + тёмное отверстие + оправа
        f'<g {front()} fill="url(#deep)">'
        '<rect x="-70" y="84" width="136" height="164" rx="56"/>'
        '<circle cx="0" cy="152" r="22" fill="url(#hole)"/></g>'
        f'<g {front()} fill="none">'
        '<rect x="-70" y="84" width="136" height="164" rx="56" stroke="url(#rim)" stroke-width="8" opacity="0.8"/>'
        '<rect x="-256" y="-294" width="512" height="588" rx="122" stroke="url(#rim)" stroke-width="8" opacity="0.9"/></g>'
        + gloss(-186, -250, 252, 52, 26)
    )


# ── Владелец: ключ доступа (кольцо + стержень + два зуба) ───────────────────

KEY_HCX, KEY_HCY, KEY_HR = -150, -70, 185
KEY_HOLE = 78
KEY_SHAFT = 'x="-20" y="-128" width="350" height="116" rx="58"'
KEY_TOOTH_A = 'x="190" y="-12" width="76" height="150" rx="22"'
KEY_TOOTH_B = 'x="78" y="-12" width="64" height="118" rx="20"'


def key_body() -> str:
    """Силуэт ключа одним набором фигур: экструзия и лицо повторяют его 1-в-1."""
    return (
        f'<circle cx="{KEY_HCX}" cy="{KEY_HCY}" r="{KEY_HR}"/>'
        f'<rect {KEY_SHAFT}/>'
        f'<rect {KEY_TOOTH_A}/>'
        f'<rect {KEY_TOOTH_B}/>'
    )


def group_owner() -> str:
    return (
        f'<g {back()} fill="url(#deep)">{key_body()}</g>'
        f'<g {front()} fill="url(#glass)">{key_body()}</g>'
        # свечение на верхней части кольца (тот же приём, что у остальных иконок)
        f'<g {front()}>'
        f'<ellipse cx="{KEY_HCX - 30}" cy="{KEY_HCY - 92}" rx="100" ry="66" fill="url(#core)" opacity="0.6"/></g>'
        # тёмное отверстие кольца + оправы контура
        f'<g {front()}><circle cx="{KEY_HCX}" cy="{KEY_HCY}" r="{KEY_HOLE}" fill="url(#hole)"/></g>'
        f'<g {front()} fill="none">'
        f'<circle cx="{KEY_HCX}" cy="{KEY_HCY}" r="{KEY_HOLE}" stroke="url(#rim)" stroke-width="8" opacity="0.85"/>'
        f'<circle cx="{KEY_HCX}" cy="{KEY_HCY}" r="{KEY_HR}" stroke="url(#rim)" stroke-width="9" opacity="0.9"/>'
        f'<rect {KEY_SHAFT} stroke="url(#rim)" stroke-width="8" opacity="0.78"/>'
        '</g>'
        # блики стекла: стержень + искра на кольце
        f'<g {front()} opacity="0.5">'
        f'<circle cx="{KEY_HCX - 74}" cy="{KEY_HCY - 108}" r="24" fill="#ffffff" filter="url(#soft)"/></g>'
        + gloss(-6, -116, 262, 40, 20, 0.55)
    )


# ── Інструменти: чип (корпус + ніжки + темне ядро) ────────────────────────────

ICONS = {
    "tab-settings-3d": group_settings,
    "tab-community-3d": group_community,
    "tab-faq-3d": group_faq,
    "tab-archiver-3d": group_archiver,
    "tab-owner-3d": group_owner,
}


def main() -> int:
    parser = argparse.ArgumentParser(description="3D-иконки вкладок (запрос владельца 2026-10-31)")
    parser.add_argument("--svg-dir", default=None, help="сохранить исходники SVG в каталог")
    parser.add_argument(
        "--only",
        default=None,
        help="имена через запятую — перегенерировать только их (напр. tab-owner-3d), "
             "чтобы не трогать уже согласованные PNG",
    )
    args = parser.parse_args()

    names = list(ICONS)
    if args.only:
        names = [n.strip() for n in args.only.split(",") if n.strip()]
        unknown = [n for n in names if n not in ICONS]
        if unknown:
            parser.error(
                "неизвестные иконки: " + ", ".join(unknown) + "; известные: " + ", ".join(ICONS)
            )

    tmp = tempfile.mkdtemp(prefix="tab_icons_")
    for name in names:
        group = ICONS[name]
        markup = svg_header() + common_defs() + base_canvas() + group() + "</svg>"
        src = os.path.join(tmp, f"{name}.svg")
        with open(src, "w", encoding="utf-8") as fh:
            fh.write(markup)
        if args.svg_dir:
            os.makedirs(args.svg_dir, exist_ok=True)
            with open(os.path.join(args.svg_dir, f"{name}.svg"), "w", encoding="utf-8") as fh:
                fh.write(markup)
        out = os.path.join(PUBLIC, f"{name}.png")
        subprocess.run(["rsvg-convert", "-w", str(SIZE), "-h", str(SIZE), "-o", out, src], check=True)
        print(f"OK {out} ({os.path.getsize(out)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
