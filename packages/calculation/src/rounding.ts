export function roundHalfUp(value: number, decimalPlaces: number): number {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(decimalPlaces) || decimalPlaces < 0) {
    throw new RangeError('roundHalfUp expects a finite non-negative value and non-negative integer precision');
  }
  const factor = 10 ** decimalPlaces;
  return Math.floor(value * factor + 0.5 + Number.EPSILON) / factor;
}
