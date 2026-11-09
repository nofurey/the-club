import type { DrawingResult } from "../domain";

export type DrawingResultState = "pending_results" | "pending_calculation" | "calculated" | "recalculated";

export function drawingResultState(result: Pick<DrawingResult, "status" | "officialWinningNumbers"> | null): DrawingResultState {
  if (!result?.officialWinningNumbers) return "pending_results";
  if (result.status === "calculated" || result.status === "recalculated") return result.status;
  return "pending_calculation";
}