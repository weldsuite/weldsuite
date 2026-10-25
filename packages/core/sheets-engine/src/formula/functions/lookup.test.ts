import { describe, expect, it } from 'vitest';
import { ERR, matrix, type Scalar } from '../../values';
import { testHost } from '../test-host';

const m = (rows: Scalar[][]) => matrix(rows);
const code = (c: string) => expect.objectContaining({ kind: 'error', code: c });
const NA = ERR.na;

/** Fruit table: A names, B ids, C prices; E/F a sorted bracket table; G/H unsorted. */
const fruit = {
  A1: 'Apple',
  A2: 'banana',
  A3: 'Cherry',
  A4: 'date',
  A5: 'Elder',
  B1: 1,
  B2: 2,
  B3: 3,
  B4: 4,
  B5: 5,
  C1: 10,
  C2: 20,
  C3: 30,
  C4: 40,
  C5: 50,
  E1: 0,
  E2: 10,
  E3: 20,
  E4: 30,
  E5: 40,
  F1: 'F',
  F2: 'D',
  F3: 'C',
  F4: 'B',
  F5: 'A',
  G1: 1,
  G2: 2,
  G3: 10,
  G4: 3,
  G5: 4,
  H1: 'a',
  H2: 'b',
  H3: 'c',
  H4: 'd',
  H5: 'e',
};

describe('VLOOKUP / HLOOKUP', () => {
  const run = testHost(fruit);

  it('matches exactly, case-insensitively and with wildcards', () => {
    expect(run('VLOOKUP("banana",A1:C5,3,FALSE)')).toBe(20);
    expect(run('VLOOKUP("BANANA",A1:C5,2,FALSE)')).toBe(2);
    expect(run('VLOOKUP("ch*",A1:C5,3,FALSE)')).toBe(30);
    expect(run('VLOOKUP("?ate",A1:C5,3,0)')).toBe(40);
    expect(run('VLOOKUP("zzz",A1:C5,2,FALSE)')).toEqual(NA);
    // Text never matches a number and vice versa.
    expect(run('VLOOKUP("10",E1:F5,2,FALSE)')).toEqual(NA);
    // An empty range_lookup argument means FALSE.
    expect(run('VLOOKUP(25,E1:F5,2,)')).toEqual(NA);
  });

  it('checks the column index and propagates errors', () => {
    expect(run('VLOOKUP("banana",A1:C5,4,FALSE)')).toEqual(ERR.ref);
    expect(run('VLOOKUP("banana",A1:C5,0,FALSE)')).toEqual(ERR.value);
    expect(run('VLOOKUP(1/0,A1:C5,2,FALSE)')).toEqual(ERR.div0);
  });

  it('does approximate matches by binary search', () => {
    expect(run('VLOOKUP(25,E1:F5,2)')).toBe('C');
    expect(run('VLOOKUP(25,E1:F5,2,TRUE)')).toBe('C');
    expect(run('VLOOKUP(30,E1:F5,2,TRUE)')).toBe('B');
    expect(run('VLOOKUP(100,E1:F5,2,TRUE)')).toBe('A');
    expect(run('VLOOKUP(-1,E1:F5,2,TRUE)')).toEqual(NA);
    // Unsorted data: a binary search lands on 2, where a linear "largest <= 3.5" would find 3.
    expect(run('VLOOKUP(3.5,G1:H5,2,TRUE)')).toBe('b');
    // Duplicates: the last of a run is returned.
    expect(run('VLOOKUP(2,{1,"a";2,"b";2,"c";3,"d"},2,TRUE)')).toBe('c');
  });

  it('works on whole columns and lifts array arguments', () => {
    expect(run('VLOOKUP("Cherry",A:C,3,0)')).toBe(30);
    expect(run('VLOOKUP("nope",A:C,2,0)')).toEqual(NA);
    expect(run('VLOOKUP(35,E:F,2,TRUE)')).toBe('B');
    expect(run('VLOOKUP({"banana";"date"},A1:C5,3,FALSE)')).toEqual(m([[20], [40]]));
    expect(run('VLOOKUP("banana",A1:C5,{2,3},FALSE)')).toEqual(m([[2, 20]]));
  });

  it('HLOOKUP searches the first row (Excel docs example)', () => {
    const h = testHost({ A1: 'Axles', B1: 'Bearings', C1: 'Bolts', A2: 4, B2: 4, C2: 9, A3: 5, B3: 7, C3: 10, A4: 6, B4: 8, C4: 11 });
    expect(h('HLOOKUP("Axles",A1:C4,2,TRUE)')).toBe(4);
    expect(h('HLOOKUP("Bearings",A1:C4,3,FALSE)')).toBe(7);
    expect(h('HLOOKUP("B",A1:C4,3,TRUE)')).toBe(5);
    expect(h('HLOOKUP("Bolts",A1:C4,4)')).toBe(11);
    expect(h('HLOOKUP(3,{1,2,3;"a","b","c";"d","e","f"},2,TRUE)')).toBe('c');
    expect(h('HLOOKUP("Bolts",A1:C4,5,FALSE)')).toEqual(ERR.ref);
  });
});

