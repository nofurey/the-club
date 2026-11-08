# Lottery club rules — draft v0.7

## 1. Clubs, discovery, and visibility
- Clubs are **public** or **private**, and both may appear in search.
- Public clubs can be joined directly. Private clubs require approval. Private-club search results show only the club name. The owner can hide a private club from search and invite users directly.
- Public listings may show a description or motto, member count, ticket count, total prizes won, and payout configuration.
- Non-members cannot see the contribution feed, ticket numbers, or ticket images. Members can see club details, stats, and the feed.

## 2. Creation, roles, and ownership
At creation, the Creator sets the club name, visibility, payout configuration, minimum threshold amount and method, and supported lotteries. A description or motto is optional. Payout configuration cannot be changed after creation.

Club roles are **Creator**, **Admin**, and **Member**:
- Creator and Admin have the same general permissions, but only the Creator can grant Admin status.
- The Creator and Admins can approve private-club membership requests.
- Only the Creator can forcibly remove a member or close the club.
- Members can leave, subject to the contribution rules below.
- The Creator can transfer ownership to an Admin. The Admin does not need to accept. If there are no Admins, one must be appointed before ownership can be transferred.
- Account closure is blocked while the user owns any clubs; they must transfer ownership or close those clubs first.

## 3. Payout configurations
- **Equal Shares:** Eligible members split qualifying winnings equally.
- **Proportion — Drawing Specific:** Shares are proportional to eligible members’ ticket costs allocated to the winning drawing. A ticket’s cost is divided evenly over the consecutive drawings it covers.
- **Proportion — All Drawings:** Shares are proportional to eligible members’ total ticket spending in the club, regardless of ticket date or drawing.

Only eligible members are included in proportional calculations. For All Drawings, each eligible member’s total club ticket spending determines their share.

## 4. Threshold and winnings
At club creation, the Creator chooses a threshold amount and one method:

- **Pooled:** Compare combined club winnings for a drawing with the threshold. If the combined amount meets or exceeds it, pool all winnings from that drawing for the payout strategy, including individual prizes below the threshold. If the combined amount is below it, winnings go to the purchasers of the winning tickets.
- **Individual:** Compare each prize with the threshold. Pool prizes that meet or exceed it for the payout strategy. Below-threshold winnings go to the respective ticket purchasers; separate small prizes are not combined to reach the threshold.

An amount exactly equal to the threshold meets it. The MVP records winnings and intended allocations but **does not handle money**.

## 5. Membership eligibility, leaving, and removal
A member must be in the club before the applicable ticket-sales cutoff to qualify for that drawing. A join request pending at cutoff does not qualify, even if accepted before the numbers are drawn or checked.

For the Michigan launch, the stated cutoffs are:
- **Powerball:** 9:58 p.m. Eastern Time
- **Mega Millions:** 10:45 p.m. Eastern Time

The app applies the relevant cutoff in Eastern Time. A member cannot leave while they have active contributions for future drawings. Once they can leave, leaving forfeits eligibility for **future** payouts; payouts earned before leaving remain honored.

Only the Creator may forcibly remove a member. Removal is blocked between the drawing cutoff and completion of payout calculations, and while the member has a pending payout.

## 6. Contributions and ticket records
A contribution represents one ticket and records the lottery, drawing date(s), consecutive drawings covered, one or more number sets, and a ticket image. Ticket cost is automatically calculated from the applicable lottery price, number of number sets, consecutive drawings, and applicable paid options.

Members can edit their own contributions. Changes are audited. Adding a past-drawing contribution or modifying an entry after a drawing triggers recalculation of affected results and payouts.

## 7. Rules, results, and prize calculations
For Michigan, use the [Michigan Lottery Powerball page](https://www.michiganlottery.com/games/powerball) and [Mega Millions page](https://www.michiganlottery.com/games/mega-millions) as the official rules and prize sources. Check rules and costs daily, and check the applicable rules and prizes before payout calculations. Retain a copy of the rules/prices used for each calculation for 12 months. As additional states are supported, identify their official rules sources.

The service checks each number set against officially posted winning numbers and applies the prize rules for the specific drawing. For a jackpot match, display an **estimated** prize based on the annuity jackpot published by the Michigan Lottery at calculation time. Smaller-prize estimates use the applicable lottery rules.

Calculations for a drawing are complete when all tickets for that drawing have been checked against the officially posted winning numbers. Automated matches and prize amounts are unverified; matching numbers does not verify physical-ticket authenticity or redeemability.

## 8. Results, history, and recalculations
Club members can view a results table sorted by drawing date, with an aggregate **Total won**:
- Future drawings with contributions display **Pending Results**.
- Drawings whose results are posted but calculations are still underway display **Pending Results Calculation**.
- Once calculations are complete, the table shows the club’s winning tickets for that lottery drawing.

Recalculations and their effects are auditable. Any resulting notification identifies a **recalculated win** or **recalculated removal of a win**. Recalculated entries are clearly identified in club win history.

The 12-month retention period applies to **rules and price snapshots**. No specific retention period is currently set for calculation inputs, audit history, or win history.

## 9. Flags, support, and notifications
Any member may flag a payout as incorrect:
- A non-admin’s flag must be verified by a club Admin and escalated to Club Support.
- An Admin’s flag goes directly to Club Support.
- The support workflow beyond receiving flags is deferred for now.

A flag does not pause notifications. Notifications can be disabled **system-wide** if a bug is found. If a code bug is identified, all users receive a notice.

Notifications are sent only after calculations complete:
- Below-threshold winnings notify the winning ticket’s purchaser.
- At or above the threshold, recipients depend on the payout configuration:
  - **Equal Shares:** All members eligible at the drawing cutoff.
  - **Proportion — Drawing Specific:** Members with entries in the winning drawing.
  - **Proportion — All Drawings:** All members eligible at the drawing cutoff.

Users can select multiple channels. In-app and email are enabled by default; push and text are opt-in. Text requires a verified phone number. Notifications go through all selected channels. Recalculation notifications identify whether a win was added or removed.

## 10. Closing clubs
Only the Creator can close a club. Closure is blocked if:
- There are contributions for future drawings, or
- Any drawing’s payout calculations are incomplete.

A closed club remains visible on the home screen with a **Closed** status, with an option to hide closed clubs. It remains viewable, including its audit history, for 12 months from the closure date. Since the app does not handle money, closure itself does not change or transfer funds.

## 11. Club metrics and MVP boundary
The club’s **Total prizes won** means gross prize amounts before sharing rules are applied. The club page also shows member count, total contributions in USD, the logged-in member’s share percentage for qualifying payouts, and a link to personal contribution history.

The MVP records club activity, calculates estimated results, and notifies members. It does **not** purchase tickets, collect contributions, transfer money, or cash out prizes. Those capabilities are out of scope for now.

## Remaining gaps
- Define how a calculation is marked complete if an official results page is unavailable or changes after initial retrieval.
- Define notification delivery if notifications are disabled system-wide, including whether missed notices are sent later.
- Define the calculation inputs and historical records to retain; only rules and price snapshots currently have a specified retention period.

The Club Support handling workflow is intentionally deferred.
