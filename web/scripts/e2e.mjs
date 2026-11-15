// End-to-end run on Aevum Testnet: register payee -> create invoice -> pay with EIP-2612 permit from a second
// wallet -> negative checks -> receipt from events. Writes tx hashes to deployments/<E2E_OUT or e2e-aevum-testnet.json>.
// Usage (from repo root):  node web/scripts/e2e.mjs        (RPC_URL overrides the endpoint, e.g. an anvil fork)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient, createWalletClient, defineChain, formatUnits, http, keccak256, parseEther, parseSignature,
  parseUnits, stringToBytes, zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { invoiceRegistryAbi, payeeDirectoryAbi, erc20Abi } from "./abi.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const secret = Object.fromEntries(
  fs.readFileSync(path.join(root, ".deployer.secret"), "utf8").trim().split("\n").map((l) => l.split("=")),
);
const dep = JSON.parse(fs.readFileSync(path.join(root, "deployments/aevum-testnet.json"), "utf8"));
const RPC = process.env.RPC_URL || "https://rpc-test.qday.info";
const OUT = path.join(root, "deployments", process.env.E2E_OUT || "e2e-aevum-testnet.json");
const AMOUNT = parseUnits(process.env.E2E_AMOUNT || "0.5", 6);
const chain = defineChain({
  id: 44005, name: "Aevum Testnet", nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain, transport: http(RPC) });
if ((await pub.getChainId()) !== 44005) throw new Error("not Aevum Testnet");
const merchant = privateKeyToAccount(secret.DEPLOYER_PK);
const payer = privateKeyToAccount(secret.PAYER_PK);
const mw = createWalletClient({ account: merchant, chain, transport: http(RPC) });
const pw = createWalletClient({ account: payer, chain, transport: http(RPC) });
const REG = dep.invoiceRegistry, DIR = dep.payeeDirectory, TOKEN = dep.token;
const log = { network: "Aevum Testnet (44005)", rpc: RPC.includes("qday") ? RPC : "local fork", registry: REG, directory: DIR,
  merchant: merchant.address, payer: payer.address, txs: {} };
const fmt = (v) => formatUnits(v, 6);

async function tx(name, wallet, req) {
  const { request } = await pub.simulateContract({ ...req, account: wallet.account });
  const hash = await wallet.writeContract(request);
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`${name} failed ${hash}`);
  log.txs[name] = hash;
  console.log(`✓ ${name.padEnd(16)} ${hash}  (block ${rc.blockNumber})`);
  return rc;
}

// 0. fund the payer from the deployer (faucet funds one address per day)
const payerGas = await pub.getBalance({ address: payer.address });
if (payerGas < parseEther("0.05")) {
  const hash = await mw.sendTransaction({ to: payer.address, value: parseEther("0.2") });
  await pub.waitForTransactionReceipt({ hash });
  log.txs.fundPayerGas = hash;
  console.log(`✓ fundPayerGas     ${hash}`);
}
const payerBal = await pub.readContract({ address: TOKEN, abi: erc20Abi, functionName: "balanceOf", args: [payer.address] });
if (payerBal < AMOUNT) await tx("fundPayerTUSD8", mw, { address: TOKEN, abi: erc20Abi, functionName: "transfer", args: [payer.address, AMOUNT - payerBal] });

// 1. confirmation of payee
const reg = await pub.readContract({ address: DIR, abi: payeeDirectoryAbi, functionName: "isRegistered", args: [merchant.address] });
if (!reg) await tx("registerPayee", mw, { address: DIR, abi: payeeDirectoryAbi, functionName: "register", args: ["AevumBill Demo Merchant", "https://github.com/solivansprvill-droid/aevum-bill"] });