describe('LOOKUP', () => {
  const run = testHost({
    A2: 4.14,
    A3: 4.19,
    A4: 5.17,
    A5: 5.77,
    A6: 6.39,
    B2: 'red',
    B3: 'orange',
    B4: 'yellow',
    B5: 'green',
    B6: 'blue',
    D1: 'x',
    D2: 'y',
    D3: 'x',
    D4: 'z',
    E1: 1,
    E2: 2,
    E3: 3,
    E4: 4,
  });

  it('vector form (Excel docs example)', () => {
    expect(run('LOOKUP(4.19,A2:A6,B2:B6)')).toBe('orange');
    expect(run('LOOKUP(5.75,A2:A6,B2:B6)')).toBe('yellow');
    expect(run('LOOKUP(7.66,A2:A6,B2:B6)')).toBe('blue');
    expect(run('LOOKUP(0,A2:A6,B2:B6)')).toEqual(NA);
    // A single-cell result vector extends like the lookup vector.
    expect(run('LOOKUP(5.17,A2:A6,B2)')).toBe('yellow');
  });

  it('array form', () => {
    expect(run('LOOKUP("C",{"a","b","c","d";1,2,3,4})')).toBe(3);
    expect(run('LOOKUP("bump",{"a",1;"b",2;"c",3})')).toBe(2);
  });

  it('supports the last-match idiom by skipping errors', () => {
    expect(run('LOOKUP(2,1/(D1:D4="x"),E1:E4)')).toBe(3);
    expect(run('LOOKUP(2,1/(D1:D4="q"),E1:E4)')).toEqual(NA);
  });
});

