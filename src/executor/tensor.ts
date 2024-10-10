import {
  ComputeBudgetProgram,
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

/**
 * Tensor's TensorSwap / TCOMP programs. Core listing program:
 *   TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN  (TensorSwap)
 *   TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp  (TCOMP for compressed)
 *
 * Buy-single-listing instruction takes the seller's listing PDA and moves
 * lamports buyer->seller while transferring the NFT.
 *
 * This is a sketch — regenerate against Tensor's public IDL for production.
 */

export const TENSORSWAP_PROGRAM_ID = new PublicKey("TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN");
export const TENSOR_WHITELIST_PROGRAM_ID = new PublicKey("TL1ST2iRBzuGTqLn1KXnGdSnEow62BzPnGiqyRXhWtW");
export const METAPLEX_METADATA = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

// Discriminator for `buy_single_listing` from the TensorSwap IDL.
const BUY_SINGLE_DISC = Buffer.from([230, 176, 247, 217, 236, 145, 2, 108]);
const LIST_DISC       = Buffer.from([54, 174, 193, 67, 17, 41, 132, 38]);

export interface BuyListingArgs {
  buyer: PublicKey;
  seller: PublicKey;
  tokenMint: PublicKey;
  priceLamports: bigint;
  maxPriceLamports?: bigint; // slippage ceiling
  royaltyBp?: number;        // creators' royalty bp
}

export function buildBuyInstructions(args: BuyListingArgs): TransactionInstruction[] {
  const ixs: TransactionInstruction[] = [];
  ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }));
  ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));

  const buyerAta = getAssociatedTokenAddressSync(args.tokenMint, args.buyer, true);
  ixs.push(
    createAssociatedTokenAccountIdempotentInstruction(
      args.buyer,
      buyerAta,
      args.buyer,
      args.tokenMint,
    ),
  );
  const sellerAta = getAssociatedTokenAddressSync(args.tokenMint, args.seller, true);

  const [singleListing] = PublicKey.findProgramAddressSync(
    [Buffer.from("single_listing"), args.tokenMint.toBuffer()],
    TENSORSWAP_PROGRAM_ID,
  );
  const [tswap] = PublicKey.findProgramAddressSync(
    [Buffer.from("tswap")],
    TENSORSWAP_PROGRAM_ID,
  );
  const [metadata] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METAPLEX_METADATA.toBuffer(), args.tokenMint.toBuffer()],
    METAPLEX_METADATA,
  );
  const [edition] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      METAPLEX_METADATA.toBuffer(),
      args.tokenMint.toBuffer(),
      Buffer.from("edition"),
    ],
    METAPLEX_METADATA,
  );

  const data = Buffer.concat([
    BUY_SINGLE_DISC,
    u64LE(args.maxPriceLamports ?? args.priceLamports),
    u16LE(args.royaltyBp ?? 500),
  ]);

  ixs.push(
    new TransactionInstruction({
      programId: TENSORSWAP_PROGRAM_ID,
      keys: [
        { pubkey: tswap, isSigner: false, isWritable: false },
        { pubkey: singleListing, isSigner: false, isWritable: true },
        { pubkey: args.tokenMint, isSigner: false, isWritable: false },
        { pubkey: sellerAta, isSigner: false, isWritable: true },
        { pubkey: buyerAta, isSigner: false, isWritable: true },
        { pubkey: args.seller, isSigner: false, isWritable: true },
        { pubkey: args.buyer, isSigner: true, isWritable: true },
        { pubkey: metadata, isSigner: false, isWritable: true },
        { pubkey: edition, isSigner: false, isWritable: false },
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
 * Build a Tensor list (sell) instruction at newPriceLamports.
 */
export function buildRelistInstructions(opts: {
  seller: PublicKey;
  tokenMint: PublicKey;
  newPriceLamports: bigint;
  expirySec: number;
}): TransactionInstruction[] {
  const ixs: TransactionInstruction[] = [];
  ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));

  const sellerAta = getAssociatedTokenAddressSync(opts.tokenMint, opts.seller, true);
  const [singleListing] = PublicKey.findProgramAddressSync(
    [Buffer.from("single_listing"), opts.tokenMint.toBuffer()],
    TENSORSWAP_PROGRAM_ID,
  );
  const [tswap] = PublicKey.findProgramAddressSync(
    [Buffer.from("tswap")],
    TENSORSWAP_PROGRAM_ID,
  );
  const [metadata] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METAPLEX_METADATA.toBuffer(), opts.tokenMint.toBuffer()],
    METAPLEX_METADATA,
  );

  const data = Buffer.concat([
    LIST_DISC,
    u64LE(opts.newPriceLamports),
    i64LE(BigInt(Math.floor(Date.now() / 1000) + opts.expirySec)),
  ]);

  ixs.push(
    new TransactionInstruction({
      programId: TENSORSWAP_PROGRAM_ID,
      keys: [
        { pubkey: tswap, isSigner: false, isWritable: false },
        { pubkey: singleListing, isSigner: false, isWritable: true },
        { pubkey: opts.tokenMint, isSigner: false, isWritable: false },
        { pubkey: sellerAta, isSigner: false, isWritable: true },
        { pubkey: opts.seller, isSigner: true, isWritable: true },
        { pubkey: metadata, isSigner: false, isWritable: true },
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
