import "./style.css";
import {
  formatUnits,
  getAddress,
  isAddress,
  keccak256,
  parseSignature,
  parseUnits,
  stringToBytes,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import {
  addrUrl,
  DEPLOYED,
  DIRECTORY,
  EXPLORER,
  FAUCET,
  REGISTRY,
  TOKEN_DECIMALS,
  TOKEN_SYMBOL,
  TUSD8,
  txUrl,
} from "./config";
import { erc20Abi, invoiceRegistryAbi, payeeDirectoryAbi } from "./abi";
import {
  balanceOf,
  connect,
  currentAccount,
  ensureChain,
  hasInjected,
  invoiceTimeline,
  merchantInvoiceIds,
  onWallet,
  pub,
  readInvoice,
  send,
  STATUS,
  w,
  walletChainId,
  type Invoice,
} from "./chain";

// ---------------------------------------------------------------- helpers
const app = document.getElementById("app")!;
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fmt = (v: bigint) =>
  Number(formatUnits(v, TOKEN_DECIMALS)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const date = (s: bigint | number) =>
  new Date(Number(s) * 1000).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
const memoHashOf = (m: string): Hex => keccak256(stringToBytes(m));
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => app.querySelector(sel) as T;

function toast(msg: string, kind: "ok" | "err" | "info" = "info") {
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 5200);
}

function errMsg(e: any): string {
  const m = e?.shortMessage || e?.details || e?.message || String(e);
  const custom = /reverted with the following reason:\s*(.*)|Error: (\w+\(.*?\))/s.exec(m);
  if (e?.cause?.data?.errorName) return `${e.cause.data.errorName}: blocked by the contract`;
  return (custom?.[1] || custom?.[2] || m).split("\n")[0].slice(0, 220);
}

async function busy(btn: HTMLButtonElement, label: string, fn: () => Promise<void>) {
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span>${esc(label)}`;
  try {
    await fn();
  } catch (e) {
    console.error(e);
    toast(errMsg(e), "err");
  } finally {
    btn.disabled = false;
    btn.innerHTML = old;
  }
}

function statusBadge(inv: Invoice) {
  const expired = inv.status === 1 && BigInt(Math.floor(Date.now() / 1000)) > inv.dueDate;
  const label = expired ? "Expired" : inv.status === 1 && inv.paid > 0n ? "Partially paid" : STATUS[inv.status];
  return `<span class="badge s-${label.toLowerCase().replace(/\s/g, "-")}">${label}</span>`;
}

function shareLink(id: bigint, terms: Hex, memo: string) {
  const base = location.href.split("#")[0];
  const q = new URLSearchParams({ t: terms.slice(0, 18) });
  if (memo) q.set("memo", memo);
  return `${base}#/pay/${id}?${q.toString()}`;
}

async function payeeName(a: Address): Promise<{ name: string; website: string; since: bigint } | null> {
  if (!DIRECTORY) return null;
  const p: any = await pub.readContract({ address: DIRECTORY, abi: payeeDirectoryAbi, functionName: "payeeOf", args: [a] });
  if (!p.registeredAt) return null;
  return { name: p.name, website: p.website, since: p.registeredAt };
}

// ---------------------------------------------------------------- layout
function shell(inner: string) {
  const acc = currentAccount();
  app.innerHTML = `
  <header class="top">
    <a class="brand" href="#/"><span class="logo">◈</span> AevumBill</a>
    <nav>
      <a href="#/merchant">Merchant</a>
      <a href="#/receipt">Receipts</a>
      <a href="https://github.com/solivansprvill-droid/aevum-bill" target="_blank" rel="noopener">GitHub</a>
      <button id="connect" class="btn small ${acc ? "ghost" : ""}">${acc ? `● ${short(acc)}` : "Connect wallet"}</button>
    </nav>
  </header>
  ${
    DEPLOYED
      ? ""
      : `<div class="banner">Contracts are not deployed in this build yet. The UI is live; on-chain actions unlock once <code>deployments/aevum-testnet.json</code> is filled.</div>`
  }
  <main>${inner}</main>
  <footer>
    <span>Aevum Testnet · chain 44005 · ${TOKEN_SYMBOL} <a href="${addrUrl(TUSD8)}" target="_blank" rel="noopener">${short(TUSD8)}</a></span>
    ${REGISTRY ? `<span>Registry <a href="${addrUrl(REGISTRY)}" target="_blank" rel="noopener">${short(REGISTRY)}</a></span>` : ""}
    <span><a href="${FAUCET}" target="_blank" rel="noopener">Faucet</a> · Testnet only, no real funds</span>
  </footer>`;
  $("#connect").onclick = () =>
    connect()
      .then(() => toast("Wallet connected on Aevum Testnet", "ok"))
      .catch((e) => toast(errMsg(e), "err"));
}

// ---------------------------------------------------------------- home
function home() {
  shell(`
  <section class="hero">
    <p class="eyebrow">Aevum Builder Challenge · Invoice Payments</p>
    <h1>Invoices your client can't pay wrong.</h1>
    <p class="lead">AevumBill turns an invoice into a one-time, tamper-proof payment request on Aevum. The amount, payee, due date and memo are locked on-chain, the payer sees a verified payee before signing, and the receipt is read straight from chain events.</p>
    <div class="cta">
      <a class="btn" href="#/merchant">Create an invoice</a>
      <a class="btn ghost" href="#/receipt">Look up a receipt</a>
    </div>
  </section>
  <section class="grid3">
    <div class="card feat"><h3>1 · Issue</h3><p>Merchant sets payee, amount in ${TOKEN_SYMBOL}, due date, memo and optionally the only wallet allowed to pay. A share link is generated.</p></div>
    <div class="card feat"><h3>2 · Verify &amp; pay</h3><p>The pay page runs 8 safety checks (network, token, contract, terms hash, payee name, memo, expiry, payer) then settles with one permit signature + one transaction.</p></div>
    <div class="card feat"><h3>3 · Prove</h3><p>A printable receipt rebuilt from <code>InvoiceCreated</code> / <code>InvoicePaid</code> / <code>InvoiceRefunded</code> events, with explorer links.</p></div>
  </section>
  <section class="card guards">
    <h2>What the contract refuses</h2>
    <ul class="checks">
      <li>Wrong amount (exact match unless partial payments are enabled; overpayment always blocked)</li>
      <li>Paying twice, paying after cancel, paying after the due date</li>
      <li>Paying the wrong invoice: every payment carries the terms hash the payer reviewed</li>
      <li>Any wallet other than the allowed payer, when one is set</li>
      <li>Refunds larger than what was paid; fee changes after an invoice was issued (fee snapshot, 1% hard cap)</li>
    </ul>
    <p class="muted">Non-custodial: funds go payer → payee (+0.3% → treasury) inside one transaction. The registry never holds a balance.</p>
  </section>`);
}

// ---------------------------------------------------------------- merchant
async function merchant() {
  const acc = currentAccount();
  const due = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  shell(`
  <section class="page-head"><h1>Merchant dashboard</h1><p class="muted">Issue ${TOKEN_SYMBOL} invoices on Aevum Testnet and share a pay link.</p></section>
  ${
    !acc
      ? `<div class="card center"><p>Connect the wallet that should receive payments.</p><button class="btn" id="c2">Connect wallet</button>${hasInjected() ? "" : `<p class="muted">No injected wallet detected.</p>`}</div>`
      : `
  <div class="cols">
    <form class="card" id="create">
      <h2>New invoice</h2>
      <label>Payee address<input name="payee" value="${acc}" required /></label>
      <div class="row">
        <label>Amount (${TOKEN_SYMBOL})<input name="amount" type="number" min="0.000001" step="0.000001" placeholder="250.00" required /></label>
        <label>Due date<input name="due" type="date" value="${due}" required /></label>
      </div>
      <label>Memo / reference<input name="memo" maxlength="140" placeholder="INV-2026-014 · Website redesign, milestone 2" /></label>
      <label>Only this payer may pay <span class="muted">(optional)</span><input name="payer" placeholder="0x… leave empty for anyone" /></label>
      <label class="check"><input type="checkbox" name="partial" /> Allow partial payments (same payer, never above the total)</label>
      <p class="muted small">A 0.3% protocol fee is snapshotted at creation. The memo stays off-chain; only its keccak256 hash is stored, so the payer can verify the text in the link wasn't edited.</p>
      <button class="btn" id="createBtn" type="submit">Create invoice</button>
      <div id="created"></div>
    </form>
    <div class="card" id="payeeCard">
      <h2>Verified payee name</h2>
      <p class="muted">Bind a business name to <b>${short(acc)}</b>. Payers see it as “Verified payee”. Only this wallet can write it, and names are unique.</p>
      <div id="payeeNow" class="muted">Loading…</div>
      <label>Business name<input id="pname" maxlength="40" placeholder="Acme Design Ltd" /></label>
      <label>Website<input id="psite" maxlength="80" placeholder="https://acme.example" /></label>
      <button class="btn ghost" id="pbtn">Register name</button>
      <div class="bal" id="bal"></div>
    </div>
  </div>
  <section class="card"><div class="list-head"><h2>Your invoices</h2><button class="btn small ghost" id="reload">Refresh</button></div><div id="list" class="muted">Loading…</div></section>`
  }`);
  if (!acc) {
    $("#c2").onclick = () => connect().catch((e) => toast(errMsg(e), "err"));
    return;
  }
  balanceOf(acc)
    .then((b) => ($("#bal").innerHTML = `Wallet balance: <b>${fmt(b)} ${TOKEN_SYMBOL}</b> · <a href="${FAUCET}" target="_blank" rel="noopener">faucet</a>`))
    .catch(() => {});
  payeeName(acc).then((p) => {
    $("#payeeNow").innerHTML = p
      ? `<span class="ok">✓ Registered as <b>${esc(p.name)}</b> since ${date(p.since)}</span>`
      : `<span class="warn">Not registered yet: payers will see an “unverified payee” warning.</span>`;
    if (p) ($("#pname") as HTMLInputElement).value = p.name;
  });
  $("#pbtn").onclick = () =>
    busy($("#pbtn") as HTMLButtonElement, "Registering…", async () => {
      const name = ($("#pname") as HTMLInputElement).value.trim();
      const site = ($("#psite") as HTMLInputElement).value.trim();
      const hash = await send({ address: DIRECTORY!, abi: payeeDirectoryAbi, functionName: "register", args: [name, site] });
      toast("Payee name registered", "ok");
      $("#payeeNow").innerHTML = `<span class="ok">✓ ${esc(name)}</span> · <a href="${txUrl(hash)}" target="_blank" rel="noopener">tx</a>`;
    });

  const form = $("#create") as HTMLFormElement;
  form.onsubmit = (ev) => {
    ev.preventDefault();
    busy($("#createBtn") as HTMLButtonElement, "Creating…", async () => {
      const f = new FormData(form);
      const payee = String(f.get("payee")).trim();
      if (!isAddress(payee)) throw new Error("Payee is not a valid address");
      const allowed = String(f.get("payer") || "").trim();
      if (allowed && !isAddress(allowed)) throw new Error("Allowed payer is not a valid address");
      const amount = parseUnits(String(f.get("amount")), TOKEN_DECIMALS);
      const dueTs = BigInt(Math.floor(new Date(String(f.get("due")) + "T23:59:59").getTime() / 1000));
      const memo = String(f.get("memo") || "").trim();
      const hash = await send({
        address: REGISTRY!,
        abi: invoiceRegistryAbi,
        functionName: "createInvoice",
        args: [getAddress(payee), amount, dueTs, memoHashOf(memo), allowed ? getAddress(allowed) : zeroAddress, !!f.get("partial")],
      });
      const rc = await pub.getTransactionReceipt({ hash });
      const id = BigInt(rc.logs.find((l) => l.address.toLowerCase() === REGISTRY!.toLowerCase())!.topics[1]!);
      const inv = (await readInvoice(id))!;
      const link = shareLink(id, inv.terms, memo);
      $("#created").innerHTML = `<div class="share"><b>Invoice #${id} created</b> · <a href="${txUrl(hash)}" target="_blank" rel="noopener">tx</a>
        <input readonly value="${esc(link)}" id="lnk"/><div class="row"><button type="button" class="btn small" id="cp">Copy pay link</button><a class="btn small ghost" href="${esc(link)}">Open pay page</a></div></div>`;
      $("#cp").onclick = () => navigator.clipboard.writeText(link).then(() => toast("Link copied", "ok"));
      toast(`Invoice #${id} created`, "ok");
      loadList(acc);
    });
  };
  $("#reload").onclick = () => loadList(acc);
  loadList(acc);
}

async function loadList(acc: Address) {
  const el = $("#list");
  if (!el) return;
  if (!DEPLOYED) return void (el.textContent = "Contracts not deployed in this build.");
  try {
    const ids = await merchantInvoiceIds(acc);
    if (!ids.length) return void (el.innerHTML = `No invoices yet.`);
    const invs = (await Promise.all(ids.slice(0, 30).map(readInvoice))).filter(Boolean) as Invoice[];
    el.innerHTML = `<table><thead><tr><th>#</th><th>Amount</th><th>Paid</th><th>Due</th><th>Status</th><th></th></tr></thead><tbody>
      ${invs
        .map(
          (i) => `<tr><td>${i.id}</td><td>${fmt(i.amount)}</td><td>${fmt(i.paid)}</td><td>${date(i.dueDate)}</td><td>${statusBadge(i)}</td>
        <td class="actions"><a href="#/receipt/${i.id}">Receipt</a>
        ${i.status === 1 && i.paid === 0n ? `<button class="link" data-cancel="${i.id}">Cancel</button>` : ""}
        ${i.paid > i.refunded ? `<button class="link" data-refund="${i.id}" data-max="${i.paid - i.refunded}">Refund</button>` : ""}
        </td></tr>`,
        )
        .join("")}</tbody></table>`;
    el.querySelectorAll<HTMLButtonElement>("[data-cancel]").forEach(
      (b) =>
        (b.onclick = () =>
          busy(b, "…", async () => {
            if (!confirm(`Cancel invoice #${b.dataset.cancel}? It can no longer be paid.`)) return;
            await send({ address: REGISTRY!, abi: invoiceRegistryAbi, functionName: "cancel", args: [BigInt(b.dataset.cancel!)] });
            toast("Invoice cancelled", "ok");
            loadList(acc);
          })),
    );
    el.querySelectorAll<HTMLButtonElement>("[data-refund]").forEach(
      (b) =>
        (b.onclick = () =>
          busy(b, "…", async () => {
            const max = BigInt(b.dataset.max!);
            const v = prompt(`Refund amount in ${TOKEN_SYMBOL} (max ${fmt(max)})`, formatUnits(max, TOKEN_DECIMALS));
            if (!v) return;
            const amt = parseUnits(v, TOKEN_DECIMALS);
            const allowance = await pub.readContract({ address: TUSD8, abi: erc20Abi, functionName: "allowance", args: [acc, REGISTRY!] });
            if (allowance < amt) await send({ address: TUSD8, abi: erc20Abi, functionName: "approve", args: [REGISTRY!, amt] });
            await send({ address: REGISTRY!, abi: invoiceRegistryAbi, functionName: "refund", args: [BigInt(b.dataset.refund!), amt] });
            toast("Refund sent to payer", "ok");
            loadList(acc);
          })),
    );
  } catch (e) {
    el.textContent = `Could not load invoices: ${errMsg(e)}`;
  }
}

// ---------------------------------------------------------------- pay
type Check = { ok: boolean | null; label: string; detail: string };

async function pay(idStr: string, q: URLSearchParams) {
  shell(`<section class="page-head"><h1>Pay invoice #${esc(idStr)}</h1></section><div id="body" class="card">Loading invoice from Aevum…</div>`);
  if (!DEPLOYED) return void ($("#body").textContent = "Contracts not deployed in this build.");
  let id: bigint;
  try {
    id = BigInt(idStr);
  } catch {
    return void ($("#body").textContent = "Invalid invoice id.");
  }
  const inv = await readInvoice(id).catch(() => null);
  if (!inv) return void ($("#body").innerHTML = `<p class="warn">Invoice #${esc(idStr)} does not exist on this registry.</p>`);

  const memo = q.get("memo") ?? "";
  const linkTerms = q.get("t");
  const acc = currentAccount();
  const now = BigInt(Math.floor(Date.now() / 1000));
  const remaining = inv.amount - inv.paid;
  const [payee, chainId, bal, code] = await Promise.all([
    payeeName(inv.payee),
    walletChainId().catch(() => null),
    acc ? balanceOf(acc) : Promise.resolve(null),
    pub.getCode({ address: REGISTRY! }),
  ]);

  const checks: Check[] = [
    { ok: chainId === null ? null : chainId === 44005, label: "Aevum Testnet (chain 44005)", detail: chainId === null ? "Connect a wallet to check" : chainId === 44005 ? "Wallet is on the right network" : `Wallet is on chain ${chainId}; it will be switched` },
    { ok: true, label: `Official ${TOKEN_SYMBOL} token`, detail: `Settles only in ${short(TUSD8)} (hard-coded in the registry)` },
    { ok: !!code && code !== "0x", label: "Registry contract", detail: `${short(REGISTRY!)} has bytecode on chain` },
    { ok: linkTerms ? inv.terms.toLowerCase().startsWith(linkTerms.toLowerCase()) : null, label: "Link matches on-chain terms", detail: linkTerms ? (inv.terms.toLowerCase().startsWith(linkTerms.toLowerCase()) ? "Amount, payee, due date and memo are what the merchant issued" : "The link was altered or points at a different invoice") : "Link has no terms fingerprint; you are paying the on-chain terms shown below" },
    { ok: !!payee, label: "Verified payee", detail: payee ? `${payee.name} · on-chain since ${date(payee.since)}` : "Payee has not registered a business name; confirm the address out of band" },
    { ok: memoHashOf(memo) === inv.memoHash, label: "Memo integrity", detail: memoHashOf(memo) === inv.memoHash ? (memo ? "Memo text matches the hash stored on chain" : "No memo") : "Memo in the link differs from what the merchant committed" },
    { ok: inv.status === 1 && now <= inv.dueDate, label: "Open and not expired", detail: inv.status !== 1 ? `Invoice is ${STATUS[inv.status]}` : now > inv.dueDate ? `Expired on ${date(inv.dueDate)}` : `Due ${date(inv.dueDate)}` },
    { ok: inv.allowedPayer === zeroAddress ? true : acc ? acc.toLowerCase() === inv.allowedPayer.toLowerCase() : null, label: "Payer allowed", detail: inv.allowedPayer === zeroAddress ? "Anyone may pay" : `Only ${short(inv.allowedPayer)} may pay` },
  ];
  if (acc && bal !== null) checks.push({ ok: bal >= remaining, label: "Sufficient balance", detail: `You hold ${fmt(bal)} ${TOKEN_SYMBOL}` });

  const hardFail = checks.some((c) => c.ok === false && /Open|Link|Memo|Payer allowed|Registry/.test(c.label));
  const fee = (remaining * BigInt(inv.feeBps)) / 10_000n;

  $("#body").outerHTML = `
  <div class="cols">
    <div class="card invoice">
      <div class="inv-head"><div><p class="muted small">INVOICE</p><h2>#${inv.id}</h2></div>${statusBadge(inv)}</div>
      <p class="amount">${fmt(inv.amount)} <span>${TOKEN_SYMBOL}</span></p>
      <dl>
        <dt>Pay to</dt><dd>${payee ? `<b>${esc(payee.name)}</b> <span class="ok">✓ verified</span><br/>` : `<span class="warn">Unverified payee</span><br/>`}<a href="${addrUrl(inv.payee)}" target="_blank" rel="noopener" class="mono">${inv.payee}</a></dd>
        <dt>Memo</dt><dd>${memo ? esc(memo) : `<span class="muted">none</span>`}</dd>
        <dt>Due</dt><dd>${date(inv.dueDate)}</dd>
        ${inv.paid > 0n ? `<dt>Already paid</dt><dd>${fmt(inv.paid)} ${TOKEN_SYMBOL}</dd>` : ""}
        <dt>Remaining</dt><dd>${fmt(remaining)} ${TOKEN_SYMBOL}${inv.allowPartial ? " · partial payments allowed" : ""}</dd>
        <dt>Protocol fee</dt><dd>${inv.feeBps / 100}% (${fmt(fee)} ${TOKEN_SYMBOL}, included; payee receives ${fmt(remaining - fee)})</dd>
        <dt>Terms hash</dt><dd class="mono small">${inv.terms}</dd>
      </dl>
    </div>
    <div class="card">
      <h2>Safety checks</h2>
      <ul class="checklist">${checks
        .map((c) => `<li class="${c.ok === true ? "pass" : c.ok === false ? "fail" : "unk"}"><span class="ic">${c.ok === true ? "✓" : c.ok === false ? "✕" : "?"}</span><div><b>${esc(c.label)}</b><p>${esc(c.detail)}</p></div></li>`)
        .join("")}</ul>
      ${
        inv.status !== 1
          ? `<a class="btn" href="#/receipt/${inv.id}">View receipt</a>`
          : !acc
            ? `<button class="btn wide" id="cpay">Connect wallet to pay</button>`
            : hardFail
              ? `<p class="warn">Payment disabled: a safety check failed.</p>`
              : `${inv.allowPartial ? `<label>Amount to pay (${TOKEN_SYMBOL})<input id="pamt" type="number" step="0.000001" value="${formatUnits(remaining, TOKEN_DECIMALS)}"/></label>` : ""}
                 <button class="btn wide" id="paybtn">Pay ${fmt(remaining)} ${TOKEN_SYMBOL}</button>
                 <p class="muted small center">One permit signature + one transaction. Falls back to approve + pay if your wallet can't sign typed data.</p>`
      }
      <div id="payres"></div>
    </div>
  </div>`;

  if ($("#cpay")) $("#cpay").onclick = () => connect().then(route).catch((e) => toast(errMsg(e), "err"));
  if ($("#paybtn"))
    $("#paybtn").onclick = () =>
      busy($("#paybtn") as HTMLButtonElement, "Waiting for wallet…", async () => {
        await ensureChain();
        const amt = inv.allowPartial ? parseUnits(($("#pamt") as HTMLInputElement).value, TOKEN_DECIMALS) : remaining;
        const hash = await payInvoice(inv, amt);
        $("#payres").innerHTML = `<p class="ok">✓ Paid. <a href="${txUrl(hash)}" target="_blank" rel="noopener">View transaction</a> · <a href="#/receipt/${inv.id}">Receipt</a></p>`;
        toast("Payment confirmed on Aevum", "ok");
        setTimeout(() => (location.hash = `#/receipt/${inv.id}`), 1500);
      });
}