describe('MATCH / XMATCH', () => {
  const run = testHost({ B2: 25, B3: 38, B4: 40, B5: 41, ...{ A1: 'Apple', A2: 'banana', A3: 'Cherry' } });

  it('MATCH (Excel docs example)', () => {
    expect(run('MATCH(39,B2:B5,1)')).toBe(2);
    expect(run('MATCH(41,B2:B5,0)')).toBe(4);
    expect(run('MATCH(40,B2:B5,-1)')).toEqual(NA);
    expect(run('MATCH(39,B2:B5)')).toBe(2);
    expect(run('MATCH(38,B2:B5,)')).toBe(2);
    expect(run('MATCH(10,B2:B5,1)')).toEqual(NA);
  });

  it('MATCH descending, wildcards, whole columns and shape checks', () => {
    expect(run('MATCH(35,{50,40,30,20},-1)')).toBe(2);
    expect(run('MATCH("b*",{"apple","banana"},0)')).toBe(2);
    expect(run('MATCH("cherry",A:A,0)')).toBe(3);
    expect(run('MATCH(1,{1,2;3,4},0)')).toEqual(NA);
    expect(run('MATCH(#N/A,B2:B5,0)')).toEqual(NA);
  });

  it('XMATCH modes', () => {
    expect(run('XMATCH(4,{5,4,3,2,1})')).toBe(2);
    expect(run('XMATCH(4.5,{5,4,3,2,1},1)')).toBe(1);
    expect(run('XMATCH(4.5,{5,4,3,2,1},-1)')).toBe(2);
    expect(run('XMATCH("Gra?e",{"Apple","Grape","Pear"},2)')).toBe(2);
    expect(run('XMATCH("Gra?e",{"Apple","Grape","Pear"})')).toEqual(NA);
    expect(run('XMATCH(1,{1,2,1},0,-1)')).toBe(3);
  });

  it('XMATCH binary search', () => {
    expect(run('XMATCH(30,{10,20,30,40},0,2)')).toBe(3);
    expect(run('XMATCH(25,{10,20,30,40},0,2)')).toEqual(NA);
    expect(run('XMATCH(25,{10,20,30,40},-1,2)')).toBe(2);
    expect(run('XMATCH(25,{10,20,30,40},1,2)')).toBe(3);
    expect(run('XMATCH(5,{10,20,30,40},1,2)')).toBe(1);
    expect(run('XMATCH(25,{40,30,20,10},1,-2)')).toBe(2);
    expect(run('XMATCH(25,{40,30,20,10},-1,-2)')).toBe(3);
    expect(run('XMATCH(30,{40,30,20,10},0,-2)')).toBe(2);
    expect(run('XMATCH("a*",{"a","b"},2,2)')).toEqual(ERR.value);
    expect(run('XMATCH(1,{1,2},3)')).toEqual(ERR.value);
    expect(run('XMATCH(1,{1,2},0,0)')).toEqual(ERR.value);
  });
});

describe('XLOOKUP', () => {
  const run = testHost({ ...fruit, J1: 'x', J2: 'y', J3: 'x', K1: 1, K2: 2, K3: 3 });

  it('exact match, not-found value and wildcards', () => {
    expect(run('XLOOKUP("cherry",A1:A5,C1:C5)')).toBe(30);
    expect(run('XLOOKUP("kiwi",A1:A5,C1:C5)')).toEqual(NA);
    expect(run('XLOOKUP("kiwi",A1:A5,C1:C5,"none")')).toBe('none');
    expect(run('XLOOKUP("b?nana",A1:A5,B1:B5,,2)')).toBe(2);
    expect(run('XLOOKUP("b?nana",A1:A5,B1:B5)')).toEqual(NA);
    expect(run('XLOOKUP(1/0,A1:A5,B1:B5)')).toEqual(ERR.div0);
  });

  it('returns whole rows as references', () => {
    expect(run('XLOOKUP("cherry",A1:A5,B1:C5)')).toEqual(m([[3, 30]]));
    expect(run('COLUMN(XLOOKUP("banana",A1:A5,B1:C5))')).toEqual(m([[2, 3]]));
    expect(run('ROW(XLOOKUP("banana",A1:A5,B1:C5))')).toBe(2);
    expect(run('XLOOKUP(3,{1,2,3},{"a","b","c";"d","e","f"})')).toEqual(m([['c'], ['f']]));
    expect(run('XLOOKUP("cherry",A1:A5,B1:B4)')).toEqual(ERR.value);
    expect(run('XLOOKUP(1,{1,2;3,4},{1,2;3,4})')).toEqual(ERR.value);
  });

  it('next smaller / larger and search direction', () => {
    expect(run('XLOOKUP(25,E1:E5,F1:F5,,-1)')).toBe('C');
    expect(run('XLOOKUP(25,E1:E5,F1:F5,,1)')).toBe('B');
    expect(run('XLOOKUP(50,E1:E5,F1:F5,"over",1)')).toBe('over');
    // Approximate modes work on unsorted data when searching linearly.
    expect(run('XLOOKUP(4,{5,1,9,3},{"a","b","c","d"},,-1)')).toBe('d');
    expect(run('XLOOKUP(4,{5,1,9,3},{"a","b","c","d"},,1)')).toBe('a');
    expect(run('XLOOKUP("x",J1:J3,K1:K3)')).toBe(1);
    expect(run('XLOOKUP("x",J1:J3,K1:K3,,0,-1)')).toBe(3);
    expect(run('XLOOKUP(30,E1:E5,F1:F5,,0,2)')).toBe('B');
    expect(run('XLOOKUP(25,E1:E5,F1:F5,,-1,2)')).toBe('C');
  });

  it('works on whole columns and finds blanks', () => {
    expect(run('XLOOKUP("date",A:A,C:C)')).toBe(40);
    const h = testHost({ A1: 'a', A2: null, A3: 'c', B1: 1, B2: 2, B3: 3, D1: null });
    expect(h('XLOOKUP(D1,A1:A3,B1:B3)')).toBe(2);
    // The first blank of a whole column may lie past the used area.
    expect(h('XMATCH(D1,{"a"})')).toEqual(NA);
    expect(testHost({ A1: 'a', A2: 'b' })('XMATCH(C1,A:A)')).toBe(3);
  });
});

