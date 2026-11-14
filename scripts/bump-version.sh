#!/bin/bash
# ============================================================
# bump-version.sh — поднять версию Electron-клиента в package.json (+lock)
# ============================================================
# Версия-источник правды — desktop-electron/package.json. Электрон-builder берёт
# её в ИМЯ артефакта, поэтому bump обязан случиться ДО упаковки; иначе релизный
# гейт стадии 6 падает («Имя артефакта без версии X») — BUG-RELEASE-BUMP-001.
#
# Скрипт делает ровно одну вещь: правит JSON (никаких сборок/коммитов/тегов).
# Это позволяет покрыть его юнит-тестом (tests_pm/test_bump_version.py).
#
# Использование:
#   bash scripts/bump-version.sh 0.1.1            # каталог = родитель скрипта
#   bash scripts/bump-version.sh 0.1.1 <каталог>  # явный каталог (для тестов)
# ============================================================

set -euo pipefail

V="${1:-}"
DIR="${2:-$(cd "$(dirname "$0")/.." && pwd)}"

if [ -z "$V" ]; then
    echo "❌ usage: bump-version.sh X.Y.Z [каталог]" >&2
    exit 2
fi
case "$V" in
    [0-9]*.[0-9]*.[0-9]*) : ;;
    *) echo "❌ версия не semver: $V" >&2; exit 2 ;;
esac
[ -f "$DIR/package.json" ] || { echo "❌ нет $DIR/package.json" >&2; exit 2; }

node - "$DIR" "$V" <<'JS'
const fs = require("fs");
const path = require("path");
const dir = process.argv[2];
const ver = process.argv[3];
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
// 2 пробела + финальный \n — как в исходных package.json/package-lock.json
const writeJson = (f, obj) => fs.writeFileSync(f, JSON.stringify(obj, null, 2) + "\n");

const pkgPath = path.join(dir, "package.json");
const pkg = readJson(pkgPath);
const old = pkg.version;
pkg.version = ver;
writeJson(pkgPath, pkg);

const lockPath = path.join(dir, "package-lock.json");
let lockNote = "";
if (fs.existsSync(lockPath)) {
    const lock = readJson(lockPath);
    lock.version = ver;
    if (lock.packages && lock.packages[""]) lock.packages[""].version = ver;
    writeJson(lockPath, lock);
    lockNote = " + package-lock.json";
}
console.log(`✅ version: ${old} → ${ver} (${path.basename(dir)}${lockNote})`);
JS
