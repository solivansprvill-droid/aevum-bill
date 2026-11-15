import { defineChain, type Address } from "viem";
import deployment from "../../deployments/aevum-testnet.json";

export const aevumTestnet = defineChain({
  id: 44005,
  name: "Aevum Testnet",
  nativeCurrency: { name: "Test QDAY", symbol: "tQDAY", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc-test.qday.info"] } },
  blockExplorers: { default: { name: "Aevum Explorer", url: "https://explorer-test.qday.info" } },
  testnet: true,
});

export const EXPLORER = "https://explorer-test.qday.info";
export const FAUCET = "https://faucet.qday.info/en";

/** Canonical tUSD8 on Aevum Testnet. The pay page refuses any other token. */
export const TUSD8: Address = "0x456569838f1d43009A91ebA4263147Afd7233483";
export const TOKEN_DECIMALS = 6;
export const TOKEN_SYMBOL = "tUSD8";

export const REGISTRY = (deployment.invoiceRegistry ?? null) as Address | null;
export const DIRECTORY = (deployment.payeeDirectory ?? null) as Address | null;
export const DEPLOY_BLOCK = BigInt(deployment.deployBlock ?? 0);
export const DEPLOYED = !!(REGISTRY && DIRECTORY);

export const txUrl = (h: string) => `${EXPLORER}/tx/${h}`;
export const addrUrl = (a: string) => `${EXPLORER}/address/${a}`;