describe('INDEX / CHOOSE', () => {
  const run = testHost(fruit);

  it('INDEX picks cells, rows and columns', () => {
    expect(run('INDEX(A1:C5,2,3)')).toBe(20);
    expect(run('INDEX(B1:B5,3)')).toBe(3);
    expect(run('INDEX(A1:C1,2)')).toBe(1);
    expect(run('INDEX(A1:C5,0,2)')).toEqual(m([[1], [2], [3], [4], [5]]));
    expect(run('INDEX(A1:C5,2,0)')).toEqual(m([['banana', 2, 20]]));
    expect(run('INDEX(A1:C5,2)')).toEqual(m([['banana', 2, 20]]));
    expect(run('INDEX({1,2;3,4},2,1)')).toBe(3);
    expect(run('INDEX({1,2;3,4},0,2)')).toEqual(m([[2], [4]]));
    expect(run('INDEX({1,2;3,4},{1;2},{2;1})')).toEqual(m([[2], [3]]));
    expect(run('INDEX(7,1,1)')).toBe(7);
  });

  it('INDEX returns references', () => {
    expect(run('COLUMN(INDEX(A1:C5,0,3))')).toBe(3);
    expect(run('B1:INDEX(B:B,3)')).toEqual(m([[1], [2], [3]]));
    expect(run('ROW(INDEX(A:A,7))')).toBe(7);
    expect(run('ROWS(INDEX(C:C,0))')).toBe(1_048_576);
  });

  it('INDEX errors', () => {
    expect(run('INDEX(A1:C5,6,1)')).toEqual(ERR.ref);
    expect(run('INDEX(A1:C5,1,4)')).toEqual(ERR.ref);
    expect(run('INDEX(A1:C5,-1,1)')).toEqual(ERR.value);
    expect(run('INDEX(A1:C5,1,1,2)')).toEqual(ERR.ref);
    expect(run('INDEX(A1:C5,"x",1)')).toEqual(ERR.value);
  });

  it('CHOOSE', () => {
    expect(run('CHOOSE(2,"a","b","c")')).toBe('b');
    expect(run('CHOOSE(2.9,"a","b","c")')).toBe('b');
    expect(run('CHOOSE(4,"a","b","c")')).toEqual(ERR.value);
    expect(run('CHOOSE(0,"a","b")')).toEqual(ERR.value);
    expect(run('CHOOSE(1/0,"a","b")')).toEqual(ERR.div0);
    // Only the chosen argument is evaluated.
    expect(run('CHOOSE(1,5,NOPE())')).toBe(5);
    expect(run('COLUMN(CHOOSE(2,A1:A5,B1:B5))')).toBe(2);
    expect(run('CHOOSE({1,2},"a","b")')).toEqual(m([['a', 'b']]));
    expect(run('CHOOSE({1,3},"a","b")')).toEqual(m([['a', ERR.value]]));
    // The left-lookup idiom.
    expect(run('VLOOKUP(20,CHOOSE({1,2},C1:C5,A1:A5),2,FALSE)')).toBe('banana');
  });
});

