#!/bin/bash
# ============================================================
# build-win-bundle.sh — staging-каталог для electron-builder
# ============================================================
# Собирает Rust-sidecar engine-core под Windows (кросс-компиляция MinGW) и
# укладывает его ВМЕСТЕ с runtime-DLL TDLib в `win-bundle-<arch>/`.
#
# Зачем отдельный каталог: Windows ищет DLL рядом с .exe, поэтому
# engine-core.exe + libtdjson.dll + его зависимости должны лежать в ОДНОЙ папке.
# electron-builder копирует `win-bundle-<arch>/` → `<install>/resources/engine-core/`
# (см. package.json → build.extraResources), main.ts ищет бинарь там
# (process.resourcesPath/engine-core/engine-core.exe).
#
# Использование:
#   bash scripts/build-win-bundle.sh ia32   → i686-pc-windows-gnu
#   bash scripts/build-win-bundle.sh x64    → x86_64-pc-windows-gnu
#
# Требования (Linux-хост/CI):
#   rustup target add i686-pc-windows-gnu x86_64-pc-windows-gnu
#   apt-get install -y gcc-mingw-w64 binutils-mingw-w64
# DLL-бандлы tdlib берутся из Git LFS (engine-core/tdlib/windows-x86|windows-x64).
# Импорт-лист `libtdjson.dll.a` в LFS НЕ лежит (10 КБ, обычный файл git): он нужен
# на линковке, поэтому лёгкий CI (.github/workflows/ci-electron.yml) собирает
# таргет БЕЗ выкачки LFS — при отсутствии каталога DLL build.rs не линкует TDLib.
#
# Гейты (падаем, а не «уезжаем в релиз») — scripts/check-win7-imports.sh:
#   1. LFS-указатели вместо реальных DLL/импорт-листа;
#   2. разрядность exe (PE32 / PE32+) — ловим промах toolchain;
#   3. импорты Win8+/Win10-only у exe и у ВСЕХ runtime-DLL бандла;
#   4. экспорт `td_json_client_*` из libtdjson.dll (без strip DLL — как в e2e).
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENGINE_DIR="$DESKTOP_DIR/engine-core"

ARCH="${1:-}"
case "$ARCH" in
    ia32|x86|i686) ARCH="ia32";   TARGET="i686-pc-windows-gnu";   TDLIB_ARCH="windows-x86" ;;
    x64|x86_64)    ARCH="x64";    TARGET="x86_64-pc-windows-gnu"; TDLIB_ARCH="windows-x64" ;;
    *)
        echo "usage: bash scripts/build-win-bundle.sh <ia32|x64>" >&2
        exit 2
        ;;
esac

# Каталог АРХ-СПЕЦИФИЧНЫЙ: `win-bundle-<arch>`. Так electron-builder берёт
# sidecar нужной разрядности через макрос ${arch} (см. package.json →
# build.extraResources.from = "win-bundle-${arch}"). Общий каталог на обе арки
# приводил к подмене: ia32-пакет уезжал с x64-DLL, если обе арки собирались
# одной командой (`electron-builder --win --ia32 --x64`).
BUNDLE_DIR="$DESKTOP_DIR/win-bundle-$ARCH"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  build-win-bundle.sh — engine-core для Windows ($ARCH)"
echo "║  target: $TARGET"
echo "║  tdlib:  engine-core/tdlib/$TDLIB_ARCH"
echo "║  bundle: $BUNDLE_DIR"
echo "╚══════════════════════════════════════════════════════════════╝"

command -v cargo >/dev/null 2>&1 || { echo "❌ cargo не найден (rustup)"; exit 1; }
# ВАЖНО: target-list читаем ИЗ engine-core — только там действует
# rust-toolchain.toml (пин 1.77.2). Из другого каталога rustup смотрит на
# дефолтный тулчейн раннера и «не находит» кросс-таргет, который на самом деле
# установлен для пиннутого (ложное падение CI).
INSTALLED_TARGETS="$(cd "$ENGINE_DIR" && rustup target list --installed)"
echo "$INSTALLED_TARGETS" | grep -qx "$TARGET" \
    || { echo "❌ cargo-target не установлен для пиннутого тулчейна: $TARGET"
         echo "   Установите: (cd desktop-electron/engine-core && rustup target add $TARGET)"; exit 1; }

# ── Гейт LFS: указатели вместо реальных DLL ломают линковку молча ──────────
TDLIB_DIR="$ENGINE_DIR/tdlib/$TDLIB_ARCH"
[ -d "$TDLIB_DIR" ] || { echo "❌ Нет TDLib-бандла: $TDLIB_DIR"; exit 1; }

LIB="$TDLIB_DIR/libtdjson.dll.a"
if [ ! -f "$LIB" ]; then
    echo "❌ Нет импорт-листа $LIB (git lfs pull --include='desktop-electron/engine-core/tdlib/$TDLIB_ARCH/*')"
    exit 1
fi
if head -c 40 "$LIB" | grep -q "git-lfs"; then
    echo "❌ $LIB — LFS-указатель, а не файл. Выполните: git lfs pull --include='desktop-electron/engine-core/tdlib/$TDLIB_ARCH/*'"
    exit 1
fi
if ! ls "$TDLIB_DIR"/libtdjson.dll >/dev/null 2>&1; then
    echo "❌ Нет libtdjson.dll в $TDLIB_DIR (LFS не выкачан)"
    exit 1
fi
if head -c 40 "$TDLIB_DIR/libtdjson.dll" | grep -q "git-lfs"; then
    echo "❌ libtdjson.dll — LFS-указатель. Выполните: git lfs pull --include='desktop-electron/engine-core/tdlib/$TDLIB_ARCH/*'"
    exit 1
