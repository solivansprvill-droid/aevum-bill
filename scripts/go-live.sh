#!/usr/bin/env bash
# One-shot: deploy -> verify -> e2e -> rebuild the static app. Run once the deployer holds tQDAY + tUSD8.
set -euo pipefail
cd "$(dirname "$0")/.."
source ./.deployer.secret
RPC=https://rpc-test.qday.info
GAS=$(cast balance "$DEPLOYER_ADDR" --rpc-url $RPC)
USD=$(cast call 0x456569838f1d43009A91ebA4263147Afd7233483 "balanceOf(address)(uint256)" "$DEPLOYER_ADDR" --rpc-url $RPC | cut -d' ' -f1)
echo "deployer $DEPLOYER_ADDR  tQDAY(wei)=$GAS  tUSD8(units)=$USD"
[ "$GAS" != "0" ] || { echo "Deployer has no tQDAY. Fund it from https://faucet.qday.info/en"; exit 1; }
[ "$USD" -ge 500000 ] || { echo "Deployer needs >= 0.5 tUSD8 for the e2e invoice"; exit 1; }
if [ "$(node -p "require('./deployments/aevum-testnet.json').invoiceRegistry")" = "null" ]; then bash scripts/deploy.sh; fi
bash scripts/verify.sh || echo "WARN: explorer verification failed (non-fatal)"
node web/scripts/e2e.mjs
(cd web && npm run build)
echo "Done. Commit deployments/ + dist/, then publish dist/ to gh-pages."
