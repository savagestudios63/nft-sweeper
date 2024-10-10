import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import type { Listing } from "../types.js";

/**
 * Magic Eden M2 on-chain program — the actual marketplace program, NOT the web API.
 * Program: M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K
 *
 * The ME v2 "MIP-1" buy flow roughly mirrors Metaplex auction-house "execute_sale",
 * but with ME's own PDAs. Below we build an "Execute Sale V2" instruction.
 *
 * This file sketches the layout; integrators SHOULD pull the current IDL from
 * https://github.com/metaplex-foundation/ or ME's recent published IDLs and
 * use `@coral-xyz/anchor` to regenerate a typed client if the layout shifts.
 */

export const ME_PROGRAM_ID = new PublicKey("M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K");
export const ME_AUCTION_HOUSE = new PublicKey("E8WjS8qL3p6ZQ9kE2pD5DEgrskKvfVEz3d9cTb7MQW1e");
export const METAPLEX_METADATA = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

// Anchor discriminator for "executeSaleV2" in the ME IDL.
// Regenerate from the latest IDL if the program changes.
const EXECUTE_SALE_V2_DISC = Buffer.from([37, 74, 217, 157, 79, 49, 35, 6]);

export interface ExecuteSaleArgs {
  buyer: PublicKey;
  seller: PublicKey;
  tokenMint: PublicKey;
  priceLamports: bigint;
  tokenSize?: bigint;
  makerFeeBp?: number;
  takerFeeBp?: number;
}

export function buildBuyInstructions(args: ExecuteSaleArgs): TransactionInstruction[] {
  const ixs: TransactionInstruction[] = [];

  ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));

  // Buyer must hold an ATA for the mint to receive the NFT.
  const buyerAta = getAssociatedTokenAddressSync(args.tokenMint, args.buyer, true);
  ixs.push(
    createAssociatedTokenAccountIdempotentInstruction(
      args.buyer,
      buyerAta,
      args.buyer,
      args.tokenMint,
    ),
  );

  const sellerTokenAccount = getAssociatedTokenAddressSync(args.tokenMint, args.seller, true);

  // ME PDAs — escrow, buyer/seller trade states, program-as-signer.
  const [escrow] = PublicKey.findProgramAddressSync(
    [Buffer.from("m2"), ME_AUCTION_HOUSE.toBuffer(), args.buyer.toBuffer()],
    ME_PROGRAM_ID,
  );
  const [buyerTradeState] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("m2"),
      args.buyer.toBuffer(),
      ME_AUCTION_HOUSE.toBuffer(),
      args.tokenMint.toBuffer(),
      u64LE(args.priceLamports),
      u64LE(args.tokenSize ?? 1n),
    ],
    ME_PROGRAM_ID,
  );
  const [sellerTradeState] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("m2"),
      args.seller.toBuffer(),
      ME_AUCTION_HOUSE.toBuffer(),
      sellerTokenAccount.toBuffer(),
      args.tokenMint.toBuffer(),
      u64LE(args.priceLamports),
      u64LE(args.tokenSize ?? 1n),
    ],
    ME_PROGRAM_ID,
  );
  const [programAsSigner] = PublicKey.findProgramAddressSync(
    [Buffer.from("m2"), Buffer.from("signer")],
    ME_PROGRAM_ID,
  );
  const [metadata] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METAPLEX_METADATA.toBuffer(), args.tokenMint.toBuffer()],
    METAPLEX_METADATA,
  );

  const data = Buffer.concat([
    EXECUTE_SALE_V2_DISC,
    u64LE(args.priceLamports),
    u64LE(args.tokenSize ?? 1n),
    u16LE(args.makerFeeBp ?? 0),
    u16LE(args.takerFeeBp ?? 250), // ME's default taker fee ~2.5%
  ]);

  ixs.push(
    new TransactionInstruction({
      programId: ME_PROGRAM_ID,
      keys: [
        { pubkey: args.buyer, isSigner: true, isWritable: true },
        { pubkey: args.seller, isSigner: false, isWritable: true },
        { pubkey: args.tokenMint, isSigner: false, isWritable: false },
        { pubkey: metadata, isSigner: false, isWritable: false },
        { pubkey: sellerTokenAccount, isSigner: false, isWritable: true },
        { pubkey: buyerAta, isSigner: false, isWritable: true },
        { pubkey: escrow, isSigner: false, isWritable: true },
        { pubkey: buyerTradeState, isSigner: false, isWritable: true },
        { pubkey: sellerTradeState, isSigner: false, isWritable: true },
        { pubkey: ME_AUCTION_HOUSE, isSigner: false, isWritable: false },
        { pubkey: programAsSigner, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      ],
      data,
    }),
  );

  return ixs;
}

/**
 * Build a relist (sell) instruction at `newPriceLamports` using ME M2.
 * Used by the post-buy auto-relist path.
 */
export function buildRelistInstructions(opts: {
  seller: PublicKey;
  tokenMint: PublicKey;
  newPriceLamports: bigint;
  expirySec: number;
}): TransactionInstruction[] {
  // NB: Listing (sell) uses the "sellV2" discriminator. This is a simplified stub —
  // regenerate from IDL when productionizing.
  const SELL_V2_DISC = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);
  const tokenAccount = getAssociatedTokenAddressSync(opts.tokenMint, opts.seller, true);
  const [sellerTradeState] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("m2"),
      opts.seller.toBuffer(),
      ME_AUCTION_HOUSE.toBuffer(),
      tokenAccount.toBuffer(),
      opts.tokenMint.toBuffer(),
      u64LE(opts.newPriceLamports),
      u64LE(1n),
    ],
    ME_PROGRAM_ID,
  );
  const [programAsSigner] = PublicKey.findProgramAddressSync(
    [Buffer.from("m2"), Buffer.from("signer")],
    ME_PROGRAM_ID,
  );
  const data = Buffer.concat([
    SELL_V2_DISC,
    u64LE(opts.newPriceLamports),
    i64LE(BigInt(Math.floor(Date.now() / 1000) + opts.expirySec)),
  ]);
  return [
    new TransactionInstruction({
      programId: ME_PROGRAM_ID,
      keys: [
        { pubkey: opts.seller, isSigner: true, isWritable: true },
        { pubkey: opts.tokenMint, isSigner: false, isWritable: false },
        { pubkey: tokenAccount, isSigner: false, isWritable: true },
        { pubkey: ME_AUCTION_HOUSE, isSigner: false, isWritable: false },
        { pubkey: sellerTradeState, isSigner: false, isWritable: true },
        { pubkey: programAsSigner, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      ],
      data,
    }),
  ];
}

function u64LE(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n, 0);
  return b;
}
function i64LE(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(n, 0);
  return b;
}
function u16LE(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}