async function payInvoice(inv: Invoice, amount: bigint): Promise<Hex> {
  const acc = currentAccount()!;
  const allowance = await pub.readContract({ address: TUSD8, abi: erc20Abi, functionName: "allowance", args: [acc, REGISTRY!] });
  if (allowance >= amount) {
    return send({ address: REGISTRY!, abi: invoiceRegistryAbi, functionName: "pay", args: [inv.id, inv.terms, amount] });
  }
  // EIP-2612 permit path (tUSD8 exposes permit / nonces / DOMAIN_SEPARATOR, domain name "tUSD8" version "2")
  try {
    const [nonce, name, version] = await Promise.all([
      pub.readContract({ address: TUSD8, abi: erc20Abi, functionName: "nonces", args: [acc] }),
      pub.readContract({ address: TUSD8, abi: erc20Abi, functionName: "name" }),
      pub.readContract({ address: TUSD8, abi: erc20Abi, functionName: "version" }),
    ]);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
    const sig = await w().signTypedData({
      account: w().account,
      domain: { name, version, chainId: 44005, verifyingContract: TUSD8 },
      types: { Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ] },
      primaryType: "Permit",
      message: { owner: acc, spender: REGISTRY!, value: amount, nonce, deadline },
    });
    const { r, s, v, yParity } = parseSignature(sig);
    return await send({
      address: REGISTRY!,
      abi: invoiceRegistryAbi,
      functionName: "payWithPermit",
      args: [inv.id, inv.terms, amount, deadline, Number(v ?? BigInt(27 + (yParity ?? 0))), r, s],
    });
  } catch (e: any) {
    if (/reject|denied/i.test(String(e?.message))) throw e;
    toast("Permit unavailable, using approve + pay", "info");
    await send({ address: TUSD8, abi: erc20Abi, functionName: "approve", args: [REGISTRY!, amount] });
    return send({ address: REGISTRY!, abi: invoiceRegistryAbi, functionName: "pay", args: [inv.id, inv.terms, amount] });
  }
}

