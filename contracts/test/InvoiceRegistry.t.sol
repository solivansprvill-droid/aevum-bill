// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {InvoiceRegistry, IERC20Permit} from "../src/InvoiceRegistry.sol";
import {PayeeDirectory} from "../src/PayeeDirectory.sol";

/// @dev 6-decimal ERC-20 with EIP-2612 permit, mirroring tUSD8 (name "tUSD8", version "2").
contract MockUSD8 {
    string public constant name = "tUSD8";
    string public constant symbol = "tUSD8";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public nonces;
    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    constructor() {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("tUSD8"),
                keccak256("2"),
                block.chainid,
                address(this)
            )
        );
    }

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[to] += a;
        return true;
    }

    function permit(address o, address s, uint256 v, uint256 d, uint8 pv, bytes32 r, bytes32 ss) external {
        require(block.timestamp <= d, "expired");
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01", DOMAIN_SEPARATOR, keccak256(abi.encode(PERMIT_TYPEHASH, o, s, v, nonces[o]++, d))
            )
        );
        require(ecrecover(digest, pv, r, ss) == o, "bad sig");
        allowance[o][s] = v;
    }
}

contract InvoiceRegistryTest is Test {
    MockUSD8 usd;
    InvoiceRegistry reg;
    PayeeDirectory dir;

    address merchant = makeAddr("merchant");
    address treasury = makeAddr("treasury");
    address payer;
    uint256 payerPk;
    address stranger = makeAddr("stranger");

    bytes32 constant MEMO = keccak256("INV-001 website design");
    uint256 constant AMOUNT = 250e6; // 250 tUSD8

    function setUp() public {
        (payer, payerPk) = makeAddrAndKey("payer");
        usd = new MockUSD8();
        reg = new InvoiceRegistry(IERC20Permit(address(usd)), treasury, 30);
        dir = new PayeeDirectory();
        usd.mint(payer, 1_000_000e6);
        usd.mint(stranger, 1_000_000e6);
        usd.mint(merchant, 1_000_000e6);
        vm.warp(1_800_000_000);
    }

    function _create(uint256 amount, address allowed, bool partial_) internal returns (uint256 id, bytes32 terms) {
        vm.prank(merchant);
        id = reg.createInvoice(merchant, amount, uint64(block.timestamp + 7 days), MEMO, allowed, partial_);
        terms = reg.termsHash(id);
    }

    function _payAs(address who, uint256 id, bytes32 terms, uint256 amount) internal {
        vm.startPrank(who);
        usd.approve(address(reg), amount);
        reg.pay(id, terms, amount);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- happy paths
    function test_CreateAndPay_SplitsFee() public {
        (uint256 id, bytes32 terms) = _create(AMOUNT, address(0), false);
        uint256 mBefore = usd.balanceOf(merchant);
        _payAs(payer, id, terms, AMOUNT);
        uint256 fee = AMOUNT * 30 / 10_000; // 0.75 tUSD8
        assertEq(usd.balanceOf(treasury), fee);
        assertEq(usd.balanceOf(merchant) - mBefore, AMOUNT - fee);
        assertEq(uint8(reg.getInvoice(id).status), uint8(InvoiceRegistry.Status.Paid));
        assertEq(reg.getInvoice(id).payer, payer);
        assertEq(usd.balanceOf(address(reg)), 0, "registry is non-custodial");
    }

    function test_PayWithPermit() public {
        (uint256 id, bytes32 terms) = _create(AMOUNT, address(0), false);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                usd.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                        payer,
                        address(reg),
                        AMOUNT,
                        0,
                        deadline
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerPk, digest);
        vm.prank(payer);
        reg.payWithPermit(id, terms, AMOUNT, deadline, v, r, s);
        assertEq(uint8(reg.getInvoice(id).status), uint8(InvoiceRegistry.Status.Paid));
    }

    function test_PermitFrontRunDoesNotBrickPayment() public {
        (uint256 id, bytes32 terms) = _create(AMOUNT, address(0), false);
        vm.prank(payer);
        usd.approve(address(reg), AMOUNT); // allowance already there, junk permit sig ignored
        vm.prank(payer);
        reg.payWithPermit(id, terms, AMOUNT, block.timestamp, 27, bytes32(0), bytes32(0));
        assertEq(uint8(reg.getInvoice(id).status), uint8(InvoiceRegistry.Status.Paid));
    }

    function test_PartialPayments() public {
        (uint256 id, bytes32 terms) = _create(AMOUNT, address(0), true);
        _payAs(payer, id, terms, 100e6);
        assertEq(reg.remaining(id), 150e6);
        assertEq(uint8(reg.getInvoice(id).status), uint8(InvoiceRegistry.Status.Open));
        // only the first payer may continue
        vm.startPrank(stranger);
        usd.approve(address(reg), 150e6);
        vm.expectRevert(abi.encodeWithSelector(InvoiceRegistry.PayerNotAllowed.selector, stranger));
        reg.pay(id, terms, 150e6);
        vm.stopPrank();
        _payAs(payer, id, terms, 150e6);
        assertEq(uint8(reg.getInvoice(id).status), uint8(InvoiceRegistry.Status.Paid));
    }

    // ---------------------------------------------------------------- guards
    function test_RevertWhen_WrongAmount() public {
        (uint256 id, bytes32 terms) = _create(AMOUNT, address(0), false);
        vm.startPrank(payer);
        usd.approve(address(reg), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(InvoiceRegistry.WrongAmount.selector, AMOUNT, AMOUNT - 1));
        reg.pay(id, terms, AMOUNT - 1);
        vm.expectRevert(abi.encodeWithSelector(InvoiceRegistry.WrongAmount.selector, AMOUNT, AMOUNT + 1));
        reg.pay(id, terms, AMOUNT + 1);
        vm.stopPrank();
    }

    function test_RevertWhen_DoublePay() public {
        (uint256 id, bytes32 terms) = _create(AMOUNT, address(0), false);
        _payAs(payer, id, terms, AMOUNT);
        vm.startPrank(payer);
        usd.approve(address(reg), AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(InvoiceRegistry.InvoiceNotOpen.selector, InvoiceRegistry.Status.Paid));
        reg.pay(id, terms, AMOUNT);
        vm.stopPrank();
    }

    function test_RevertWhen_Cancelled() public {
        (uint256 id, bytes32 terms) = _create(AMOUNT, address(0), false);
        vm.prank(merchant);
        reg.cancel(id);
        vm.startPrank(payer);
        usd.approve(address(reg), AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(InvoiceRegistry.InvoiceNotOpen.selector, InvoiceRegistry.Status.Cancelled)
        );
        reg.pay(id, terms, AMOUNT);
        vm.stopPrank();
    }

    function test_RevertWhen_Expired() public {
        (uint256 id, bytes32 terms) = _create(AMOUNT, address(0), false);
        vm.warp(block.timestamp + 7 days + 1);
        assertTrue(reg.isExpired(id));
        vm.startPrank(payer);
        usd.approve(address(reg), AMOUNT);
        vm.expectRevert();
        reg.pay(id, terms, AMOUNT);
        vm.stopPrank();
    }

    function test_RevertWhen_WrongInvoice() public {
        (uint256 id1, bytes32 terms1) = _create(AMOUNT, address(0), false);
        (uint256 id2,) = _create(AMOUNT, address(0), false);
        vm.startPrank(payer);
        usd.approve(address(reg), AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(InvoiceRegistry.TermsMismatch.selector, reg.termsHash(id2), terms1));
        reg.pay(id2, terms1, AMOUNT); // terms reviewed for #1, sent to #2
        vm.stopPrank();
        assertTrue(id1 != id2);
    }

    function test_RevertWhen_NotAllowedPayer() public {
        (uint256 id, bytes32 terms) = _create(AMOUNT, payer, false);
        vm.startPrank(stranger);
        usd.approve(address(reg), AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(InvoiceRegistry.PayerNotAllowed.selector, stranger));
        reg.pay(id, terms, AMOUNT);
        vm.stopPrank();
        _payAs(payer, id, terms, AMOUNT);
    }

    function test_RevertWhen_CancelByStrangerOrAfterPayment() public {
        (uint256 id, bytes32 terms) = _create(AMOUNT, address(0), true);
        vm.prank(stranger);
        vm.expectRevert(InvoiceRegistry.NotMerchant.selector);
        reg.cancel(id);
        _payAs(payer, id, terms, 1e6);
        vm.prank(merchant);
        vm.expectRevert(InvoiceRegistry.AlreadyPaidPartially.selector);
        reg.cancel(id);
    }

    function test_RevertWhen_UnknownInvoice() public {
        vm.prank(payer);
        vm.expectRevert(InvoiceRegistry.UnknownInvoice.selector);
        reg.pay(42, bytes32(0), 1);
    }

    function test_RevertWhen_BadCreateParams() public {
        vm.startPrank(merchant);
        vm.expectRevert(InvoiceRegistry.ZeroAmount.selector);
        reg.createInvoice(merchant, 0, uint64(block.timestamp + 1), MEMO, address(0), false);
        vm.expectRevert(InvoiceRegistry.DueDateInPast.selector);
        reg.createInvoice(merchant, 1, uint64(block.timestamp), MEMO, address(0), false);
        vm.expectRevert(InvoiceRegistry.ZeroAddress.selector);
        reg.createInvoice(address(0), 1, uint64(block.timestamp + 1), MEMO, address(0), false);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- refunds
    function test_RefundPartialThenFull() public {
        (uint256 id, bytes32 terms) = _create(AMOUNT, address(0), false);
        _payAs(payer, id, terms, AMOUNT);
        uint256 before = usd.balanceOf(payer);
        vm.startPrank(merchant);
        usd.approve(address(reg), AMOUNT);
        reg.refund(id, 50e6);
        assertEq(uint8(reg.getInvoice(id).status), uint8(InvoiceRegistry.Status.Paid));
        vm.expectRevert(abi.encodeWithSelector(InvoiceRegistry.RefundTooLarge.selector, 200e6, 200e6 + 1));
        reg.refund(id, 200e6 + 1);
        reg.refund(id, 200e6);
        vm.stopPrank();
        assertEq(usd.balanceOf(payer) - before, AMOUNT);
        assertEq(uint8(reg.getInvoice(id).status), uint8(InvoiceRegistry.Status.Refunded));
    }

    function test_RevertWhen_RefundByStrangerOrUnpaid() public {
        (uint256 id,) = _create(AMOUNT, address(0), false);
        vm.prank(merchant);
        vm.expectRevert(InvoiceRegistry.NothingPaid.selector);
        reg.refund(id, 1);
        vm.prank(stranger);
        vm.expectRevert(InvoiceRegistry.NotMerchant.selector);
        reg.refund(id, 1);
    }

    // ---------------------------------------------------------------- admin
    function test_FeeCapAndSnapshot() public {
        vm.expectRevert(InvoiceRegistry.FeeTooHigh.selector);
        reg.setFee(101);
        (uint256 id, bytes32 terms) = _create(AMOUNT, address(0), false);
        reg.setFee(100); // raising the fee later must not affect the existing invoice
        assertEq(reg.termsHash(id), terms);
        _payAs(payer, id, terms, AMOUNT);
        assertEq(usd.balanceOf(treasury), AMOUNT * 30 / 10_000);
        vm.prank(stranger);
        vm.expectRevert(InvoiceRegistry.NotOwner.selector);
        reg.setFee(0);
    }

    function test_PauseBlocksPayButNotRefund() public {
        (uint256 id, bytes32 terms) = _create(AMOUNT, address(0), false);
        _payAs(payer, id, terms, AMOUNT);
        (uint256 id2, bytes32 terms2) = _create(AMOUNT, address(0), false);
        reg.setPaused(true);
        vm.startPrank(payer);
        usd.approve(address(reg), AMOUNT);
        vm.expectRevert(InvoiceRegistry.IsPaused.selector);
        reg.pay(id2, terms2, AMOUNT);
        vm.stopPrank();
        vm.startPrank(merchant);
        usd.approve(address(reg), AMOUNT);
        reg.refund(id, AMOUNT);
        vm.stopPrank();
    }

    function test_IndexesForFrontend() public {
        (uint256 id, bytes32 terms) = _create(AMOUNT, address(0), true);
        vm.roll(block.number + 5);
        _payAs(payer, id, terms, 1e6);
        vm.roll(block.number + 5);
        _payAs(payer, id, terms, AMOUNT - 1e6);
        assertEq(reg.invoicesOf(merchant).length, 1);
        assertEq(reg.invoicesPaidBy(payer)[0], id);
        uint64[] memory b = reg.eventBlocks(id);
        assertEq(b.length, 3);
        assertEq(b[2] - b[0], 10);
    }

    function test_TwoStepOwnership() public {
        reg.transferOwnership(stranger);
        assertEq(reg.owner(), address(this));
        vm.prank(stranger);
        reg.acceptOwnership();
        assertEq(reg.owner(), stranger);
    }

    // ---------------------------------------------------------------- fuzz
    function testFuzz_FullPaymentConservesValue(uint96 amount, uint16 bps) public {
        amount = uint96(bound(amount, 1, 1_000_000e6));
        bps = uint16(bound(bps, 0, 100));
        reg.setFee(bps);
        (uint256 id, bytes32 terms) = _create(amount, address(0), false);
        uint256 p0 = usd.balanceOf(payer);
        uint256 m0 = usd.balanceOf(merchant);
        uint256 t0 = usd.balanceOf(treasury);
        _payAs(payer, id, terms, amount);
        uint256 fee = usd.balanceOf(treasury) - t0;
        assertEq(p0 - usd.balanceOf(payer), amount);
        assertEq(usd.balanceOf(merchant) - m0 + fee, amount);
        assertLe(fee * 10_000, uint256(amount) * 100);
        assertEq(usd.balanceOf(address(reg)), 0);
    }

    function testFuzz_OnlyExactAmountAccepted(uint96 amount, uint96 attempt) public {
        amount = uint96(bound(amount, 1, 1_000_000e6));
        attempt = uint96(bound(attempt, 1, 1_000_000e6));
        vm.assume(attempt != amount);
        (uint256 id, bytes32 terms) = _create(amount, address(0), false);
        vm.startPrank(payer);
        usd.approve(address(reg), attempt);
        vm.expectRevert(abi.encodeWithSelector(InvoiceRegistry.WrongAmount.selector, amount, attempt));
        reg.pay(id, terms, attempt);
        vm.stopPrank();
    }

    function testFuzz_PartialNeverOverpays(uint96 amount, uint96 a, uint96 b) public {
        amount = uint96(bound(amount, 2, 1_000_000e6));
        a = uint96(bound(a, 1, amount - 1));
        b = uint96(bound(b, 1, 1_000_000e6));
        (uint256 id, bytes32 terms) = _create(amount, address(0), true);
        _payAs(payer, id, terms, a);
        uint256 due = uint256(amount) - a;
        vm.startPrank(payer);
        usd.approve(address(reg), b);
        if (b > due) {
            vm.expectRevert(abi.encodeWithSelector(InvoiceRegistry.Overpayment.selector, due, b));
            reg.pay(id, terms, b);
        } else {
            reg.pay(id, terms, b);
            assertEq(reg.getInvoice(id).paid, uint256(a) + b);
        }
        vm.stopPrank();
        assertLe(reg.getInvoice(id).paid, amount);
    }

    function testFuzz_TamperedTermsRejected(bytes32 forged) public {
        (uint256 id, bytes32 terms) = _create(AMOUNT, address(0), false);
        vm.assume(forged != terms);
        vm.startPrank(payer);
        usd.approve(address(reg), AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(InvoiceRegistry.TermsMismatch.selector, terms, forged));
        reg.pay(id, forged, AMOUNT);
        vm.stopPrank();
    }

    function testFuzz_RefundBoundedByPaid(uint96 amount, uint96 r1, uint96 r2) public {
        amount = uint96(bound(amount, 1, 1_000_000e6));
        (uint256 id, bytes32 terms) = _create(amount, address(0), false);
        _payAs(payer, id, terms, amount);
        r1 = uint96(bound(r1, 1, amount));
        r2 = uint96(bound(r2, 1, 2_000_000e6));
        vm.startPrank(merchant);
        usd.approve(address(reg), type(uint256).max);
        reg.refund(id, r1);
        uint256 left = uint256(amount) - r1;
        if (r2 > left) {
            vm.expectRevert();
            reg.refund(id, r2);
        } else {
            reg.refund(id, r2);
        }
        vm.stopPrank();
        assertLe(reg.getInvoice(id).refunded, reg.getInvoice(id).paid);
    }

    // ---------------------------------------------------------------- payee directory
    function test_DirectoryRegisterAndUniqueness() public {
        vm.prank(merchant);
        dir.register("Acme Design Ltd", "https://acme.example");
        assertTrue(dir.isRegistered(merchant));
        assertEq(dir.payeeOf(merchant).name, "Acme Design Ltd");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(PayeeDirectory.NameTaken.selector, merchant));
        dir.register("ACME DESIGN LTD", "");
        vm.prank(stranger);
        vm.expectRevert(PayeeDirectory.InvalidName.selector);
        dir.register("x", "");
        // rename frees the old name
        vm.prank(merchant);
        dir.register("Acme Studio", "");
        vm.prank(stranger);
        dir.register("Acme Design Ltd", "");
        assertEq(dir.nameOwner(dir.nameKey("acme design ltd")), stranger);
    }

    function testFuzz_DirectoryRejectsBadChars(uint8 c) public {
        vm.assume(!(c >= 0x30 && c <= 0x39) && !(c >= 0x41 && c <= 0x5a) && !(c >= 0x61 && c <= 0x7a));
        vm.assume(c != 0x20 && c != 0x2e && c != 0x26 && c != 0x27 && c != 0x2d);
        bytes memory n = abi.encodePacked("abc", bytes1(c), "def");
        vm.expectRevert(PayeeDirectory.InvalidName.selector);
        dir.register(string(n), "");
    }
}
