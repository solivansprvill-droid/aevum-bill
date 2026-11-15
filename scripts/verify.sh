#!/usr/bin/env bash
# Verify both contracts on the Aevum Blockscout explorer.
set -euo pipefail
cd "$(dirname "$0")/.."
J=deployments/aevum-testnet.json
R=$(node -p "require('./$J').invoiceRegistry"); D=$(node -p "require('./$J').payeeDirectory")
T=$(node -p "require('./$J').treasury"); F=$(node -p "require('./$J').feeBps")
cd contracts
V="--chain 44005 --verifier blockscout --verifier-url https://explorer-test.qday.info/api/ --compiler-version 0.8.24 --watch"
forge verify-contract $R src/InvoiceRegistry.sol:InvoiceRegistry $V \
  --constructor-args $(cast abi-encode "c(address,address,uint16)" 0x456569838f1d43009A91ebA4263147Afd7233483 $T $F)
forge verify-contract $D src/PayeeDirectory.sol:PayeeDirectory $V
