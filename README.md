# the-club
Lottery Club Application

## Prize Evaluation

`SnapshotLotteryPrizeEvaluator` reads the number format and prize tiers from each calculation snapshot's `priceSnapshot`. Keep these values sourced from the applicable official rules and preserve them with the snapshot so recalculations use the original rules version. The evaluator does not fetch or verify official results itself.

The snapshot must provide `numberRules` (`mainNumberCount`, `mainNumberMin`, `mainNumberMax`, `bonusNumberMin`, `bonusNumberMax`) and a non-empty `prizeTiers` array. Each tier defines `mainMatches`, `bonusMatches`, `prizeType`, and `prizeAmount`. Prize amounts may be fixed numbers, `"jackpot_estimate"` (from the drawing result), or `"prize_breakdown"` (looked up by `prizeType` in the drawing result's prize breakdown).

Multi-draw contributions are matched against the ordered drawing schedule for their lottery; ensure the relevant scheduled draws exist before calculation.

## Official Data Refresh

`MichiganLotteryGraphqlProvider` uses Michigan Lottery's public `https://www.michiganlottery.com/api` GraphQL endpoint for Powerball and Mega Millions. It fetches official game-detail sections and drawing results, parsing number ranges, ticket price, base prize tiers, winning numbers, and any draw-specific payout rows returned by the API. `HttpOfficialLotteryProvider` remains available for other configured sources.

Wire `new OfficialLotteryDataService(repository, new MichiganLotteryGraphqlProvider())` and call `refreshDrawing({ drawingId, clubId })` to fetch, validate, and store the normalized data and raw GraphQL responses. The canonical game page and exact API document URL, retrieval metadata, and SHA-256 hashes are retained. Repeated identical fetches are deduplicated; changed normalized rules or results clear stale awards and reopen the result for calculation.

Apply `database/migrations/002_official_data_sources.sql` after the initial schema migration. The provider does not substitute the current estimated jackpot for a historical draw's jackpot. If the API omits draw-specific payout rows or jackpot estimates, those values remain absent; prize calculation must wait for an official value rather than infer one from a generic prize table.
