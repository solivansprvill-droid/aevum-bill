#!/usr/bin/env bash
# Deploy InvoiceRegistry + PayeeDirectory to Aevum Testnet (or any RPC via RPC_URL) and record addresses.
# Reads DEPLOYER_PK from .deployer.secret (gitignored). TESTNET ONLY.
set -euo pipefail
cd "$(dirname "$0")/.."
source ./.deployer.secret
RPC_URL="${RPC_URL:-https://rpc-test.qday.info}"
OUT="${OUT:-deployments/aevum-testnet.json}"
TOKEN=0x456569838f1d43009A91ebA4263147Afd7233483
FEE_BPS="${FEE_BPS:-30}"
TREASURY="${TREASURY:-$DEPLOYER_ADDR}"
CHAIN=$(cast chain-id --rpc-url "$RPC_URL")
[ "$CHAIN" = "44005" ] || { echo "Refusing: chain id $CHAIN is not Aevum Testnet (44005)"; exit 1; }
cd contracts
# note: --constructor-args swallows everything after it, so it must come last
dep() { local c="$1"; shift; forge create "$c" --rpc-url "$RPC_URL" --private-key "$DEPLOYER_PK" --broadcast --legacy --json "$@"; }
R=$(dep src/InvoiceRegistry.sol:InvoiceRegistry --constructor-args $TOKEN "$TREASURY" "$FEE_BPS")
D=$(dep src/PayeeDirectory.sol:PayeeDirectory)
cd ..
node -e '
const fs=require("fs");const [r,d,out,tre,fee,dep]=process.argv.slice(1);const R=JSON.parse(r),D=JSON.parse(d);
const j=JSON.parse(fs.readFileSync(out));
j.invoiceRegistry=R.deployedTo;j.payeeDirectory=D.deployedTo;j.treasury=tre;j.feeBps=+fee;j.deployer=dep;
j.txs=Object.assign(j.txs||{},{deployRegistry:R.transactionHash,deployDirectory:D.transactionHash});
fs.writeFileSync(out,JSON.stringify(j,null,2)+"\n");console.log(JSON.stringify(j,null,2));' "$R" "$D" "$OUT" "$TREASURY" "$FEE_BPS" "$DEPLOYER_ADDR"
BLK=$(cast receipt "$(node -p "require(require('path').resolve('$OUT')).txs.deployRegistry")" blockNumber --rpc-url "$RPC_URL")
node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1]));j.deployBlock=+process.argv[2];fs.writeFileSync(process.argv[1],JSON.stringify(j,null,2)+"\n")' "$OUT" "$BLK"
echo "Deployed at block $BLK"