describe('OFFSET / INDIRECT', () => {
  const run = testHost(fruit, {
    sheets: { Sheet2: { A1: 'two' }, 'My Sheet': { B2: 'mine' } },
    names: { data: 'Sheet1!B1:B5', notref: '1+1' },
  });

  it('OFFSET', () => {
    expect(run('OFFSET(A1,2,1)')).toBe(3);
    expect(run('OFFSET(B1,1,0,3,1)')).toEqual(m([[2], [3], [4]]));
    expect(run('OFFSET(B5,0,0,-3)')).toEqual(m([[3], [4], [5]]));
    expect(run('OFFSET(C5,-1,-1,1,-2)')).toEqual(m([['date', 4]]));
    expect(run('ROWS(OFFSET(A1,0,0,4,2))')).toBe(4);
    expect(run('COLUMNS(OFFSET(A1:B2,1,1))')).toBe(2);
    expect(run('OFFSET(A1,-1,0)')).toEqual(ERR.ref);
    expect(run('OFFSET(A1,0,0,0,1)')).toEqual(ERR.ref);
    expect(run('OFFSET("A1",0,0)')).toEqual(ERR.value);
  });

  it('INDIRECT with A1 text', () => {
    expect(run('INDIRECT("B2")')).toBe(2);
    expect(run('INDIRECT("A"&3)')).toBe('Cherry');
    expect(run('INDIRECT(" $C$4 ")')).toBe(40);
    expect(run('INDIRECT("B1:B3")')).toEqual(m([[1], [2], [3]]));
    expect(run('ROWS(INDIRECT("B:B"))')).toBe(1_048_576);
    expect(run('INDIRECT("Sheet2!A1")')).toBe('two');
    expect(run('INDIRECT("\'My Sheet\'!B2")')).toBe('mine');
    expect(run('INDIRECT("data")')).toEqual(m([[1], [2], [3], [4], [5]]));
  });

  it('INDIRECT with R1C1 text', () => {
    expect(run('INDIRECT("R2C2",FALSE)')).toBe(2);
    expect(run('INDIRECT("R[1]C[0]",FALSE)', 'B1')).toBe(2);
    expect(run('INDIRECT("RC[-1]",FALSE)', 'C3')).toBe(3);
    expect(run('INDIRECT("R1C2:R3C3",FALSE)')).toEqual(m([[1, 10], [2, 20], [3, 30]]));
    expect(run('COLUMN(INDIRECT("C2",FALSE))')).toBe(2);
    expect(run('ROWS(INDIRECT("C2",FALSE))')).toBe(1_048_576);
    expect(run('ROW(INDIRECT("R2",FALSE))')).toBe(2);
    expect(run('COLUMNS(INDIRECT("R2",FALSE))')).toBe(16_384);
    expect(run('INDIRECT("Sheet2!R1C1",FALSE)')).toBe('two');
    expect(run('INDIRECT("\'My Sheet\'!R2C2",FALSE)')).toBe('mine');
    expect(run('INDIRECT("R0C1",FALSE)')).toEqual(ERR.ref);
  });

  it('INDIRECT errors are #REF!', () => {
    expect(run('INDIRECT("Nope!A1")')).toEqual(ERR.ref);
    expect(run('INDIRECT("1+")')).toEqual(ERR.ref);
    expect(run('INDIRECT("")')).toEqual(ERR.ref);
    expect(run('INDIRECT("A1+1")')).toEqual(ERR.ref);
    expect(run('INDIRECT("notref")')).toEqual(ERR.ref);
    expect(run('INDIRECT("unknown")')).toEqual(ERR.ref);
    expect(run('INDIRECT("R1C1")')).toEqual(ERR.ref);
    expect(run('INDIRECT("A1:R2C2",FALSE)')).toEqual(ERR.ref);
  });
});

