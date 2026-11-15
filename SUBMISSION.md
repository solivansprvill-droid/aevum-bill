# AevumBill · DoraHacks BUIDL submission

**Hackathon:** Aevum Builder Challenge #1 (QDay) · **Track:** Invoice Payments
**Repo:** https://github.com/solivansprvill-droid/aevum-bill · **Live demo:** https://solivansprvill-droid.github.io/aevum-bill/
**Network:** Aevum Testnet (chain 44005) · **Token:** tUSD8 `0x456569838f1d43009A91ebA4263147Afd7233483`

---

## BUIDL text (paste into DoraHacks)

### One-liner
AevumBill: on-chain tUSD8 invoices your client can't pay wrong. Exact amount, one payment, verified payee, on-chain receipt.

### What it does
AevumBill turns an invoice into a tamper-proof payment request on Aevum. A merchant issues an invoice (payee, amount in tUSD8, due date, memo, optional single allowed payer, optional partial payments) and shares a link. The payer's page runs eight safety checks before the Pay button unlocks: correct network, official tUSD8, live registry contract, link terms match the on-chain terms hash, **verified payee name**, memo integrity, open and not expired, and an allowed payer. Payment is one EIP-2612 permit signature plus one transaction, and the contract settles payer → payee directly (non-custodial) with a 0.3% fee to a treasury. Receipts are rebuilt from on-chain events and can be printed to PDF. Merchants can cancel unpaid invoices and refund paid ones, always to the original payer.

### Why it matters
Stablecoin invoicing today is "copy this address and amount", which invites redirection fraud, wrong amounts, double payments and painful reconciliation. AevumBill pushes the checks a careful accounts-payable clerk would make into the contract and the UI:
- **Wrong amount** → `WrongAmount` / `Overpayment`
- **Double payment / after cancel / after due date** → `InvoiceNotOpen` / `InvoiceExpired`
- **Paying a swapped or edited invoice** → every payment carries the `termsHash` the payer reviewed → `TermsMismatch`
- **Wrong payer** → optional `allowedPayer` → `PayerNotAllowed`
- **Redirection fraud** → `PayeeDirectory` confirmation of payee: unique business names that only the receiving key can write
- **Fee surprises** → fee snapshotted per invoice, hard-capped at 1%
- **Emergency** → pause blocks new invoices and payments, while cancels and refunds keep working

### How it's built
- `InvoiceRegistry.sol` + `PayeeDirectory.sol` (Solidity 0.8.24, zero external deps), Foundry: **26 tests incl. 7 fuzz properties × 1,000 runs**, 95% line coverage on the registry.
- On-chain indexes (`invoicesOf`, `eventBlocks`) so a pure static frontend works within the Aevum RPC's 1,000-block `getLogs` cap. No backend, no indexer.
- Vite + TypeScript + viem static app on GitHub Pages. It auto-adds chain 44005 to MetaMask / Rabby / OKX Wallet and uses the tUSD8 permit (domain `tUSD8`, version `2`, checked on-chain) with an approve + pay fallback.

### Aevum integration
Deployed on Aevum Testnet and settling in native-ecosystem tUSD8 with gasless-approval permits. Contract addresses and end-to-end transaction hashes are in the README "Deployments" section and `deployments/*.json`.

### Roadmap
Recurring invoices · KYB attestations for payee names · multi-token · accounting export · notifications · post-quantum signer support as Aevum ships it.

---

## Demo script (≤ 5 min) · English

**0:00–0:30 Problem.** "Paying an invoice in stablecoins means copying an address and an amount. One edited PDF and the money goes to a scammer, and a second click pays twice. AevumBill fixes this on Aevum."

**0:30–1:30 Merchant.** Open the live demo → *Merchant*. Connect wallet; the app adds Aevum Testnet automatically. Register the business name "AevumBill Demo Merchant" (show the tx). Create an invoice: 0.5 tUSD8, due in 7 days, memo "INV-0001 website design", allowed payer = the client's address. Click *Copy pay link*.

**1:30–3:00 Payer.** Open the link in the client's wallet. Walk through the eight green checks, especially **Verified payee** and **Link matches on-chain terms**. Edit one character of the memo in the URL and reload: *Memo integrity* turns red and Pay is disabled. Restore the link and press *Pay*. One permit signature, one transaction. Show the success toast and the explorer link.

**3:00–3:45 Guarantees.** Press Pay again: the invoice shows *Paid* and the contract would revert `InvoiceNotOpen`. Show the terminal output of `node web/scripts/e2e.mjs` with `WrongAmount`, `TermsMismatch`, `PayerNotAllowed` and double-pay all blocked, then `forge test` with 26 passing tests including fuzzing.

**3:45–4:30 Receipt and refund.** Open *Receipt #1*: status, fee, payer, terms hash, and a timeline of on-chain events with tx links. *Print / save PDF*. Back in the dashboard, refund 0.1 tUSD8, which goes to the original payer only.

**4:30–5:00 Wrap-up.** "Non-custodial, no backend, every rule enforced on Aevum. Next: recurring invoices and KYB-attested payee names."

## 演示脚本（≤5 分钟）· 中文

**0:00–0:30 痛点。** “用稳定币付发票，基本就是复制一个地址、填一个金额。PDF 被改一下，钱就进了骗子口袋；多点一次，就付了两遍。AevumBill 在 Aevum 上解决这些问题。”

**0:30–1:30 商家端。** 打开在线 Demo → *Merchant*。连接钱包，应用会自动添加 Aevum 测试网。注册商户名称 “AevumBill Demo Merchant”（展示交易）。创建发票：0.5 tUSD8，7 天后到期，备注 “INV-0001 website design”，指定付款方为客户地址。点击 *Copy pay link*。

**1:30–3:00 付款端。** 用客户钱包打开链接。逐条讲解 8 项绿色安全检查，重点是 **Verified payee（已验证收款方）** 和 **Link matches on-chain terms（链接与链上条款一致）**。把 URL 里备注改掉一个字符再刷新：*Memo integrity* 变红，付款按钮被禁用。改回原链接后点 *Pay*，一次 permit 签名加一笔交易即可完成。展示成功提示和区块浏览器链接。

**3:00–3:45 安全保证。** 再点一次付款：发票已是 *Paid*，合约会以 `InvoiceNotOpen` 回滚。展示 `node web/scripts/e2e.mjs` 的终端输出：金额错误（`WrongAmount`）、条款被篡改（`TermsMismatch`）、非指定付款人（`PayerNotAllowed`）和重复付款全部被拦截。再展示 `forge test` 的 26 个测试（含模糊测试）全部通过。

**3:45–4:30 收据与退款。** 打开 *Receipt #1*：状态、手续费、付款方、条款哈希，以及带交易链接的链上事件时间线，可 *打印 / 保存 PDF*。回到商家后台退款 0.1 tUSD8，资金只会退回原付款方。

**4:30–5:00 总结。** “非托管、无后端，所有规则都由 Aevum 上的合约强制执行。下一步：周期性发票，以及经 KYB 认证的收款方名称。”