// ---------------------------------------------------------------- receipt
async function receipt(idStr?: string) {
  shell(`<section class="page-head"><h1>Receipt</h1><p class="muted">Rebuilt from on-chain events. Nothing here comes from a server.</p></section>
    <form class="card lookup" id="lk"><input id="rid" placeholder="Invoice number, e.g. 1" value="${esc(idStr ?? "")}"/><button class="btn">Look up</button></form>
    <div id="rc"></div>`);
  ($("#lk") as HTMLFormElement).onsubmit = (e) => {
    e.preventDefault();
    location.hash = `#/receipt/${($("#rid") as HTMLInputElement).value.trim()}`;
  };
  if (!idStr) return;
  const el = $("#rc");
  if (!DEPLOYED) return void (el.innerHTML = `<div class="card">Contracts not deployed in this build.</div>`);
  el.innerHTML = `<div class="card">Reading events…</div>`;
  try {
    const id = BigInt(idStr);
    const inv = await readInvoice(id);
    if (!inv) return void (el.innerHTML = `<div class="card warn">Invoice #${esc(idStr)} not found.</div>`);
    const [tl, payee] = await Promise.all([invoiceTimeline(id), payeeName(inv.payee)]);
    const paidFees = tl.filter((t) => t.kind === "Paid").reduce((a, t) => a + (t.args.fee as bigint), 0n);
    el.innerHTML = `<div class="card receipt" id="printable">
      <div class="inv-head"><div><p class="muted small">AEVUMBILL RECEIPT</p><h2>Invoice #${inv.id}</h2></div>${statusBadge(inv)}</div>
      <dl>
        <dt>Payee</dt><dd>${payee ? `<b>${esc(payee.name)}</b> ✓<br/>` : ""}<span class="mono">${inv.payee}</span></dd>
        <dt>Merchant</dt><dd class="mono">${inv.merchant}</dd>
        <dt>Payer</dt><dd class="mono">${inv.payer === zeroAddress ? "—" : inv.payer}</dd>
        <dt>Invoice total</dt><dd>${fmt(inv.amount)} ${TOKEN_SYMBOL}</dd>
        <dt>Paid</dt><dd>${fmt(inv.paid)} ${TOKEN_SYMBOL} (fees ${fmt(paidFees)})</dd>
        ${inv.refunded > 0n ? `<dt>Refunded</dt><dd>${fmt(inv.refunded)} ${TOKEN_SYMBOL}</dd>` : ""}
        <dt>Memo hash</dt><dd class="mono small">${inv.memoHash}</dd>
        <dt>Terms hash</dt><dd class="mono small">${inv.terms}</dd>
      </dl>
      <h3>On-chain timeline</h3>
      <ol class="timeline">${tl
        .map(
          (t) => `<li><b>${t.kind}</b>${t.kind === "Paid" ? ` · ${fmt(t.args.amount)} ${TOKEN_SYMBOL} from ${short(t.args.payer)}` : ""}${t.kind === "Refunded" ? ` · ${fmt(t.args.amount)} ${TOKEN_SYMBOL} to ${short(t.args.to)}` : ""}
          <span class="muted"> · ${date(t.time)} · block ${t.block}</span><br/><a class="mono small" href="${txUrl(t.tx)}" target="_blank" rel="noopener">${t.tx}</a></li>`,
        )
        .join("")}</ol>
      <div class="row noprint"><button class="btn small" onclick="window.print()">Print / save PDF</button><a class="btn small ghost" href="${EXPLORER}/address/${REGISTRY}" target="_blank" rel="noopener">Registry on explorer</a></div>
    </div>`;
  } catch (e) {
    el.innerHTML = `<div class="card warn">${esc(errMsg(e))}</div>`;
  }
}

// ---------------------------------------------------------------- router
function route() {
  const h = location.hash.replace(/^#/, "") || "/";
  const [path, qs] = h.split("?");
  const parts = path.split("/").filter(Boolean);
  const q = new URLSearchParams(qs ?? "");
  window.scrollTo(0, 0);
  if (parts[0] === "merchant") return merchant();
  if (parts[0] === "pay" && parts[1]) return pay(parts[1], q);
  if (parts[0] === "receipt") return receipt(parts[1]);
  return home();
}
window.addEventListener("hashchange", route);
onWallet(route);
route();
