import type { Drawing } from "../domain";
import type { CalculateDrawingInput, DrawingCalculationService } from "./drawing-calculation-service";
import type { OfficialDataRefreshInput, OfficialDataRefreshResult } from "./official-lottery-data-service";
import { getDrawingCutoffAtEt } from "./drawing-schedule";

export interface OfficialDrawingRefreshService {
  refreshDrawing(input: OfficialDataRefreshInput): Promise<OfficialDataRefreshResult>;
}

export interface DrawingLookup {
  findDrawingById(drawingId: string): Promise<Drawing | null>;
}

export interface DrawingCalculator {
  calculateDrawing(input: CalculateDrawingInput): Promise<unknown>;
}

export class OfficialDataCalculationRefreshService {
  constructor(
    private readonly refreshService: OfficialDrawingRefreshService,
    private readonly drawingLookup: DrawingLookup,
    private readonly calculator: DrawingCalculator
  ) {}

  async refreshDrawing(input: OfficialDataRefreshInput): Promise<OfficialDataRefreshResult> {
    const refreshed = await this.refreshService.refreshDrawing(input);
    if (refreshed.result.status !== "results_posted" || !refreshed.result.officialWinningNumbers) return refreshed;

    const drawing = await this.drawingLookup.findDrawingById(input.drawingId);
    if (!drawing) throw new Error("Drawing not found after official results refresh.");
    await this.calculator.calculateDrawing({
      drawingId: drawing.id,
      clubId: input.clubId,
      cutoffAt: getDrawingCutoffAtEt(drawing.drawingDate, drawing.cutoffTimeEt),
      recalculation: refreshed.recalculationRequired === true,
    });
    return refreshed;
  }
}