describe('ROW / COLUMN / ROWS / COLUMNS / ADDRESS / AREAS', () => {
  const run = testHost(fruit);

  it('ROW and COLUMN', () => {
    expect(run('ROW()', 'C7')).toBe(7);
    expect(run('COLUMN()', 'C7')).toBe(3);
    expect(run('ROW(B5)')).toBe(5);
    expect(run('COLUMN(D1)')).toBe(4);
    expect(run('ROW(A2:A4)')).toEqual(m([[2], [3], [4]]));
    expect(run('ROW(A2:C2)')).toBe(2);
    expect(run('COLUMN(B1:D1)')).toEqual(m([[2, 3, 4]]));
    // Whole columns stop at the used area, like every other materialised range.
    expect(run('ROW(A:A)')).toEqual(m([[1], [2], [3], [4], [5]]));
    expect(run('ROW({1,2})')).toEqual(ERR.value);
  });

  it('ROWS and COLUMNS do not materialise', () => {
    expect(run('ROWS(A:A)')).toBe(1_048_576);
    expect(run('COLUMNS(1:1)')).toBe(16_384);
    expect(run('ROWS(A1:C5)')).toBe(5);
    expect(run('COLUMNS(A1:C5)')).toBe(3);
    expect(run('ROWS({1,2;3,4;5,6})')).toBe(3);
    expect(run('COLUMNS({1,2,3})')).toBe(3);
    expect(run('ROWS(5)')).toBe(1);
  });

  it('ADDRESS (Excel docs examples)', () => {
    expect(run('ADDRESS(2,3)')).toBe('$C$2');
    expect(run('ADDRESS(2,3,2)')).toBe('C$2');
    expect(run('ADDRESS(2,3,3)')).toBe('$C2');
    expect(run('ADDRESS(2,3,4)')).toBe('C2');
    expect(run('ADDRESS(2,3,2,FALSE)')).toBe('R2C[3]');
    expect(run('ADDRESS(2,3,1,FALSE,"[Book1]Sheet1")')).toBe("'[Book1]Sheet1'!R2C3");
    expect(run('ADDRESS(2,3,1,FALSE,"EXCEL SHEET")')).toBe("'EXCEL SHEET'!R2C3");
    expect(run('ADDRESS(1,28,4,TRUE,"Data")')).toBe('Data!AB1');
    expect(run('ADDRESS(0,1)')).toEqual(ERR.value);
    expect(run('ADDRESS(1,1,5)')).toEqual(ERR.value);
  });

  it('AREAS', () => {
    expect(run('AREAS(B2:D4)')).toBe(1);
    expect(run('AREAS(A:A)')).toBe(1);
    expect(run('AREAS(1)')).toEqual(ERR.value);
  });
});

