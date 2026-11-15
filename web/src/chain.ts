import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  numberToHex,
  parseAbiItem,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";
import { aevumTestnet, REGISTRY, TUSD8 } from "./config";
import { erc20Abi, invoiceRegistryAbi } from "./abi";

export const pub = createPublicClient({ chain: aevumTestnet, transport: http() });

export const STATUS = ["None", "Open", "Paid", "Cancelled", "Refunded"] as const;

export type Invoice = {
  id: bigint;
  merchant: Address;
  payee: Address;
  allowedPayer: Address;
  payer: Address;
  amount: bigint;
  paid: bigint;
  refunded: bigint;
  dueDate: bigint;
  createdAt: bigint;
  feeBps: number;
  allowPartial: boolean;
  status: number;
  memoHash: Hex;
  terms: Hex;
};

declare global {
  interface Window {
    ethereum?: any;
  }
}

let wallet: WalletClient | null = null;
let account: Address | null = null;
const listeners = new Set<() => void>();
export const onWallet = (f: () => void) => listeners.add(f);
const emit = () => listeners.forEach((f) => f());
export const currentAccount = () => account;

export function hasInjected() {
  return typeof window !== "undefined" && !!window.ethereum;
}

/** Connect the injected wallet and make sure it is on Aevum Testnet (adds the chain if unknown). */
export async function connect(): Promise<Address> {
  if (!window.ethereum) throw new Error("No browser wallet found. Install MetaMask, Rabby or OKX Wallet.");
  const [a] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
  account = a;
  wallet = createWalletClient({ account: a, chain: aevumTestnet, transport: custom(window.ethereum) });
  await ensureChain();
  if (!(window as any).__abListen) {
    (window as any).__abListen = true;
    window.ethereum.on?.("accountsChanged", (accs: Address[]) => {
      account = accs[0] ?? null;
      if (account) wallet = createWalletClient({ account, chain: aevumTestnet, transport: custom(window.ethereum) });
      emit();
    });
    window.ethereum.on?.("chainChanged", () => emit());
  }
  emit();
  return a;
}

export async function walletChainId(): Promise<number | null> {
  if (!window.ethereum) return null;
  return Number(await window.ethereum.request({ method: "eth_chainId" }));
}

export async function ensureChain() {
  const hex = numberToHex(aevumTestnet.id);
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e: any) {
    if (e?.code === 4902 || /unrecognized|not added|unknown chain/i.test(String(e?.message))) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: hex,
            chainName: "Aevum Testnet",
            nativeCurrency: { name: "Test QDAY", symbol: "tQDAY", decimals: 18 },
            rpcUrls: aevumTestnet.rpcUrls.default.http,
            blockExplorerUrls: [aevumTestnet.blockExplorers.default.url],
          },
        ],
      });
    } else throw e;
  }
}

export function w(): WalletClient & { account: { address: Address } } {
  if (!wallet || !account) throw new Error("Connect your wallet first.");
  return wallet as any;
}

export async function send(req: any): Promise<Hex> {
  await ensureChain();
  const { request } = await pub.simulateContract({ ...req, account: account! });
  const hash = await w().writeContract(request as any);
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

export async function readInvoice(id: bigint): Promise<Invoice | null> {
  if (!REGISTRY) return null;
  const [inv, terms] = await Promise.all([
    pub.readContract({ address: REGISTRY, abi: invoiceRegistryAbi, functionName: "getInvoice", args: [id] }),
    pub.readContract({ address: REGISTRY, abi: invoiceRegistryAbi, functionName: "termsHash", args: [id] }),
  ]);
  if (Number((inv as any).status) === 0) return null;
  return { id, ...(inv as any), status: Number((inv as any).status), feeBps: Number((inv as any).feeBps), terms };
}

export async function balanceOf(a: Address) {
  return pub.readContract({ address: TUSD8, abi: erc20Abi, functionName: "balanceOf", args: [a] });
}

const EV = {
  created: parseAbiItem(
    "event InvoiceCreated(uint256 indexed id, address indexed merchant, address indexed payee, uint256 amount, uint64 dueDate, bytes32 memoHash, address allowedPayer, bool allowPartial, uint16 feeBps, bytes32 termsHash)",
  ),
  paid: parseAbiItem(
    "event InvoicePaid(uint256 indexed id, address indexed payer, address indexed payee, uint256 amount, uint256 fee, uint256 totalPaid, bool fullyPaid)",
  ),
  cancelled: parseAbiItem("event InvoiceCancelled(uint256 indexed id, address indexed merchant)"),
  refunded: parseAbiItem(
    "event InvoiceRefunded(uint256 indexed id, address indexed to, uint256 amount, uint256 totalRefunded)",
  ),
};

/** Logs for one invoice, fetched only from the blocks the registry indexed (public RPC caps getLogs at 1,000 blocks). */
async function logsAt(blocks: bigint[], event: any, args: any): Promise<any[]> {
  if (!REGISTRY) return [];
  const uniq = [...new Set(blocks.map(String))].map(BigInt);
  const res = await Promise.all(
    uniq.map((b) => pub.getLogs({ address: REGISTRY!, event, args, fromBlock: b, toBlock: b })),
  );
  return res.flat();
}

export async function merchantInvoiceIds(merchant: Address): Promise<bigint[]> {
  if (!REGISTRY) return [];
  const ids = await pub.readContract({ address: REGISTRY, abi: invoiceRegistryAbi, functionName: "invoicesOf", args: [merchant] });
  return [...ids].reverse();
}

export type TimelineItem = { kind: string; tx: Hex; block: bigint; time: number; args: any };

export async function invoiceTimeline(id: bigint): Promise<TimelineItem[]> {
  const blocks = (await pub.readContract({ address: REGISTRY!, abi: invoiceRegistryAbi, functionName: "eventBlocks", args: [id] })).map(BigInt);
  const logs = (ev: any, args: any) => logsAt(blocks, ev, args);
  const sets = await Promise.all([
    logs(EV.created, { id }).then((l) => l.map((x) => ({ ...x, kind: "Created" }))),
    logs(EV.paid, { id }).then((l) => l.map((x) => ({ ...x, kind: "Paid" }))),
    logs(EV.cancelled, { id }).then((l) => l.map((x) => ({ ...x, kind: "Cancelled" }))),
    logs(EV.refunded, { id }).then((l) => l.map((x) => ({ ...x, kind: "Refunded" }))),
  ]);
  const all = sets.flat().sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
  const times = new Map<bigint, number>();
  for (const l of all) {
    if (!times.has(l.blockNumber)) {
      const b = await pub.getBlock({ blockNumber: l.blockNumber });
      times.set(l.blockNumber, Number(b.timestamp));
    }
  }
  return all.map((l) => ({
    kind: l.kind,
    tx: l.transactionHash,
    block: l.blockNumber,
    time: times.get(l.blockNumber)!,
    args: l.args,
  }));
}
