export function roundHalfUp(value: number, decimalPlaces: number): number {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(decimalPlaces) || decimalPlaces < 0) {
    throw new RangeError('roundHalfUp expects a finite non-negative value and non-negative integer precision');
  }
  const factor = 10 ** decimalPlaces;
  const scaled = value * factor;
  const floatingPointTolerance = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 2;
  return Math.floor(scaled + 0.5 + floatingPointTolerance) / factor;
}