describe('dynamic arrays', () => {
  const run = testHost({ ...fruit, J1: 1, J2: null, J3: 3 });
  const grid = '{1,2,3;4,5,6;7,8,9}';

  it('TRANSPOSE', () => {
    expect(run('TRANSPOSE({1,2,3})')).toEqual(m([[1], [2], [3]]));
    expect(run('TRANSPOSE(A1:B2)')).toEqual(m([['Apple', 'banana'], [1, 2]]));
  });

  it('FILTER', () => {
    expect(run('FILTER(A1:B5,B1:B5>2)')).toEqual(m([['Cherry', 3], ['date', 4], ['Elder', 5]]));
    expect(run('FILTER(A:B,B:B>3)')).toEqual(m([['date', 4], ['Elder', 5]]));
    expect(run('FILTER({1,2,3},{TRUE,FALSE,TRUE})')).toEqual(m([[1, 3]]));
    expect(run('FILTER(A1:A5,B1:B5>10)')).toEqual(code('#CALC!'));
    expect(run('FILTER(A1:A5,B1:B5>10,"none")')).toBe('none');
    expect(run('FILTER(A1:A5,B1:B3>1)')).toEqual(ERR.value);
    expect(run('FILTER({1;2},{"x";TRUE})')).toEqual(ERR.value);
    expect(run('FILTER({1;2},{1;2}/0)')).toEqual(ERR.div0);
  });

  it('SORT', () => {
    expect(run('SORT({3;1;2})')).toEqual(m([[1], [2], [3]]));
    expect(run('SORT({3;1;2},1,-1)')).toEqual(m([[3], [2], [1]]));
    expect(run('SORT({"b",2;"A",1;"c",3},1,-1)')).toEqual(m([['c', 3], ['b', 2], ['A', 1]]));
    expect(run('SORT({"b",2;"A",1;"c",3},2)')).toEqual(m([['A', 1], ['b', 2], ['c', 3]]));
    expect(run('SORT({"x";1;TRUE;2})')).toEqual(m([[1], [2], ['x'], [true]]));
    expect(run('SORT({3,1,2},1,1,TRUE)')).toEqual(m([[1, 2, 3]]));
    expect(run('SORT({1,"b";2,"a";1,"a"},{1,2},{1,1})')).toEqual(m([[1, 'a'], [1, 'b'], [2, 'a']]));
    expect(run('SORT({1,"b";2,"a";1,"a"},{1,2},-1)')).toEqual(m([[2, 'a'], [1, 'b'], [1, 'a']]));
    expect(run('SORT(J1:J3,1,-1)')).toEqual(m([[3], [1], [null]]));
    expect(run('SORT({1;2},2)')).toEqual(ERR.value);
    expect(run('SORT({1;2},1,0)')).toEqual(ERR.value);
  });

  it('SORTBY', () => {
    expect(run('SORTBY({"a";"b";"c"},{3;1;2})')).toEqual(m([['b'], ['c'], ['a']]));
    expect(run('SORTBY({"a";"b";"c"},{3;1;2},-1)')).toEqual(m([['a'], ['c'], ['b']]));
    expect(run('SORTBY({"a";"b";"c";"d"},{1;2;1;2},-1,{4;3;2;1},1)')).toEqual(m([['d'], ['b'], ['c'], ['a']]));
    expect(run('SORTBY({"a","b","c"},{2,3,1})')).toEqual(m([['c', 'a', 'b']]));
    expect(run('SORTBY({"a";"b"},{1;2;3})')).toEqual(ERR.value);
    expect(run('SORTBY({"a";"b"},{1;2},2)')).toEqual(ERR.value);
  });

  it('UNIQUE', () => {
    expect(run('UNIQUE({1;2;1;3;2})')).toEqual(m([[1], [2], [3]]));
    expect(run('UNIQUE({"a";"A";"b"})')).toEqual(m([['a'], ['b']]));
    expect(run('UNIQUE({1;"1";1})')).toEqual(m([[1], ['1']]));
    expect(run('UNIQUE({1;2;1;3},FALSE,TRUE)')).toEqual(m([[2], [3]]));
    expect(run('UNIQUE({1,2,1},TRUE)')).toEqual(m([[1, 2]]));
    expect(run('UNIQUE({1,"x";1,"X";2,"y"})')).toEqual(m([[1, 'x'], [2, 'y']]));
    expect(run('UNIQUE({1;1},FALSE,TRUE)')).toEqual(ERR.calc);
  });

  it('SEQUENCE', () => {
    expect(run('SEQUENCE(3)')).toEqual(m([[1], [2], [3]]));
    expect(run('SEQUENCE(2,3)')).toEqual(m([[1, 2, 3], [4, 5, 6]]));
    expect(run('SEQUENCE(2,2,10,-1)')).toEqual(m([[10, 9], [8, 7]]));
    expect(run('SEQUENCE(1,3,0,0.5)')).toEqual(m([[0, 0.5, 1]]));
    expect(run('SEQUENCE(0)')).toEqual(ERR.calc);
    expect(run('SEQUENCE(-1)')).toEqual(ERR.value);
  });

  it('VSTACK / HSTACK pad with #N/A', () => {
    expect(run('VSTACK({1,2},{3,4})')).toEqual(m([[1, 2], [3, 4]]));
    expect(run('VSTACK({1,2},3)')).toEqual(m([[1, 2], [3, NA]]));
    expect(run('HSTACK({1;2},{3;4})')).toEqual(m([[1, 3], [2, 4]]));
    expect(run('HSTACK({1;2},5)')).toEqual(m([[1, 5], [2, NA]]));
    expect(run('VSTACK(B1:B2,C1)')).toEqual(m([[1], [2], [10]]));
  });

  it('TAKE / DROP', () => {
    expect(run(`TAKE(${grid},2)`)).toEqual(m([[1, 2, 3], [4, 5, 6]]));
    expect(run(`TAKE(${grid},-1)`)).toEqual(m([[7, 8, 9]]));
    expect(run(`TAKE(${grid},,2)`)).toEqual(m([[1, 2], [4, 5], [7, 8]]));
    expect(run(`TAKE(${grid},10,-1)`)).toEqual(m([[3], [6], [9]]));
    expect(run(`TAKE(${grid},0)`)).toEqual(ERR.calc);
    expect(run(`DROP(${grid},1)`)).toEqual(m([[4, 5, 6], [7, 8, 9]]));
    expect(run(`DROP(${grid},-1,-1)`)).toEqual(m([[1, 2], [4, 5]]));
    expect(run(`DROP(${grid},0,1)`)).toEqual(m([[2, 3], [5, 6], [8, 9]]));
    expect(run(`DROP(${grid},3)`)).toEqual(ERR.calc);
  });

  it('CHOOSECOLS / CHOOSEROWS', () => {
    expect(run(`CHOOSECOLS(${grid},1,3)`)).toEqual(m([[1, 3], [4, 6], [7, 9]]));
    expect(run(`CHOOSECOLS(${grid},-1)`)).toEqual(m([[3], [6], [9]]));
    expect(run(`CHOOSECOLS(${grid},{2,1})`)).toEqual(m([[2, 1], [5, 4], [8, 7]]));
    expect(run(`CHOOSECOLS(${grid},4)`)).toEqual(ERR.value);
    expect(run(`CHOOSECOLS(${grid},0)`)).toEqual(ERR.value);
    expect(run(`CHOOSEROWS(${grid},3,1)`)).toEqual(m([[7, 8, 9], [1, 2, 3]]));
    expect(run(`CHOOSEROWS(${grid},-3)`)).toEqual(m([[1, 2, 3]]));
  });

  it('TOCOL / TOROW', () => {
    expect(run('TOCOL({1,2;3,4})')).toEqual(m([[1], [2], [3], [4]]));
    expect(run('TOCOL({1,2;3,4},0,TRUE)')).toEqual(m([[1], [3], [2], [4]]));
    expect(run('TOROW({1,2;3,4})')).toEqual(m([[1, 2, 3, 4]]));
    expect(run('TOROW(J1:J3)')).toEqual(m([[1, null, 3]]));
    expect(run('TOROW(J1:J3,1)')).toEqual(m([[1, 3]]));
    expect(run('TOCOL({1,#N/A,2},2)')).toEqual(m([[1], [2]]));
    expect(run('TOCOL({1,#N/A,2},4)')).toEqual(ERR.value);
  });

  it('WRAPROWS / WRAPCOLS', () => {
    expect(run('WRAPROWS({1,2,3,4,5},2)')).toEqual(m([[1, 2], [3, 4], [5, NA]]));
    expect(run('WRAPROWS({1,2,3,4,5},2,0)')).toEqual(m([[1, 2], [3, 4], [5, 0]]));
    expect(run('WRAPCOLS({1,2,3,4,5},2)')).toEqual(m([[1, 3, 5], [2, 4, NA]]));
    expect(run('WRAPCOLS({1;2;3;4},2)')).toEqual(m([[1, 3], [2, 4]]));
    expect(run('WRAPROWS({1,2;3,4},2)')).toEqual(ERR.value);
    expect(run('WRAPROWS({1,2},0)')).toEqual(ERR.num);
  });

  it('EXPAND', () => {
    expect(run('EXPAND({1,2;3,4},3,3)')).toEqual(m([[1, 2, NA], [3, 4, NA], [NA, NA, NA]]));
    expect(run('EXPAND({1,2},2,,0)')).toEqual(m([[1, 2], [0, 0]]));
    expect(run('EXPAND({1,2;3,4},1)')).toEqual(ERR.value);
  });
});
