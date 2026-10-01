#!/usr/bin/env python3
"""Scan actual artifact contents; exit 0 clean, 1 findings, 2 incomplete."""
from __future__ import annotations

import argparse
import json
import os
import sys
from . import scan_path


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target")
    parser.add_argument("--receipt", help="write JSON receipt outside scanned input")
    parser.add_argument("--require", action="append", default=[], help="required regular-file inventory path")
    parser.add_argument("--architecture")
    parser.add_argument("--limits", help="JSON object of explicit resource-limit overrides")
    args = parser.parse_args(argv)
    try:
        limits = json.loads(args.limits) if args.limits else None
        if limits is not None and not isinstance(limits, dict):
            raise ValueError("limits must be an object")
        if args.receipt:
            target, receipt_path = os.path.realpath(args.target), os.path.realpath(args.receipt)
            if receipt_path == target or os.path.isdir(target) and os.path.commonpath([target, receipt_path]) == target:
                raise ValueError("receipt must be outside scanned input")
        receipt = scan_path(args.target, args.require, args.architecture, limits)
        if args.receipt:
            with open(args.receipt, "w", encoding="utf-8") as stream:
                json.dump(receipt, stream, ensure_ascii=True, sort_keys=True, indent=2)
                stream.write("\n")
    except (OSError, ValueError, TypeError):
        print("fresh-install leak scan: incomplete (invalid invocation or receipt write failure)", file=sys.stderr)
        return 2
    print(f"fresh-install leak scan: {receipt['result']}; {receipt['coverage']['files']} files; "
          f"{receipt['findings_count']} file/rule pairs; {receipt['errors_count']} coverage errors")
    for item in receipt["findings"]:
        print(f"{item['path']}: {item['rule']}", file=sys.stderr)
    for item in receipt["errors"]:
        print(f"{item['path']}: {item['code']}", file=sys.stderr)
    return receipt["exit_code"]


if __name__ == "__main__":
    sys.exit(main())
