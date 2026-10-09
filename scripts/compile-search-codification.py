#!/usr/bin/env python3
"""Compile a sanitized common-codification config from the framework workbook.

Reads sheets 3 (conventions, when present), 4 (CDEs), 5 (value sets) and 9 (QC rules).
Omits partner registers, source mappings, local value mappings and the issues log.
Public output uses catalogue wording and does not repeat the source project name.

Usage:
  python3 scripts/compile-search-codification.py /path/to/codification-framework.xlsx
"""

import json
import sys
import zipfile
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

def public_id(value: str) -> str:
    if value.startswith("SEARCH-"):
        return "CDE-" + value[len("SEARCH-") :]
    return value


def public_text(value: str) -> str:
    return value.replace("SEARCH variable names", "catalogue variable names").replace("SEARCH ", "")


NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL = {"r": "http://schemas.openxmlformats.org/package/2006/relationships"}


def col_index(ref: str) -> int:
    letters = "".join(ch for ch in ref if ch.isalpha())
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch.upper()) - 64)
    return n - 1


def load_workbook(path: Path):
    with zipfile.ZipFile(path) as zf:
        shared = []
        if "xl/sharedStrings.xml" in zf.namelist():
            root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
            for si in root.findall("m:si", NS):
                shared.append("".join(t.text or "" for t in si.iter("{%s}t" % NS["m"])))

        wb = ET.fromstring(zf.read("xl/workbook.xml"))
        rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
        rid_to_target = {
            rel.attrib["Id"]: rel.attrib["Target"]
            for rel in rels.findall("r:Relationship", REL)
        }
        sheets = []
        for sheet in wb.findall("m:sheets/m:sheet", NS):
            name = sheet.attrib["name"]
            rid = sheet.attrib["{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"]
            target = rid_to_target[rid]
            if not target.startswith("xl/"):
                target = "xl/" + target.lstrip("/")
            sheets.append((name, target))

        def rows_of(target: str):
            root = ET.fromstring(zf.read(target))
            out = []
            for row in root.findall("m:sheetData/m:row", NS):
                cells = {}
                for cell in row.findall("m:c", NS):
                    ref = cell.attrib.get("r", "")
                    idx = col_index(ref) if ref else len(cells)
                    kind = cell.attrib.get("t")
                    value = ""
                    if kind == "s":
                        v = cell.find("m:v", NS)
                        if v is not None and v.text:
                            value = shared[int(v.text)]
                    elif kind == "inlineStr":
                        value = "".join(t.text or "" for t in cell.iter("{%s}t" % NS["m"]))
                    else:
                        v = cell.find("m:v", NS)
                        if v is not None and v.text:
                            value = v.text
                    cells[idx] = value.strip()
                if not cells:
                    continue
                width = max(cells) + 1
                out.append([cells.get(i, "") for i in range(width)])
            return out

        return {name: rows_of(target) for name, target in sheets}


def header_map(header):
    return {name.strip().lower(): i for i, name in enumerate(header)}


def cell(row, idx):
    if idx is None or idx >= len(row):
        return ""
    return row[idx].strip()