fi

# ── Сборка sidecar под Windows ─────────────────────────────────────────────
echo ""
echo "═══ cargo build --release --target $TARGET --locked ═══"
# --locked: сборка строго по зафиксированному Cargo.lock (версии подобраны
# совместимыми с rustc 1.77.2). Тихая подмена версий в релизе недопустима.
(cd "$ENGINE_DIR" && cargo build --release --locked --target "$TARGET")
echo "→ $(cd "$ENGINE_DIR" && cargo --version) / $(cd "$ENGINE_DIR" && rustc --version)"

BIN="$ENGINE_DIR/target/$TARGET/release/engine-core.exe"
[ -f "$BIN" ] || { echo "❌ Не собран: $BIN"; exit 1; }

# arch-check: убеждаемся, что бинарь именно той разрядности (ловим промах toolchain)
FILE_INFO="$(file -b "$BIN" 2>/dev/null || echo unknown)"
echo "→ $FILE_INFO"
case "$ARCH" in
    ia32) echo "$FILE_INFO" | grep -q "PE32 executable" || { echo "❌ Ожидался PE32 (32-bit), получено: $FILE_INFO"; exit 1; } ;;
    x64)  echo "$FILE_INFO" | grep -q "PE32+ executable" || { echo "❌ Ожидался PE32+ (64-bit), получено: $FILE_INFO"; exit 1; } ;;
esac

STRIP_BIN=""
case "$TARGET" in
    i686-pc-windows-gnu)   STRIP_BIN="i686-w64-mingw32-strip" ;;
    x86_64-pc-windows-gnu) STRIP_BIN="x86_64-w64-mingw32-strip" ;;
esac

# strip exe ДО гейта: проверяем ровно те байты, что уедут в релиз
if command -v "$STRIP_BIN" >/dev/null 2>&1; then
    size_before="$(du -h "$BIN" | cut -f1)"
    "$STRIP_BIN" "$BIN"
    echo "→ strip exe: $size_before → $(du -h "$BIN" | cut -f1) ($STRIP_BIN)"
else
    echo "⚠️  $STRIP_BIN не найден — exe без strip (нужен binutils-mingw-w64)"
fi

# ── Гейт совместимости с Windows 7/8 (контракт порта) ──────────────────────
# Rust ≥1.78 поднял baseline до Windows 10: std статически импортирует
# bcryptprimitives.dll (ProcessPrng, Win10+) и api-ms-win-core-synch-l1-2-0.dll
# (WaitOnAddress, Win8+). Такой .exe НЕ СТАРТУЕТ на Win7 — а это целевая ОС
# порта. Тулчейн пиннится (engine-core/rust-toolchain.toml), импорты
# проверяются машинно: молчаливый «апгрейд» не должен уехать в релиз.
bash "$SCRIPT_DIR/check-win7-imports.sh" "$ARCH" "$BIN"

# ── Staging: exe + runtime-DLL в одну папку ───────────────────────────────
echo ""
echo "═══ Staging → $BUNDLE_DIR ═══"
rm -rf "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR"

cp "$BIN" "$BUNDLE_DIR/engine-core.exe"
# Все runtime-DLL, КРОМЕ импорт-листа (.dll.a) — он нужен только на линковке.
for dll in "$TDLIB_DIR"/*.dll; do
    cp "$dll" "$BUNDLE_DIR/"
done

# ── strip runtime-DLL ОТКЛЮЧЁН (решение владельца 2026-09-22: релиз = DEV) ──
# e2e-prod32.sh копирует DLL как есть (без strip) — и там всё работает.
# Релиз обязан содержать ТЕ ЖЕ байты: побайтовый паритет бандла с e2e важнее
# ~60 МБ экономии. strip exe выше остаётся (он и в e2e такой же).
# Исторично: strip --strip-unneeded резал libstdc++-6 26МБ->2МБ, libtdjson
# 68МБ->35МБ; под wine stripped-набор стартовал, но wine != Win10-loader.
# Поэтому: НИКАКОГО strip DLL — ни здесь, ни где-либо в релизном конвейере.

# ── Гейт экспортов: FFI-точки входа TDLib обязаны быть на месте ───────────
# ВАЖНО: проверяем собственным PE-парсером, а НЕ objdump/nm — оба не показывают
# таблицу имён экспорта этой DLL (ложное «символов нет» даже у оригинала).
python3 "$SCRIPT_DIR/check-pe-exports.py" "$BUNDLE_DIR/libtdjson.dll" \
    td_json_client_create td_json_client_send td_json_client_receive td_json_client_destroy

# ── Тот же гейт Win7/8 по всем runtime-DLL бандла ─────────────────────────
# Проверяем не только наш бинарь: если TDLib-DLL тянет библиотеку, которой нет
# в Win7 SP1, процесс не стартует ВООБЩЕ (loader падает до main).
bash "$SCRIPT_DIR/check-win7-imports.sh" "$ARCH" "$BUNDLE_DIR"/*.dll

echo ""
echo "── Содержимое win-bundle-$ARCH/ ──"
ls -lh "$BUNDLE_DIR"
echo ""
echo "✅ Готово: engine-core.exe + $(ls "$BUNDLE_DIR"/*.dll | wc -l) DLL ($(du -sh "$BUNDLE_DIR" | cut -f1)) → $BUNDLE_DIR"
echo "   Далее: bash scripts/release-electron.sh (инсталляторы + релиз) или"
echo "          npx electron-builder --win nsis --$ARCH"
