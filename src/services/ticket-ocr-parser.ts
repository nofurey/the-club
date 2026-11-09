import type { TicketDrawingOption, TicketNumberSetInput } from "../api/contracts";

export function parseTicketPlays(text: string, rules: NonNullable<TicketDrawingOption["numberRules"]>): { plays: TicketNumberSetInput[]; unrecognizedLines: number } {
  const plays: TicketNumberSetInput[] = [];
  let unrecognizedLines = 0;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:[A-T][.\s:)|]+)?(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s*(?:[-|:]\s*|\s+)(\d{1,2})(?:\s*(?:Q[.\s]*P\.?|Q|P))?\s*$/i);
    if (!match) {
      if (/^\s*[A-T][.\s:)|]+\s*[0-9OILSBZ]/i.test(line)) unrecognizedLines++;
      continue;
    }
    const numbers = match.slice(1, 6).map(Number);
    const bonusNumber = Number(match[6]);
    if (numbers.length !== rules.mainNumberCount || new Set(numbers).size !== numbers.length || numbers.some((number) => number < rules.mainNumberMin || number > rules.mainNumberMax) || bonusNumber < rules.bonusNumberMin || bonusNumber > rules.bonusNumberMax) {
      unrecognizedLines++;
      continue;
    }
    plays.push({ numbers, bonusNumber });
  }
  return { plays, unrecognizedLines };
}