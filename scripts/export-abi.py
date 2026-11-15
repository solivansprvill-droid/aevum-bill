#!/usr/bin/env python3
"""Regenerate web/src/abi.ts from Foundry artifacts (run `forge build` in contracts/ first)."""
import json, os

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
s = "// Generated from contracts/out by scripts/export-abi.py. Do not edit.\n"
for n in ["InvoiceRegistry", "PayeeDirectory"]:
    abi = json.load(open(f"{root}/contracts/out/{n}.sol/{n}.json"))["abi"]
    s += f"export const {n[0].lower() + n[1:]}Abi = {json.dumps(abi)} as const;\n"
s += open(f"{root}/scripts/erc20-abi.ts.txt").read()
open(f"{root}/web/src/abi.ts", "w").write(s)
print("wrote web/src/abi.ts")
open(f"{root}/web/scripts/abi.mjs", "w").write(s.replace(" as const;", ";"))
print("wrote web/scripts/abi.mjs")
