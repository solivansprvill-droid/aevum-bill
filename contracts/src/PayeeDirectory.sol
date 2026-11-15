// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title AevumBill PayeeDirectory ("confirmation of payee")
/// @notice A merchant binds a human-readable business name to its own address by sending a transaction from that
///         address. Because the record can only be written by the key that receives funds, a payer's wallet can show
///         "Verified payee: <name>" for the exact address it is about to pay, the on-chain analogue of the UK
///         "Confirmation of Payee" check that cuts invoice-redirection fraud.
/// @dev    Names are unique (case-insensitive ASCII), so an impostor cannot register a look-alike with the same name.
contract PayeeDirectory {
    struct Payee {
        string name;
        string website;
        uint64 registeredAt;
        uint64 updatedAt;
    }

    mapping(address => Payee) private _payees;
    mapping(bytes32 => address) public nameOwner; // normalised name hash -> address

    event PayeeRegistered(address indexed payee, string name, string website, bytes32 indexed nameKey);
    event PayeeRemoved(address indexed payee, bytes32 indexed nameKey);

    error InvalidName();
    error NameTaken(address owner);
    error NotRegistered();

    function register(string calldata name, string calldata website) external {
        bytes32 key = nameKey(name);
        address current = nameOwner[key];
        if (current != address(0) && current != msg.sender) revert NameTaken(current);

        Payee storage p = _payees[msg.sender];
        if (p.registeredAt != 0) {
            bytes32 oldKey = nameKey(p.name);
            if (oldKey != key) delete nameOwner[oldKey];
        } else {
            p.registeredAt = uint64(block.timestamp);
        }
        p.name = name;
        p.website = website;
        p.updatedAt = uint64(block.timestamp);
        nameOwner[key] = msg.sender;
        emit PayeeRegistered(msg.sender, name, website, key);
    }

    function remove() external {
        Payee storage p = _payees[msg.sender];
        if (p.registeredAt == 0) revert NotRegistered();
        bytes32 key = nameKey(p.name);
        delete nameOwner[key];
        delete _payees[msg.sender];
        emit PayeeRemoved(msg.sender, key);
    }

    function payeeOf(address who) external view returns (Payee memory) {
        return _payees[who];
    }

    function isRegistered(address who) external view returns (bool) {
        return _payees[who].registeredAt != 0;
    }

    /// @notice 3-40 chars of [A-Za-z0-9 .&'-], lower-cased before hashing so "ACME" and "acme" collide.
    function nameKey(string memory name) public pure returns (bytes32) {
        bytes memory b = bytes(name);
        if (b.length < 3 || b.length > 40) revert InvalidName();
        if (b[0] == 0x20 || b[b.length - 1] == 0x20) revert InvalidName();
        bytes memory out = new bytes(b.length);
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            bool ok = (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x7a) || c == 0x20 || c == 0x2e || c == 0x26
                || c == 0x27 || c == 0x2d;
            if (c >= 0x41 && c <= 0x5a) {
                c = bytes1(uint8(c) + 32);
                ok = true;
            }
            if (!ok) revert InvalidName();
            out[i] = c;
        }
        return keccak256(out);
    }
}
