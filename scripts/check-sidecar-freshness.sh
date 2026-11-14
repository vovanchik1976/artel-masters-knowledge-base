#!/usr/bin/env bash
# Проверка СВЕЖЕСТИ sidecar-бинаря относительно исходников Rust
# (BUG-DEV-STALE-SIDECAR-001, 2026-09-27).
#
# Зачем: dev-запуск `npx electron .` резолвит sidecar из `target/debug`
# (см. `logs/main-sidecar.log`: «sidecar resolve → .../target/debug/engine-core»),
# а `e2e-prod.sh` / `smoke-release.sh` собирают и стейджат `target/release`.
# Если бинарь старше исходников, живая проверка Rust-правки молча тестирует
# СТАРЫЙ код: «фикс не работает» или наоборот «всё чисто» — оба вывода ложные.
# Так и случилось 2026-09-27: свежий `*.part` в temp пережил стартовый дворник,
# потому что debug-бинарь был собран за 3 дня до правки `cleanup_stale_archives`.
#
# Использование:
#   bash scripts/check-sidecar-freshness.sh            # проверить оба бинаря
#   bash scripts/check-sidecar-freshness.sh --debug    # только target/debug (dev-стенд)
#   bash scripts/check-sidecar-freshness.sh --release  # только target/release (e2e/релиз)
#
# Код возврата: 0 — все проверяемые бинари свежее исходников;
#               1 — бинарь устарел или отсутствует (пересобрать cargo).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="both"
case "${1:-}" in
  --debug) MODE="debug" ;;
  --release) MODE="release" ;;
  ""|--both) MODE="both" ;;
  *) echo "check-sidecar-freshness: неизвестный аргумент '$1' (ожидается --debug|--release)" >&2; exit 2 ;;
esac

# Самый свежий исходник Rust (engine-core + firmware-core) и манифесты.
newest_src() {
  find "$ROOT/engine-core/src" "$ROOT/firmware-core/src" \
       "$ROOT/engine-core/Cargo.toml" "$ROOT/firmware-core/Cargo.toml" \
       -type f -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -1
}

SRC_LINE="$(newest_src)"
if [ -z "$SRC_LINE" ]; then
  echo "check-sidecar-freshness: не найдены исходники Rust в $ROOT — проверка невозможна" >&2
  exit 2
fi
SRC_EPOCH="${SRC_LINE%% *}"
SRC_PATH="${SRC_LINE#* }"
# `find -printf %T@` отдаёт дробную эпоху (`1790538745.2232395900`) — для
# целочисленного сравнения с `stat -c %Y` отбрасываем дробную часть.
SRC_EPOCH="${SRC_EPOCH%%.*}"

rc=0
check_one() {
  local profile="$1" bin="$2" build_cmd="$3"
  if [ ! -f "$bin" ]; then
    echo "[sidecar-freshness] ❌ $profile: БИНАРЯ НЕТ ($bin) — собери: $build_cmd"
    return 1
  fi
  local bin_epoch
  bin_epoch="$(stat -c '%Y' "$bin")"
  local bin_h src_h
  bin_h="$(date -d "@$bin_epoch" '+%F %H:%M')"
  src_h="$(date -d "@$SRC_EPOCH" '+%F %H:%M')"
  if [ "$bin_epoch" -lt "$SRC_EPOCH" ]; then
    local lag_min=$(( (SRC_EPOCH - bin_epoch) / 60 ))
    echo "[sidecar-freshness] ❌ $profile: УСТАРЕЛ — бинарь $bin_h, а исходник $src_h ($(basename "$SRC_PATH"), отставание ${lag_min} мин)"
    echo "[sidecar-freshness]    живая проверка Rust-правки тестировала бы СТАРЫЙ код. Пересобери: $build_cmd"
    return 1
  fi
  echo "[sidecar-freshness] ✅ $profile: свежо (бинарь $bin_h ≥ исходник $src_h)"
  return 0
}

if [ "$MODE" = "debug" ] || [ "$MODE" = "both" ]; then
  check_one "debug (dev-стенд, npx electron .)" \
    "$ROOT/engine-core/target/debug/engine-core" \
    "cd $ROOT/engine-core && cargo build" || rc=1
fi
if [ "$MODE" = "release" ] || [ "$MODE" = "both" ]; then
  check_one "release (e2e-prod*, релиз)" \
    "$ROOT/engine-core/target/release/engine-core" \
    "cd $ROOT/engine-core && cargo build --release" || rc=1
fi

if [ "$rc" -eq 0 ]; then
  echo "[sidecar-freshness] sidecar соответствует исходникам — можно запускать живой стенд"
else
  echo "[sidecar-freshness] СТОП: сначала пересборка, иначе результаты живой проверки недостоверны"
fi
exit "$rc"
