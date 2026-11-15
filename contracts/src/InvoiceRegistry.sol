// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Minimal ERC-20 + EIP-2612 surface used by the registry.
interface IERC20Permit {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}

/// @title AevumBill InvoiceRegistry
/// @notice Non-custodial on-chain invoices settled in a single stablecoin (tUSD8 on Aevum Testnet).
///         Funds move payer -> payee (+ optional fee -> treasury) inside the pay transaction; the
///         registry never holds balances, so there is nothing to drain.
/// @dev    Safety model:
///         - every invoice is bound to a `termsHash` (chain id, registry, id, payee, amount, due date, memo hash,
///           allowed payer, partial flag, fee). The payer passes the hash they reviewed, so a stale link, a
///           swapped invoice id or a merchant-side edit can never be paid by accident ("wrong invoice" guard);
///         - exact-amount payments, no overpayment, no double payment, no payment after cancel/expiry;
///         - the fee rate is snapshotted at creation and capped at 1%;
///         - refunds are pulled from the merchant's wallet back to the recorded payer and can never exceed what was paid.
contract InvoiceRegistry {
    // ------------------------------------------------------------------ types
    enum Status {
        None,
        Open,
        Paid,
        Cancelled,
        Refunded
    }

    struct Invoice {
        address merchant; // creator, may cancel / refund
        address payee; // receives funds
        address allowedPayer; // address(0) = anyone
        address payer; // first payer, locked for partial payments and refunds
        uint128 amount; // total due, token units
        uint128 paid; // gross amount paid so far
        uint128 refunded; // amount refunded so far
        uint64 dueDate; // unix seconds, payment rejected after this
        uint64 createdAt;
        uint16 feeBps; // fee snapshot at creation
        bool allowPartial;
        Status status;
        bytes32 memoHash; // keccak256(utf8 memo) - memo text travels in the share link
    }

    // ------------------------------------------------------------------ constants / storage
    uint16 public constant MAX_FEE_BPS = 100; // 1% hard cap
    uint16 public constant DEFAULT_FEE_BPS = 30; // 0.3%

    IERC20Permit public immutable token;
    address public owner;
    address public pendingOwner;
    address public treasury;
    uint16 public feeBps;
    bool public paused;

    uint256 public invoiceCount;
    mapping(uint256 => Invoice) private _invoices;
    /// @dev Lightweight on-chain index so a static frontend never has to scan logs (public RPC caps getLogs at
    ///      1,000 blocks): merchant/payer invoice lists and the blocks holding each invoice's events.
    mapping(address => uint256[]) private _byMerchant;
    mapping(address => uint256[]) private _byPayer;
    mapping(uint256 => uint64[]) private _eventBlocks;
    uint256 private _lock = 1;

    // ------------------------------------------------------------------ events
    event InvoiceCreated(
        uint256 indexed id,
        address indexed merchant,
        address indexed payee,
        uint256 amount,
        uint64 dueDate,
        bytes32 memoHash,
        address allowedPayer,
        bool allowPartial,
        uint16 feeBps,
        bytes32 termsHash
    );
    event InvoicePaid(
        uint256 indexed id,
        address indexed payer,
        address indexed payee,
        uint256 amount,
        uint256 fee,
        uint256 totalPaid,
        bool fullyPaid
    );
    event InvoiceCancelled(uint256 indexed id, address indexed merchant);
    event InvoiceRefunded(uint256 indexed id, address indexed to, uint256 amount, uint256 totalRefunded);
    event FeeUpdated(uint16 feeBps);
    event TreasuryUpdated(address treasury);
    event PausedSet(bool paused);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ------------------------------------------------------------------ errors
    error NotOwner();
    error NotMerchant();
    error ZeroAddress();
    error ZeroAmount();
    error AmountTooLarge();
    error FeeTooHigh();
    error DueDateInPast();
    error UnknownInvoice();
    error InvoiceNotOpen(Status status);
    error InvoiceExpired(uint64 dueDate);
    error TermsMismatch(bytes32 expected, bytes32 provided);
    error PayerNotAllowed(address payer);
    error WrongAmount(uint256 expected, uint256 provided);
    error Overpayment(uint256 remaining, uint256 provided);
    error RefundTooLarge(uint256 refundable, uint256 requested);
    error NothingPaid();
    error AlreadyPaidPartially();
    error IsPaused();
    error Reentrancy();
    error TransferFailed();

    // ------------------------------------------------------------------ modifiers
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(IERC20Permit token_, address treasury_, uint16 feeBps_) {
        if (address(token_) == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        token = token_;
        treasury = treasury_;
        feeBps = feeBps_;
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        emit TreasuryUpdated(treasury_);
        emit FeeUpdated(feeBps_);
    }

    // ------------------------------------------------------------------ merchant actions
    /// @notice Create an invoice. Returns the new invoice id (ids start at 1).
    function createInvoice(
        address payee,
        uint256 amount,
        uint64 dueDate,
        bytes32 memoHash,
        address allowedPayer,
        bool allowPartial
    ) external returns (uint256 id) {
        if (paused) revert IsPaused();
        if (payee == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > type(uint128).max) revert AmountTooLarge();
        if (dueDate <= block.timestamp) revert DueDateInPast();

        id = ++invoiceCount;
        Invoice storage inv = _invoices[id];
        inv.merchant = msg.sender;
        inv.payee = payee;
        inv.allowedPayer = allowedPayer;
        inv.amount = uint128(amount);
        inv.dueDate = dueDate;
        inv.createdAt = uint64(block.timestamp);
        inv.feeBps = feeBps;
        inv.allowPartial = allowPartial;
        inv.status = Status.Open;
        inv.memoHash = memoHash;
        _byMerchant[msg.sender].push(id);
        _eventBlocks[id].push(uint64(block.number));

        emit InvoiceCreated(
            id, msg.sender, payee, amount, dueDate, memoHash, allowedPayer, allowPartial, inv.feeBps, termsHash(id)
        );
    }

    /// @notice Cancel an unpaid invoice. Not possible once any payment arrived (use refund instead).
    function cancel(uint256 id) external {
        Invoice storage inv = _get(id);
        if (msg.sender != inv.merchant) revert NotMerchant();
        if (inv.status != Status.Open) revert InvoiceNotOpen(inv.status);
        if (inv.paid != 0) revert AlreadyPaidPartially();
        inv.status = Status.Cancelled;
        _eventBlocks[id].push(uint64(block.number));
        emit InvoiceCancelled(id, msg.sender);
    }

    /// @notice Refund (part of) a paid invoice. Tokens are pulled from the merchant's wallet and sent back to the
    ///         recorded payer, so the merchant must `approve` the registry first. Fully refunded => status Refunded.
    function refund(uint256 id, uint256 amount) external nonReentrant {
        Invoice storage inv = _get(id);
        if (msg.sender != inv.merchant) revert NotMerchant();
        if (inv.paid == 0) revert NothingPaid();
        if (amount == 0) revert ZeroAmount();
        uint256 refundable = uint256(inv.paid) - inv.refunded;
        if (amount > refundable) revert RefundTooLarge(refundable, amount);

        inv.refunded += uint128(amount);
        if (inv.refunded == inv.paid) {
            inv.status = Status.Refunded;
        }
        _eventBlocks[id].push(uint64(block.number));
        _pull(msg.sender, inv.payer, amount);
        emit InvoiceRefunded(id, inv.payer, amount, inv.refunded);
    }

    // ------------------------------------------------------------------ payer actions
    /// @notice Pay `amount` towards invoice `id`. Requires a prior `approve(registry, amount)`.
    /// @param expectedTerms the termsHash the payer reviewed (from the share link / UI).
    function pay(uint256 id, bytes32 expectedTerms, uint256 amount) external nonReentrant {
        _pay(id, expectedTerms, amount);
    }

    /// @notice Same as `pay` but authorises the spend with an EIP-2612 permit signature in the same transaction.
    function payWithPermit(
        uint256 id,
        bytes32 expectedTerms,
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        // A front-run permit must not brick the payment: ignore a failure and let transferFrom decide.
        try token.permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        _pay(id, expectedTerms, amount);
    }

    // ------------------------------------------------------------------ views
    function getInvoice(uint256 id) external view returns (Invoice memory) {
        return _invoices[id];
    }

    /// @notice Effective status (an Open invoice past its due date reports as expired via `isExpired`).
    function isExpired(uint256 id) public view returns (bool) {
        Invoice storage inv = _invoices[id];
        return inv.status == Status.Open && block.timestamp > inv.dueDate;
    }

    function invoicesOf(address merchant) external view returns (uint256[] memory) {
        return _byMerchant[merchant];
    }

    function invoicesPaidBy(address payer) external view returns (uint256[] memory) {
        return _byPayer[payer];
    }

    /// @notice Block numbers that contain this invoice's events (create, each payment, cancel, each refund).
    function eventBlocks(uint256 id) external view returns (uint64[] memory) {
        return _eventBlocks[id];
    }

    function remaining(uint256 id) external view returns (uint256) {
        Invoice storage inv = _invoices[id];
        if (inv.status != Status.Open) return 0;
        return uint256(inv.amount) - inv.paid;
    }

    function quoteFee(uint256 id, uint256 amount) public view returns (uint256) {
        return amount * _invoices[id].feeBps / 10_000;
    }

    /// @notice Commitment to every term a payer should check before paying.
    function termsHash(uint256 id) public view returns (bytes32) {
        Invoice storage inv = _invoices[id];
        return keccak256(
            abi.encode(
                block.chainid,
                address(this),
                id,
                inv.merchant,
                inv.payee,
                inv.amount,
                inv.dueDate,
                inv.memoHash,
                inv.allowedPayer,
                inv.allowPartial,
                inv.feeBps
            )
        );
    }

    // ------------------------------------------------------------------ admin
    function setFee(uint16 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = newFeeBps;
        emit FeeUpdated(newFeeBps);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    /// @notice Emergency brake: blocks new invoices and payments. Cancels and refunds keep working.
    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ------------------------------------------------------------------ internals
    function _pay(uint256 id, bytes32 expectedTerms, uint256 amount) internal {
        if (paused) revert IsPaused();
        Invoice storage inv = _get(id);
        if (inv.status != Status.Open) revert InvoiceNotOpen(inv.status);
        if (block.timestamp > inv.dueDate) revert InvoiceExpired(inv.dueDate);
        bytes32 terms = termsHash(id);
        if (terms != expectedTerms) revert TermsMismatch(terms, expectedTerms);
        if (inv.allowedPayer != address(0) && msg.sender != inv.allowedPayer) revert PayerNotAllowed(msg.sender);
        if (inv.payer != address(0) && msg.sender != inv.payer) revert PayerNotAllowed(msg.sender);
        if (amount == 0) revert ZeroAmount();

        uint256 due = uint256(inv.amount) - inv.paid;
        if (inv.allowPartial) {
            if (amount > due) revert Overpayment(due, amount);
        } else if (amount != due) {
            revert WrongAmount(due, amount);
        }

        // effects
        if (inv.payer == address(0)) {
            inv.payer = msg.sender;
            _byPayer[msg.sender].push(id);
        }
        _eventBlocks[id].push(uint64(block.number));
        inv.paid += uint128(amount);
        bool full = inv.paid == inv.amount;
        if (full) inv.status = Status.Paid;

        // interactions: payer -> payee (net) and payer -> treasury (fee)
        uint256 fee = amount * inv.feeBps / 10_000;
        _pull(msg.sender, inv.payee, amount - fee);
        if (fee != 0) _pull(msg.sender, treasury, fee);

        emit InvoicePaid(id, msg.sender, inv.payee, amount, fee, inv.paid, full);
    }

    function _get(uint256 id) internal view returns (Invoice storage inv) {
        inv = _invoices[id];
        if (inv.status == Status.None) revert UnknownInvoice();
    }

    function _pull(address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) =
            address(token).call(abi.encodeCall(IERC20Permit.transferFrom, (from, to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
