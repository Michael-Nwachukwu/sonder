// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

interface ICTF {
    function balanceOf(
        address account,
        uint256 id
    ) external view returns (uint256);

    function safeTransferFrom(
        address from,
        address to,
        uint256 id,
        uint256 amount,
        bytes calldata data
    ) external;

    function isApprovedForAll(
        address account,
        address operator
    ) external view returns (bool);

    // The CTF operator/admin can call mintBatch
    function mintBatch(
        address to,
        uint256[] calldata ids,
        uint256[] calldata amounts,
        bytes calldata data
    ) external;
}

/**
 * @title MintTestTokens
 * @notice Mints Polymarket YES tokens to a test address using Tenderly's prank/impersonation.
 *
 * Usage (Tenderly fork):
 *   forge script script/MintTestTokens.s.sol --rpc-url $TENDERLY_RPC_URL --broadcast
 */
contract MintTestTokens is Script {
    // Polymarket CTF contract on Polygon
    ICTF constant CTF = ICTF(0x4D97DCd97eC945f40cF65F87097ACe5EA0476045);

    // Alice — the test borrower
    address constant ALICE = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;

    // YES token ID for "Will the US confirm that aliens exist before 2027?"
    uint256 constant YES_TOKEN_ID =
        107505882767731489358349912513945399560393482969656700824895970500493757150417;

    // The CTF uses Gnosis ConditionalTokens. The operator who can mint is the Polymarket operator.
    // On Tenderly we can impersonate any address, so we impersonate the contract itself
    // (most CTF implementations allow the contract admin to mint via prank).
    address constant CTF_OPERATOR = 0x4D97DCd97eC945f40cF65F87097ACe5EA0476045;

    function run() external {
        uint256 deployerKey = vm.envUint("CRE_ETH_PRIVATE_KEY");

        console.log(
            "Checking Alice's current YES token balance before mint..."
        );
        uint256 before = CTF.balanceOf(ALICE, YES_TOKEN_ID);
        console.log("Alice YES before:", before);

        // On Tenderly forks, vm.prank + vm.broadcast lets us impersonate any address
        // Since Gnosis CTF doesn't have an open mint(), we use vm.deal + Tenderly-specific
        // tenderly_setStorageAt to directly write the ERC1155 balance slot.
        // The balance storage slot for ERC1155 in OpenZeppelin is:
        //   keccak256(abi.encodePacked(account, keccak256(abi.encodePacked(id, slot_0))))
        // where slot_0 = 0 (_balances mapping)

        bytes32 innerHash = keccak256(
            abi.encodePacked(YES_TOKEN_ID, uint256(0))
        );
        bytes32 balanceSlot = keccak256(
            abi.encodePacked(uint256(uint160(ALICE)), innerHash)
        );

        // 100 YES tokens (18 decimals, but CTF uses no decimals — each share is 1e6 USDC worth at $1)
        // Polymarket positions are in units where 1 share = 1 USDC conditional value
        // We'll mint 1000 shares (represented as raw uint256 = 1000)
        uint256 mintAmount = 1000;

        console.log(
            "Setting Alice's YES token balance via storage slot manipulation..."
        );
        console.log("Balance slot:", uint256(balanceSlot));

        vm.startBroadcast(deployerKey);

        // Use Foundry's store cheatcode to write the balance slot directly
        vm.store(address(CTF), balanceSlot, bytes32(mintAmount));

        vm.stopBroadcast();

        uint256 after_ = CTF.balanceOf(ALICE, YES_TOKEN_ID);
        console.log("Alice YES after:", after_);
        require(after_ == mintAmount, "Minting failed!");
        console.log("SUCCESS! Alice now has", mintAmount, "YES tokens");
    }
}