// 2. create invoice (only the payer wallet may pay)
const memo = "INV-0001 · AevumBill end-to-end demo";
const due = BigInt(Math.floor(Date.now() / 1000) + 7 * 86400);
const rc = await tx("createInvoice", mw, {
  address: REG, abi: invoiceRegistryAbi, functionName: "createInvoice",
  args: [merchant.address, AMOUNT, due, keccak256(stringToBytes(memo)), payer.address, false],
});
const id = BigInt(rc.logs.find((l) => l.address.toLowerCase() === REG.toLowerCase()).topics[1]);
const terms = await pub.readContract({ address: REG, abi: invoiceRegistryAbi, functionName: "termsHash", args: [id] });
log.invoiceId = Number(id);
log.memo = memo;
log.amount = `${fmt(AMOUNT)} tUSD8`;
log.terms = terms;

// 3. negative checks (simulated, no gas): wrong amount and wrong terms must revert
for (const [label, args, who] of [
  ["wrongAmount", [id, terms, AMOUNT - 1n], payer],
  ["wrongInvoiceTerms", [id, keccak256(stringToBytes("forged")), AMOUNT], payer],
  ["notAllowedPayer", [id, terms, AMOUNT], merchant],
]) {
  try {
    await pub.simulateContract({ address: REG, abi: invoiceRegistryAbi, functionName: "pay", args, account: who });
    throw new Error(`${label} unexpectedly succeeded`);
  } catch (e) {
    const name = e?.cause?.data?.errorName || e?.cause?.reason || e.shortMessage;
    (log.blocked ||= {})[label] = name;
    console.log(`✓ blocked ${label}: ${name}`);
  }
}

// 4. pay with an EIP-2612 permit (one signature + one tx)
const [nonce, name, version] = await Promise.all([
  pub.readContract({ address: TOKEN, abi: erc20Abi, functionName: "nonces", args: [payer.address] }),
  pub.readContract({ address: TOKEN, abi: erc20Abi, functionName: "name" }),
  pub.readContract({ address: TOKEN, abi: erc20Abi, functionName: "version" }),
]);
const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
const sig = await pw.signTypedData({
  domain: { name, version, chainId: 44005, verifyingContract: TOKEN },
  types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
  primaryType: "Permit",
  message: { owner: payer.address, spender: REG, value: AMOUNT, nonce, deadline },
});
const { r, s, v } = parseSignature(sig);
await tx("payWithPermit", pw, { address: REG, abi: invoiceRegistryAbi, functionName: "payWithPermit", args: [id, terms, AMOUNT, deadline, Number(v), r, s] });

// 5. double payment must now revert
try {
  await pub.simulateContract({ address: REG, abi: invoiceRegistryAbi, functionName: "pay", args: [id, terms, AMOUNT], account: payer });
  throw new Error("double pay unexpectedly succeeded");
} catch (e) {
  log.blocked.doublePay = e?.cause?.data?.errorName || e.shortMessage;
  console.log(`✓ blocked doublePay: ${log.blocked.doublePay}`);
}

// 6. receipt from chain
const inv = await pub.readContract({ address: REG, abi: invoiceRegistryAbi, functionName: "getInvoice", args: [id] });
const blocks = await pub.readContract({ address: REG, abi: invoiceRegistryAbi, functionName: "eventBlocks", args: [id] });
const events = [];
for (const b of [...new Set(blocks)]) {
  const logs = await pub.getContractEvents({ address: REG, abi: invoiceRegistryAbi, fromBlock: b, toBlock: b, args: { id } });
  for (const l of logs) events.push({ event: l.eventName, block: Number(l.blockNumber), tx: l.transactionHash,
    ...(l.eventName === "InvoicePaid" ? { amount: fmt(l.args.amount), fee: fmt(l.args.fee), payer: l.args.payer } : {}) });
}
log.receipt = { status: ["None", "Open", "Paid", "Cancelled", "Refunded"][inv.status], paid: fmt(inv.paid), payer: inv.payer, events };
log.finishedAt = new Date().toISOString();
fs.writeFileSync(OUT, JSON.stringify(log, null, 2) + "\n");
console.log(JSON.stringify(log.receipt, null, 2));
console.log(`wrote ${OUT}`);
