#!/usr/bin/env python3
# Extract the EPSO language-comprehension sample test from the EU's PDF
# into structured JSON that build-epso-samples.mjs consumes.
#
# Input:  sources/epso/language-comprehension-en.pdf
# Output: sources/epso/language-comprehension-en.json
#
# Requires pypdf:  python3 -m pip install pypdf  (or use a venv)

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "sources" / "epso" / "language-comprehension-en.pdf"
OUT = ROOT / "sources" / "epso" / "language-comprehension-en.json"

try:
    import pypdf
except ImportError:
    sys.exit("pypdf not installed — run `python3 -m pip install pypdf`")


def main() -> None:
    reader = pypdf.PdfReader(str(SRC))
    full = "\n".join(p.extract_text() for p in reader.pages)

    # Split on "ANSWER KEY" (case-insensitive, loose whitespace).
    parts = re.split(r"ANSWER\s*KEY", full, maxsplit=1, flags=re.I)
    body, key = parts[0], parts[1] if len(parts) > 1 else ""

    answers = {}
    for m in re.finditer(r"(\d+)\.\s*([A-D])\b", key):
        answers[int(m.group(1))] = m.group(2)

    # Passage is everything before the first "1. What is the main idea".
    q_start = re.search(r"\n\s*1\.\s+What\s+is\s+the\s+main\s+idea", body)
    if not q_start:
        sys.exit("could not locate question 1 marker in PDF")

    passage_raw = body[: q_start.start()]
    passage = re.sub(r"\n\s*\d+\s*\n", "\n", passage_raw)
    passage = re.sub(r"\s+", " ", passage).strip()

    qs_text = body[q_start.start() :]
    parts = re.split(r"(?m)^\s*(\d+)\.\s+", qs_text)
    questions = []
    for i in range(1, len(parts) - 1, 2):
        num = int(parts[i])
        if num > 12:
            continue
        block = parts[i + 1].strip()
        opt_m = re.search(r"(?m)^\s*A[\.\)]\s+", block)
        if not opt_m:
            continue
        q_stem = re.sub(r"\s+", " ", block[: opt_m.start()]).strip()
        opts_raw = block[opt_m.start() :]
        opt_parts = re.split(r"(?m)^\s*([A-D])[\.\)]\s+", "\n" + opts_raw)
        opts = []
        for j in range(1, len(opt_parts) - 1, 2):
            letter = opt_parts[j]
            text = re.sub(r"\s+", " ", opt_parts[j + 1]).strip()
            opts.append({"letter": letter, "text": text})
        if len(opts) < 4:
            continue
        questions.append(
            {
                "number": num,
                "question": q_stem,
                "options": opts,
                "correct": answers.get(num),
            }
        )

    out = {
        "passage_title": "Why the interest in top pay?",
        "passage": passage,
        "source": "EPSO language comprehension sample test",
        "source_url": "https://eu-careers.europa.eu/sites/default/files/documents//general/sample_tests/language_comprehension_test/en.pdf",
        "questions": questions,
    }
    OUT.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
    print(f"extracted {len(questions)} questions → {OUT}")


if __name__ == "__main__":
    main()
