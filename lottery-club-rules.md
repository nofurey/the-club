# Lottery Club Rules — draft v0.8

This document defines the operating rules for the MVP lottery club application. These rules describe how clubs are created, how tickets and memberships are tracked, how winnings are calculated, and when notifications and audits occur. The app records club activity and estimated results, but does not handle money.

## 1. Clubs, discovery, and visibility
- Clubs are either **public** or **private**, and both types may appear in search results.
- Public clubs can be joined directly. Private clubs require approval. Private club search results show only the club name.
- The club owner may hide a private club from search and invite members directly.
- Public club listings may display a description or motto, member count, ticket count, total prizes won, and payout configuration.
- Non-members cannot view the contribution feed, ticket numbers, or ticket images. Members can view club details, stats, and the feed.

## 2. Creation, roles, and ownership
At creation, the Creator defines the club name, visibility, payout configuration, threshold amount and method, and supported lotteries. A description or motto is optional. The payout configuration cannot be changed after creation.

Club roles are **Creator**, **Admin**, and **Member**:
- Creator and Admin have the same general permissions, but only the Creator can grant Admin status.
- The Creator and Admins can approve private-club membership requests.
- Only the Creator can forcibly remove a member or close the club.
- Members may leave, subject to the contribution rules below.
- The Creator may transfer ownership to an Admin. The Admin does not need to accept the transfer. If there are no Admins, one must be appointed before ownership can be transferred.
- Account closure is blocked while the user owns any club. The user must transfer ownership or close those clubs first.

## 3. Payout configurations
- **Equal Shares:** Eligible members split qualifying winnings equally.
- **Proportion — Drawing Specific:** Shares are proportional to eligible members’ ticket costs allocated to the winning drawing. A ticket’s cost is divided evenly across the consecutive drawings it covers.
- **Proportion — All Drawings:** Shares are proportional to eligible members’ total ticket spending in the club, regardless of ticket date or drawing.

Only eligible members are included in proportional calculations. For the All Drawings option, each eligible member’s total club ticket spending determines their share.

## 4. Thresholds and winnings
At club creation, the Creator selects a threshold amount and one method:

- **Pooled:** Compare combined club winnings for a drawing to the threshold. If the combined amount meets or exceeds the threshold, pool all winnings from that drawing for the payout strategy, including individual prizes below the threshold. If the combined amount is below the threshold, winnings go to the purchasers of the winning tickets.
- **Individual:** Compare each prize to the threshold. Pool prizes that meet or exceed the threshold for the payout strategy. Winnings below the threshold go to the respective ticket purchasers; separate small prizes are not combined to reach the threshold.

An amount exactly equal to the threshold meets it. The MVP records winnings and intended allocations, but does not handle money.

## 5. Membership eligibility, leaving, and removal
A member must be in the club before the applicable ticket-sales cutoff to qualify for that drawing. A membership request pending at cutoff does not qualify, even if accepted before the numbers are drawn or checked.

For the Michigan launch, the stated cutoffs are:
- **Powerball:** 9:58 p.m. Eastern Time
- **Mega Millions:** 10:45 p.m. Eastern Time

The app applies the relevant cutoff in Eastern Time. A member cannot leave while they have active contributions for future drawings. Once they are allowed to leave, leaving forfeits eligibility for future payouts; payouts earned before leaving remain honored.

Only the Creator may forcibly remove a member. Removal is blocked between the drawing cutoff and completion of payout calculations, and while the member has a pending payout.

## 6. Contributions and ticket records
A contribution represents one ticket and records the lottery, drawing date(s), consecutive drawings covered, one or more number sets, and a ticket image. Ticket cost is automatically calculated from the applicable lottery price, the number of number sets, consecutive drawings covered, and any applicable paid options.

Members may edit their own contributions. Changes are audited. Adding a past-drawing contribution or modifying an entry after a drawing triggers recalculation of the affected results and payouts.

## 7. Official rules, results, and prize calculations
For Michigan, use the [Michigan Lottery Powerball page](https://www.michiganlottery.com/games/powerball) and the [Mega Millions page](https://www.michiganlottery.com/games/mega-millions) as the official rules and prize sources. Check rules and costs daily, and check the applicable rules and prizes before payout calculations. Retain a copy of the rules and prices used for each calculation for 12 months. As additional states are supported, identify their official rules sources.

The service checks each number set against the officially posted winning numbers and applies the prize rules for the specific drawing. For a jackpot match, the app displays an **estimated** prize based on the annuity jackpot published by the Michigan Lottery at calculation time. Smaller-prize estimates use the applicable lottery rules.

Calculations for a drawing are complete when all tickets for that drawing have been checked against the officially posted winning numbers. Automated matches and prize amounts are unverified; matching numbers does not verify physical-ticket authenticity or redeemability.

## 8. Results, history, and recalculations
Club members can view a results table sorted by drawing date, with an aggregate **Total won**:
- Future drawings with contributions display **Pending Results**.
- Drawings whose results are posted but whose calculations are still underway display **Pending Results Calculation**.
- Once calculations are complete, the table shows the club’s winning tickets for that lottery drawing.

Recalculations and their effects are auditable. Any resulting notification identifies a **recalculated win** or **recalculated removal of a win**. Recalculated entries are clearly identified in club win history.

The 12-month retention period applies to **rules and price snapshots**. No specific retention period is currently set for calculation inputs, audit history, or win history.

## 9. Flags, support, and notifications
Any member may flag a payout as incorrect:
- A non-admin’s flag must be verified by a club Admin and escalated to Club Support.
- An Admin’s flag goes directly to Club Support.
- The support workflow beyond receiving flags is deferred for now.

A flag does not pause notifications. Notifications may be disabled **system-wide** if a bug is found. If a code bug is identified, all users receive a notice.

Notifications are sent only after calculations complete:
- Below-threshold winnings notify the winning ticket purchaser.
- At or above the threshold, recipients depend on the payout configuration:
  - **Equal Shares:** All members eligible at the drawing cutoff.
  - **Proportion — Drawing Specific:** Members with entries in the winning drawing.
  - **Proportion — All Drawings:** All members eligible at the drawing cutoff.

Users may select multiple channels. In-app and email are enabled by default; push and text are opt-in. Text requires a verified phone number. Notifications go through all selected channels. Recalculation notifications identify whether a win was added or removed.

## 10. Closing clubs
Only the Creator may close a club. Closure is blocked if:
- There are contributions for future drawings, or
- Any drawing’s payout calculations are incomplete.

A closed club remains visible on the home screen with a **Closed** status, with an option to hide closed clubs. It remains viewable, including its audit history, for 12 months from the closure date. Because the app does not handle money, closure itself does not change or transfer funds.

## 11. Club metrics and MVP boundary
The club’s **Total prizes won** means gross prize amounts before sharing rules are applied. The club page also shows member count, total contributions in USD, the logged-in member’s share percentage for qualifying payouts, and a link to personal contribution history.

The MVP records club activity, calculates estimated results, and notifies members. It does **not** purchase tickets, collect contributions, transfer money, or cash out prizes. Those capabilities are out of scope for now.

## 12. Open items and unresolved decisions
The following items require product or compliance decisions before launch:
- Define how a calculation is marked complete if an official results page is unavailable or changes after initial retrieval.
- Define notification behavior when notifications are disabled system-wide, including whether missed notices are sent later.
- Define the calculation inputs and historical records to retain; only rules and price snapshots currently have a specified retention period.
- The Club Support handling workflow remains intentionally deferred for the MVP.
