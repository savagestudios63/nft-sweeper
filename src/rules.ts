import type { CollectionRule } from "./config.js";
import type { Listing, Trait } from "./types.js";

export interface RuleContext {
  floorSol: number | null;
  fairValueSol: number | null;
  spreadPct: number | null;
  minSpreadPct: number;
  sessionSpentSol: number;
}

export interface RuleOutcome {
  matched: boolean;
  reason: string;
}

export class RuleEngine {
  constructor(private readonly rulesBySlug: Map<string, CollectionRule>) {}

  static fromConfig(rules: CollectionRule[]): RuleEngine {
    const map = new Map<string, CollectionRule>();
    for (const r of rules) {
      if (r.magicedenSlug) map.set(`magiceden:${r.magicedenSlug}`, r);
      if (r.tensorSlug) map.set(`tensor:${r.tensorSlug}`, r);
    }
    return new RuleEngine(map);
  }

  ruleFor(source: string, slug: string): CollectionRule | undefined {
    return this.rulesBySlug.get(`${source}:${slug}`);
  }

  evaluate(listing: Listing, ctx: RuleContext): RuleOutcome {
    const rule = this.ruleFor(listing.source, listing.collectionSlug);
    if (!rule) return { matched: false, reason: "no rule for collection" };

    // 1. Absolute price cap
    if (listing.priceSol > rule.maxBuyPriceSol) {
      return {
        matched: false,
        reason: `price ${listing.priceSol} > maxBuyPriceSol ${rule.maxBuyPriceSol}`,
      };
    }

    // 2. Percent-below-floor cap
    if (rule.maxPctBelowFloor != null) {
      if (ctx.floorSol == null) {
        return { matched: false, reason: "floor unknown (stale)" };
      }
      const neededMaxPrice = ctx.floorSol * (1 - rule.maxPctBelowFloor / 100);
      if (listing.priceSol > neededMaxPrice) {
        return {
          matched: false,
          reason: `price ${listing.priceSol} > ${neededMaxPrice.toFixed(3)} (floor*${(1 - rule.maxPctBelowFloor / 100).toFixed(3)})`,
        };
      }
    }

    // 3. Rarity rank
    const maxRank = rule.rarity?.maxRank;
    if (maxRank != null) {
      const effectiveRank = listing.rank ?? rule.rarity?.unknownRankDefault ?? null;
      if (effectiveRank == null) {
        return { matched: false, reason: "rank unknown and no default" };
      }
      if (effectiveRank > maxRank) {
        return {
          matched: false,
          reason: `rank ${effectiveRank} > maxRank ${maxRank}`,
        };
      }
    }

    // 4. Trait filters
    const traits = listing.traits ?? [];
    const needMust = rule.traits.mustHave.length > 0;
    const needForbidden = rule.traits.forbidden.length > 0;

    if ((needMust || needForbidden) && traits.length === 0) {
      return { matched: false, reason: "traits required but listing had none" };
    }

    for (const must of rule.traits.mustHave) {
      if (!hasTrait(traits, must)) {
        return { matched: false, reason: `missing required trait ${must.name}=${must.value}` };
      }
    }
    for (const bad of rule.traits.forbidden) {
      if (hasTrait(traits, bad)) {
        return { matched: false, reason: `forbidden trait present ${bad.name}=${bad.value}` };
      }
    }

    // 5. Spread vs fair value
    if (ctx.spreadPct != null && ctx.spreadPct < ctx.minSpreadPct) {
      return {
        matched: false,
        reason: `spread ${ctx.spreadPct.toFixed(2)}% < min ${ctx.minSpreadPct}%`,
      };
    }

    // 6. Collection session budget
    const wouldSpend = ctx.sessionSpentSol + listing.priceSol;
    if (wouldSpend > rule.maxSessionSpendSol) {
      return {
        matched: false,
        reason: `would breach collection budget (${wouldSpend.toFixed(2)} > ${rule.maxSessionSpendSol})`,
      };
    }

    return {
      matched: true,
      reason: `match: price=${listing.priceSol} floor=${ctx.floorSol ?? "?"} fair=${ctx.fairValueSol?.toFixed(3) ?? "?"} rank=${listing.rank ?? "?"}`,
    };
  }
}

function hasTrait(traits: Trait[], target: Trait): boolean {
  return traits.some(
    (t) =>
      t.name.toLowerCase() === target.name.toLowerCase() &&
      t.value.toLowerCase() === target.value.toLowerCase(),
  );
}
