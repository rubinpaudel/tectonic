#!/usr/bin/env python3
"""Validate every generated PDF with independent parsers and optional Poppler."""
import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

import pdfplumber
from pypdf import PdfReader


def normalise(text):
    return " ".join(text.split())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2] / "mock-data/nike")
    parser.add_argument("--node", default=shutil.which("node"))
    parser.add_argument("--pdftotext", default=shutil.which("pdftotext"))
    args = parser.parse_args()
    if not args.node:
        parser.error("Node 22 is required to read the deterministic fixture definitions")
    generator = Path(__file__).with_name("generate.mjs")
    # Import the definitions only: the generator's CLI guard prevents writes.
    program = """
      const { pathToFileURL } = await import('node:url');
      const g = await import(pathToFileURL(process.argv[1]));
      const text = lines => lines.map(line => typeof line === 'string' ? line : line.text).filter(Boolean);
      const pdfs = g.employees().map(employee => ({ path: employee.dossierPath, lines: text(g.dossierLines(employee)) }));
      pdfs.push({ path: g.POLICY_PATH, lines: text(g.POLICY_LINES) });
      console.log(JSON.stringify(pdfs));
    """
    definitions = json.loads(subprocess.run(
        [args.node, "--input-type=module", "-e", program, str(generator)],
        check=True, capture_output=True, text=True,
    ).stdout)
    assert len(definitions) == 51
    for definition in definitions:
        path = args.root / definition["path"]
        reader = PdfReader(path, strict=True)
        assert len(reader.pages) == 1, path
        pypdf_text = normalise(reader.pages[0].extract_text())
        with pdfplumber.open(path) as pdf:
            page = pdf.pages[0]
            plumber_text = normalise(page.extract_text())
            assert len(page.chars) > 300, path
            # Check every painted glyph to catch clipping that text extraction misses.
            assert all(46 <= char["x0"] < char["x1"] <= page.width - 46 for char in page.chars), path
            assert all(0 <= char["top"] < char["bottom"] <= page.height for char in page.chars), path
        extracted = {"pypdf": pypdf_text, "pdfplumber": plumber_text}
        if args.pdftotext:
            with tempfile.TemporaryDirectory(prefix="tunnelvision-pdf-text-") as directory:
                destination = Path(directory) / "extracted.txt"
                subprocess.run([args.pdftotext, "-layout", str(path), str(destination)], check=True, capture_output=True)
                extracted["Poppler"] = normalise(destination.read_text())
        for engine, output in extracted.items():
            for expected in definition["lines"]:
                assert normalise(expected) in output, f"{engine}: missing row in {path}: {expected}"
            assert "Fictional people, amounts and addresses" in output, path
            assert re.search(r"1\s*/\s*1", output), f"{engine}: missing page footer in {path}"
    engines = "pypdf, pdfplumber" + (", Poppler" if args.pdftotext else "")
    print(f"Validated all {len(definitions)} PDFs with {engines}; expected rows, page count and glyph bounds passed.")


if __name__ == "__main__":
    main()