def find_sheet(book, needle: str):
    for name, rows in book.items():
        if needle.lower() in name.lower():
            return name, rows
    raise SystemExit(f"Sheet matching {needle!r} not found. Sheets: {list(book)}")


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Pass the framework workbook path.")
    book = load_workbook(Path(sys.argv[1]))

    _, cde_rows = find_sheet(book, "4_CDE")
    _, vs_rows = find_sheet(book, "5_Value")
    _, qc_rows = find_sheet(book, "9_QC")

    cde_h = header_map(cde_rows[0])
    vs_h = header_map(vs_rows[0])
    qc_h = header_map(qc_rows[0])

    def pick(h, *names):
        for name in names:
            if name in h:
                return h[name]
        raise SystemExit(f"Missing column {names}. Have {list(h)}")

    cdes = []
    for row in cde_rows[1:]:
        variable = cell(row, pick(cde_h, "search_variable"))
        if not variable:
            continue
        table = cell(row, pick(cde_h, "table")) or "all"
        cdes.append(
            {
                "id": public_id(cell(row, pick(cde_h, "cde_id"))),
                "variable": variable,
                "domain": cell(row, pick(cde_h, "domain")),
                "table": table,
                "dataType": cell(row, pick(cde_h, "data_type")).lower(),
                "unit": cell(row, pick(cde_h, "unit (ucum)", "unit")),
                "valueSet": cell(row, pick(cde_h, "value_set")),
                "range": cell(row, pick(cde_h, "permissible range / format", "permissible range")),
            }
        )

    value_sets = defaultdict(list)
    for row in vs_rows[1:]:
        vs_id = cell(row, pick(vs_h, "value_set_id"))
        code = cell(row, pick(vs_h, "search_code"))
        if vs_id and code and code not in value_sets[vs_id]:
            value_sets[vs_id].append(code)

    severity = {"error": "error", "warning": "warn", "warn": "warn", "info": "info"}
    rules = []
    for row in qc_rows[1:]:
        rule_id = cell(row, pick(qc_h, "rule_id"))
        if not rule_id:
            continue
        raw = cell(row, pick(qc_h, "severity")).lower()
        rules.append(
            {
                "id": rule_id,
                "appliesTo": cell(row, pick(qc_h, "applies to")),
                "rule": public_text(cell(row, pick(qc_h, "rule"))),
                "type": cell(row, pick(qc_h, "type")),
                "severity": severity.get(raw, "warn"),
                "action": cell(row, pick(qc_h, "action if violated")),
            }
        )

    export_tables = [
        "subject",
        "event",
        "lesion",
        "specimen",
        "treatment",
        "questionnaire",
        "annotation",
        "image",
    ]

    config = {
        "id": "common-codification-v2",
        "version": "2.0",
        "name": "Common Codification v2.0",
        "description": "QC-01 to QC-40 for a curated tabular export (CSV). Compiled from the codification framework without partner mappings or the issues log.",
        "formats": ["csv", "codification-package"],
        "studyId": "CC-V2",
        "dictionaryRef": "Common Codification Guideline v2.0",
        "metadataRequirements": ["license", "provenance"],
        "plugins": ["codification-qc", "metadata-requirements", "reproducibility"],
        "failOnError": True,
        "failOnWarn": False,
        "entities": [
            {
                "name": table,
                "table": f"{table}.csv",
                "description": f"{table} table",
                "fields": [{"name": "subject_id", "required": True}],
            }
            for table in export_tables
        ],
        "codification": {
            "tables": export_tables,
            "subjectIdPattern": r"^DS\d{2}-[A-Z0-9]{8}$",
            "darCodes": [
                "unknown",
                "asked-unknown",
                "asked_unknown",
                "temp-unknown",
                "temp_unknown",
                "not-asked",
                "not_asked",
                "asked-declined",
                "asked_declined",
                "masked",
                "not-applicable",
                "not_applicable",
                "unsupported",
                "as-text",
                "as_text",
                "error",
                "not-performed",
                "not_performed",
                "not-permitted",
                "not_permitted",
            ],
            "dayOffsetMin": -3650,
            "dayOffsetMax": 7300,
            "cdes": cdes,
            "valueSets": dict(value_sets),
            "rules": rules,
        },
    }

    out = Path(__file__).resolve().parents[1] / "configs" / "common-codification-v2.json"
    out.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {out}")
    print(f"CDEs {len(cdes)}  value sets {len(value_sets)}  rules {len(rules)}  tables {config['codification']['tables']}")
    print("RULES")
    for rule in rules:
        print(f"{rule['id']}\t{rule['severity']}\t{rule['rule']}")
    print("VARIABLES")
    for cde in cdes:
        print(f"{cde['variable']}\t{cde['table']}\t{cde['dataType']}\t{cde['valueSet']}\t{cde['range']}\t{cde['domain']}")


if __name__ == "__main__":
    main()
