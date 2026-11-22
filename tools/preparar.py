#!/usr/bin/env python3
"""Convierte los PDF escaneados en una carpeta lista para subir a MEGA.

Uso: python3 tools/preparar.py <carpeta_pdfs> <carpeta_salida> [--jobs N]

Genera en <carpeta_salida>:
  index.json             lista de libros y páginas
  <libro>/p001.jpg ...   cada página lista para imprimir (fondo blanqueado)
  <libro>/thumbs.jpg     sprite con las miniaturas del libro
Los libros ya procesados se saltan (se puede relanzar sin perder trabajo).
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

from PIL import Image

LONG_SIDE = 2200          # px del lado largo (~190 ppp en A4)
QUALITY = 82
THUMB_W, THUMB_H = 160, 226
SPRITE_COLS = 10
WHITE, BLACK = 222, 18    # niveles para blanquear el papel del escaneo


def slugify(name: str) -> str:
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    s = re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-").lower()
    return s or "libro"


def title_of(path: Path) -> str:
    return re.sub(r"\s+", " ", path.stem.replace("_", " ")).strip()


LUT = [max(0, min(255, round((v - BLACK) * 255 / (WHITE - BLACK)))) for v in range(256)] * 3


def color_ratio(img: Image.Image) -> float:
    small = img.convert("RGB").resize((80, 113))
    px = list(small.getdata())
    colorful = sum(1 for r, g, b in px if max(r, g, b) - min(r, g, b) > 51)
    return round(colorful / len(px), 3)


CHUNK = 8


def page_count(pdf: Path) -> int:
    out = subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True, check=True).stdout
    return int(re.search(r"^Pages:\s+(\d+)", out, re.M).group(1))


def process_chunk(pdf: Path, dest: Path, first: int, last: int, tmproot: Path) -> list:
    """Renderiza las páginas first..last y devuelve [(n, w, h, color, miniatura)]."""
    dest.mkdir(parents=True, exist_ok=True)
    res = []
    with tempfile.TemporaryDirectory(dir=tmproot) as tmp:
        subprocess.run(
            ["pdftoppm", "-f", str(first), "-l", str(last), "-scale-to", str(LONG_SIDE), "-png", str(pdf), f"{tmp}/p"],
            check=True, stderr=subprocess.DEVNULL,
        )
        for raw in sorted(Path(tmp).glob("p-*.png")):
            n = int(raw.stem.split("-")[1])
            img = Image.open(raw).convert("RGB")
            ratio = color_ratio(img)
            img = img.point(LUT)
            img.save(dest / f"p{n:03d}.jpg", "JPEG", quality=QUALITY, optimize=True, progressive=True)
            th = img.copy()
            th.thumbnail((THUMB_W, THUMB_H), Image.LANCZOS)
            res.append((n, img.width, img.height, ratio, th))
            raw.unlink()
    return res


def finish_book(pdf: Path, dest: Path, results: list) -> dict:
    results.sort(key=lambda r: r[0])
    thumbs = [r[4] for r in results]
    rows = (len(thumbs) + SPRITE_COLS - 1) // SPRITE_COLS
    sprite = Image.new("RGB", (SPRITE_COLS * THUMB_W, rows * THUMB_H), "white")
    for i, th in enumerate(thumbs):
        x = (i % SPRITE_COLS) * THUMB_W + (THUMB_W - th.width) // 2
        y = (i // SPRITE_COLS) * THUMB_H + (THUMB_H - th.height) // 2
        sprite.paste(th, (x, y))
    sprite.save(dest / "thumbs.jpg", "JPEG", quality=72, optimize=True)
    meta = {
        "id": dest.name,
        "title": title_of(pdf),
        "file": pdf.name,
        "pages": [{"w": w, "h": h, "c": c} for _, w, h, c, _ in results],
    }
    (dest / "meta.json").write_text(json.dumps(meta, ensure_ascii=False))
    return meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--jobs", type=int, default=6)
    a = ap.parse_args()
    src, out = Path(a.src), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    pdfs = sorted(src.rglob("*.pdf"))
    tmproot = out / ".tmp"
    tmproot.mkdir(exist_ok=True)
    books, pending = [], {}
    with ProcessPoolExecutor(a.jobs) as ex:
        futs = {}
        for pdf in pdfs:
            dest = out / slugify(pdf.stem)
            if (dest / "meta.json").exists():
                books.append(json.loads((dest / "meta.json").read_text()))
                continue
            n = page_count(pdf)
            chunks = [(f, min(f + CHUNK - 1, n)) for f in range(1, n + 1, CHUNK)]
            pending[pdf] = {"left": len(chunks), "res": [], "dest": dest}
            for f, l in chunks:
                futs[ex.submit(process_chunk, pdf, dest, f, l, tmproot)] = pdf
        for fut in as_completed(futs):
            pdf = futs[fut]
            st = pending[pdf]
            try:
                st["res"].extend(fut.result())
            except Exception as e:  # noqa: BLE001
                st["error"] = e
            st["left"] -= 1
            if st["left"] == 0:
                if "error" in st:
                    print(f"FAIL {pdf.name}: {st['error']}", file=sys.stderr, flush=True)
                    continue
                books.append(finish_book(pdf, st["dest"], st["res"]))
                st["res"] = []
                print(f"ok   {pdf.name} ({len(books[-1]['pages'])} págs)", flush=True)
    shutil.rmtree(tmproot, ignore_errors=True)
    books.sort(key=lambda b: b["title"].lower())
    index = {
        "version": 1,
        "thumb": {"w": THUMB_W, "h": THUMB_H, "cols": SPRITE_COLS},
        "books": books,
    }
    (out / "index.json").write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")))
    total = sum(len(b["pages"]) for b in books)
    size = sum(f.stat().st_size for f in out.rglob("*") if f.is_file())
    print(f"\n{len(books)} libros, {total} páginas, {size / 1e6:.0f} MB en {out}")


if __name__ == "__main__":
    shutil.which("pdftoppm") or sys.exit("Falta pdftoppm (poppler)")
    main()
