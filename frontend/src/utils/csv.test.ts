import { describe, expect, it } from 'vitest';
import { neutralizeFormula, toCsv } from './csv';

describe('neutralizeFormula', () => {
  it.each(['=1+1', '+SUM(A1)', '-2', '@cmd', '\tx', '\rx'])('defuses %j', (value) => {
    expect(neutralizeFormula(value)).toBe(`'${value}`);
  });

  it('leaves ordinary text and URIs untouched', () => {
    expect(neutralizeFormula('gine://project_1')).toBe('gine://project_1');
    expect(neutralizeFormula('Alice = admin')).toBe('Alice = admin');
  });

  it('survives CSV quoting', () => {
    expect(toCsv([[neutralizeFormula('=a,b')]])).toBe('"\'=a,b"');
  });
});
