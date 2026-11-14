#!/bin/bash
# ============================================================
# check-win7-imports.sh — машинный гейт Win7/8-совместимости импортов
# ============================================================
# Rust ≥1.78 поднял baseline до Windows 10: std статически импортирует
#   • bcryptprimitives.dll → ProcessPrng      (Win10+)
#   • api-ms-win-core-synch-l1-2-0.dll → WaitOnAddress (Win8+)
# Такой PE НЕ СТАРТУЕТ на Win7 (частично и на Win8) — а это целевые ОС порта.
# Поэтому тулчейн пиннится (engine-core/rust-toolchain.toml = 1.77.2) и импорты
# проверяются машинно: тихий «апгрейд» тулчейна не должен уехать в релиз.
#
# Вызывается из:
#   • scripts/build-win-bundle.sh — по собранному exe и всем runtime-DLL бандла;
#   • .github/workflows/ci-electron.yml — по exe кросс-сборки (LFS не нужен).
#
# Использование:
#   bash scripts/check-win7-imports.sh ia32  path/to/engine-core.exe [файл...]
#   bash scripts/check-win7-imports.sh x64   win-bundle-x64/*.dll
#
# ARCH: ia32 | x86 | i686 | i686-pc-windows-gnu
#       x64  | x86_64 | x86_64-pc-windows-gnu
#
# Обход (только для экспериментов): ALLOW_WIN10_BASELINE=1
# ============================================================

set -euo pipefail

ARCH="${1:-}"
shift || true

case "$ARCH" in
    ia32|x86|i686|i686-pc-windows-gnu)      OBJDUMP="i686-w64-mingw32-objdump" ;;
    x64|x86_64|x86_64-pc-windows-gnu)       OBJDUMP="x86_64-w64-mingw32-objdump" ;;
    *)
        echo "usage: bash scripts/check-win7-imports.sh <ia32|x64> <файл...>" >&2
        exit 2
        ;;
esac

if [ "$#" -eq 0 ]; then
    echo "usage: bash scripts/check-win7-imports.sh <ia32|x64> <файл...>" >&2
    exit 2
fi

# Win8+/Win10-only библиотеки (в Win7 SP1 их нет)
DENY='bcryptprimitives\.dll|api-ms-win-core-synch-l1-2|api-ms-win-core-synch-l2|api-ms-win-core-processthreads-l1-1-[23]|api-ms-win-core-winrt|api-ms-win-core-file-l2|api-ms-win-core-heap-l2|api-ms-win-core-util-l1-1-1|ucrtbase\.dll|vcruntime140'

if ! command -v "$OBJDUMP" >/dev/null 2>&1; then
    echo "⚠️  $OBJDUMP не найден — проверка Win7-совместимости ПРОПУЩЕНА"
    echo "   (нужен binutils-mingw-w64: apt-get install binutils-mingw-w64)"
    exit 0
fi

BAD_ALL=""
CHECKED=0
for f in "$@"; do
    if [ ! -f "$f" ]; then
        echo "❌ Файл не найден: $f"
        exit 1
    fi
    if head -c 40 "$f" | grep -q "git-lfs"; then
        echo "❌ $f — LFS-указатель, а не бинарь (нужен git lfs pull)"
        exit 1
    fi
    IMPORTS="$("$OBJDUMP" -p "$f" 2>/dev/null | grep 'DLL Name' | sed 's/.*DLL Name: //' | tr -d '\r' | sort -u)"
    if [ -z "$IMPORTS" ]; then
        echo "⚠️  $f: не удалось прочитать импорты (не PE-файл?)"
        exit 1
    fi
    CHECKED=$((CHECKED + 1))
    HIT="$(echo "$IMPORTS" | grep -Ei "$DENY" || true)"
    if [ -n "$HIT" ]; then
        BAD_ALL="$BAD_ALL
  - $(basename "$f"): $(echo "$HIT" | tr '\n' ' ')"
    fi
done

if [ -n "$BAD_ALL" ]; then
    if [ "${ALLOW_WIN10_BASELINE:-0}" = "1" ]; then
        echo "⚠️  ALLOW_WIN10_BASELINE=1: пропускаю проверку Win7-совместимости."
        echo "⚠️  Импорты Win8+/Win10-only:$BAD_ALL"
        exit 0
    fi
    echo "❌ Файл(ы) НЕ запустятся на Windows 7/8. Импорты Win8+/Win10-only:$BAD_ALL"
    echo "   Причина: тулчейн новее 1.77.2 (Rust ≥1.78 = baseline Win10)."
    echo "   Проверьте engine-core/rust-toolchain.toml и \`rustc --version\` из engine-core."
    exit 1
fi

echo "✅ Win7/8-совместимость: ни одного Win8+/Win10-only импорта (проверено $CHECKED файл(ов), $OBJDUMP)"
