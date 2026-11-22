// Las terminales antiguas también envían enteros decimales como texto.
export function enteroInventario(valor: unknown): number {
  if (typeof valor !== 'number' && !(typeof valor === 'string' && /^\d+$/.test(valor))) return 0;
  const n = Number(valor);
  return Number.isSafeInteger(n) && n > 0 && n <= 2147483647 ? n : 0;
}
