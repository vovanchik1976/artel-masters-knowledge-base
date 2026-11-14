#!/usr/bin/env python3
"""check-pe-exports.py — гейт экспортной таблицы PE-файла (DLL).

Зачем: `strip --strip-unneeded` сжимает runtime-DLL TDLib в разы (libtdjson
88 → 37 МБ, libstdc++ 26 → 2 МБ), но обязан сохранить экспорт-таблицу. Проверить
это надо машинно, иначе `engine-core.exe` на Windows упадёт на загрузке DLL.

Почему не objdump/nm: `x86_64-w64-mingw32-objdump -p` (binutils 2.42) НЕ печатает
таблицу имён экспорта, а `nm -D` не показывает экспорты этой DLL — оба дают ложное
«символов нет» (проверено 2026-09-12 на оригинале и на stripped-копии одной и той
же DLL: у обоих 14 экспортов, все 4 нужных). Поэтому — свой парсер PE.

Использование:
    python3 scripts/check-pe-exports.py <file.dll> <sym> [<sym> ...]

Код возврата: 0 — все символы экспортируются; 1 — что-то потеряно/не PE.
"""
import struct
import sys


def read_exports(path: str):
    with open(path, "rb") as fh:
        data = fh.read()
    if data[:2] != b"MZ":
        raise ValueError("не MZ/PE (LFS-указатель?)")
    pe = data.index(b"PE\0\0")
    coff = pe + 4
    (nsec,) = struct.unpack_from("<H", data, coff + 2)
    (opt_size,) = struct.unpack_from("<H", data, coff + 16)
    opt = coff + 20
    (magic,) = struct.unpack_from("<H", data, opt)
    dd_off = opt + (112 if magic == 0x20B else 96)
    rva_exp, _size_exp = struct.unpack_from("<II", data, dd_off)

    sections = []
    sec_off = opt + opt_size
    for i in range(nsec):
        base = sec_off + i * 40
        va, vsize, raw, rawsize = struct.unpack_from("<IIII", data, base + 12)
        sections.append((va, vsize, raw, rawsize))

    def rva2off(rva: int) -> int:
        for va, vsize, raw, rawsize in sections:
            if va <= rva < va + max(vsize, rawsize):
                return raw + (rva - va)
        raise ValueError(f"RVA {rva:#x} вне секций")

    if not rva_exp:
        return []
    exp = rva2off(rva_exp)
    (nnames,) = struct.unpack_from("<I", data, exp + 24)
    (names_rva,) = struct.unpack_from("<I", data, exp + 32)
    names_off = rva2off(names_rva)
    names = []
    for i in range(nnames):
        (name_rva,) = struct.unpack_from("<I", data, names_off + i * 4)
        off = rva2off(name_rva)
        end = data.index(b"\0", off)
        names.append(data[off:end].decode("ascii", "replace"))
    return names


def main(argv) -> int:
    if len(argv) < 3:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        print("usage: python3 scripts/check-pe-exports.py <file.dll> <sym> [<sym> ...]", file=sys.stderr)
        return 2
    path, wanted = argv[1], argv[2:]
    try:
        names = read_exports(path)
    except Exception as exc:  # noqa: BLE001 — гейт печатает причину и падает
        print(f"❌ {path}: не удалось разобрать PE-экспорты: {exc}")
        return 1
    missing = [w for w in wanted if w not in names]
    if missing:
        print(f"❌ {path}: потеряны экспорты ({len(names)} всего): {' '.join(missing)}")
        return 1
    print(f"✅ {path}: {len(names)} экспортов, все нужные на месте ({', '.join(wanted)})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
