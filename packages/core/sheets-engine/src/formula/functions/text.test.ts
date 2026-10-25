import { describe, expect, it } from 'vitest';
import { testHost } from '../test-host';

const VALUE = { code: '#VALUE!' };
const NA = { code: '#N/A' };

describe('text: slicing and case', () => {
  const run = testHost({ A1: 'a', A3: 'c', B1: 12345 });

  it('LEN, LEFT, RIGHT, MID and the byte variants', () => {
    expect(run('LEN("abc")')).toBe(3);
    expect(run('LEN(123.5)')).toBe(5);
    expect(run('LEN(TRUE)')).toBe(4);
    expect(run('LEN(A2)')).toBe(0);
    expect(run('LENB("abc")')).toBe(3);
    expect(run('LEFT("abc")')).toBe('a');
    expect(run('LEFT("abc",2)')).toBe('ab');
    expect(run('LEFT("abc",10)')).toBe('abc');
    expect(run('LEFT("abc",1.9)')).toBe('a');
    expect(run('LEFT("abc",-1)')).toMatchObject(VALUE);
    expect(run('LEFT(B1,2)')).toBe('12');
    expect(run('LEFTB("abc",2)')).toBe('ab');
    expect(run('RIGHT("abc",2)')).toBe('bc');
    expect(run('RIGHT("abc",0)')).toBe('');
    expect(run('RIGHTB("abc")')).toBe('c');
    expect(run('MID("abcdef",2,3)')).toBe('bcd');
    expect(run('MID("abc",5,2)')).toBe('');
    expect(run('MID("abc",0,1)')).toMatchObject(VALUE);
    expect(run('MIDB("abcdef",2,3)')).toBe('bcd');
  });

  it('propagates errors and lifts over arrays', () => {
    expect(run('LEN(1/0)')).toMatchObject({ code: '#DIV/0!' });
    expect(run('LEFT("abc",1/0)')).toMatchObject({ code: '#DIV/0!' });
    expect(run('LEN(A1:A3)')).toEqual({ kind: 'matrix', rows: 3, cols: 1, data: [[1], [0], [1]] });
    expect(run('UPPER({"a","b"})')).toEqual({ kind: 'matrix', rows: 1, cols: 2, data: [['A', 'B']] });
  });

  it('LOWER, UPPER, PROPER, TRIM and CLEAN', () => {
    expect(run('LOWER("AbC")')).toBe('abc');
    expect(run('UPPER("AbC")')).toBe('ABC');
    expect(run('PROPER("this is a TITLE")')).toBe('This Is A Title');
    expect(run('PROPER("2-way street")')).toBe('2-Way Street');
    expect(run('PROPER("76BudGet")')).toBe('76Budget');
    expect(run('PROPER("don\'t")')).toBe("Don'T");
    expect(run('TRIM("  a   b  ")')).toBe('a b');
    expect(run('CLEAN(CHAR(9)&"a"&CHAR(10))')).toBe('a');
  });
});

describe('text: search and replace', () => {
  const run = testHost();

  it('SUBSTITUTE and REPLACE', () => {
    expect(run('SUBSTITUTE("a-b-c","-","+")')).toBe('a+b+c');
    expect(run('SUBSTITUTE("a-b-c","-","+",2)')).toBe('a-b+c');
    expect(run('SUBSTITUTE("a-b-c","-","+",5)')).toBe('a-b-c');
    expect(run('SUBSTITUTE("abc","","x")')).toBe('abc');
    expect(run('SUBSTITUTE("abc","b","x",0)')).toMatchObject(VALUE);
    expect(run('REPLACE("abcdef",2,3,"X")')).toBe('aXef');
    expect(run('REPLACE("abc",0,1,"X")')).toMatchObject(VALUE);
    expect(run('REPLACEB("abc",1,1,"X")')).toBe('Xbc');
  });

  it('FIND is case-sensitive, SEARCH takes wildcards', () => {
    expect(run('FIND("b","abcb")')).toBe(2);
    expect(run('FIND("b","abcb",3)')).toBe(4);
    expect(run('FIND("B","abc")')).toMatchObject(VALUE);
    expect(run('FIND("","abc")')).toBe(1);
    expect(run('FIND("a","abc",0)')).toMatchObject(VALUE);
    expect(run('FINDB("c","abc")')).toBe(3);
    expect(run('SEARCH("B","abc")')).toBe(2);
    expect(run('SEARCH("b*d","abcd")')).toBe(2);
    expect(run('SEARCH("?c","abc")')).toBe(2);
    expect(run('SEARCH("~*","a*b")')).toBe(2);
    expect(run('SEARCH("a","banana",3)')).toBe(4);
    expect(run('SEARCH("x","abc")')).toMatchObject(VALUE);
    expect(run('SEARCHB("C","abc")')).toBe(3);
  });

  it('REPT and EXACT', () => {
    expect(run('REPT("ab",3)')).toBe('ababab');
    expect(run('REPT("ab",0)')).toBe('');
    expect(run('REPT("a",-1)')).toMatchObject(VALUE);
    expect(run('REPT("abc",20000)')).toMatchObject(VALUE);
    expect(run('EXACT("a","A")')).toBe(false);
    expect(run('EXACT("a","a")')).toBe(true);
    expect(run('EXACT(1,"1")')).toBe(true);
  });
});

describe('text: joining', () => {
  const run = testHost({ A1: 'a', A3: 'c', B1: 1, B2: 2 });

  it('CONCAT, CONCATENATE and TEXTJOIN', () => {
    expect(run('CONCAT(A1:B3)')).toBe('a12c');
    expect(run('CONCAT("x",1.5,TRUE)')).toBe('x1.5TRUE');
    expect(run('CONCATENATE("a",1,TRUE)')).toBe('a1TRUE');
    expect(run('CONCATENATE(A1:A3,"!")')).toEqual({ kind: 'matrix', rows: 3, cols: 1, data: [['a!'], ['!'], ['c!']] });
    expect(run('TEXTJOIN(", ",TRUE,A1:A3)')).toBe('a, c');
    expect(run('TEXTJOIN(", ",FALSE,A1:A3)')).toBe('a, , c');
    expect(run('TEXTJOIN({"-","+"},TRUE,"a","b","c","d")')).toBe('a-b+c-d');
    expect(run('TEXTJOIN(",",TRUE,1/0)')).toMatchObject({ code: '#DIV/0!' });
  });

  it('JOIN and SPLIT (Google Sheets)', () => {
    expect(run('JOIN("-",{1,2,3})')).toBe('1-2-3');
    expect(run('JOIN(", ",A1:A3)')).toBe('a, , c');
    expect(run('SPLIT("a,b,,c",",")')).toEqual({ kind: 'matrix', rows: 1, cols: 3, data: [['a', 'b', 'c']] });
    expect(run('SPLIT("1-2","-")')).toEqual({ kind: 'matrix', rows: 1, cols: 2, data: [[1, 2]] });
    expect(run('SPLIT("a.b-c",".-")')).toEqual({ kind: 'matrix', rows: 1, cols: 3, data: [['a', 'b', 'c']] });
    expect(run('SPLIT("a<>b<c","<>",FALSE)')).toEqual({ kind: 'matrix', rows: 1, cols: 2, data: [['a', 'b<c']] });
    expect(run('SPLIT("a,,b",",",TRUE,FALSE)')).toEqual({ kind: 'matrix', rows: 1, cols: 3, data: [['a', '', 'b']] });
  });
});

describe('text: formatting and parsing numbers', () => {
  const run = testHost();

  it('TEXT', () => {
    expect(run('TEXT(1234.5,"#,##0.00")')).toBe('1,234.50');
    expect(run('TEXT(0.5,"h:mm AM/PM")')).toBe('12:00 PM');
    expect(run('TEXT(45672,"dd-mm-yyyy")')).toBe('15-01-2025');
    expect(run('TEXT(45672,"dddd")')).toBe('Wednesday');
    expect(run('TEXT(0.285,"0.0%")')).toBe('28.5%');
    expect(run('TEXT(-5,"0;(0)")')).toBe('(5)');
    expect(run('TEXT("12","0.00")')).toBe('12.00');
    expect(run('TEXT("2026-01-15","dd/mm/yyyy")')).toBe('15/01/2026');
    expect(run('TEXT("abc","0")')).toBe('abc');
    expect(run('TEXT(TRUE,"0")')).toBe('TRUE');
    expect(run('TEXT(A9,"0.00")')).toBe('0.00');
    expect(run('TEXT(-1,"yyyy")')).toMatchObject(VALUE);
    expect(run('TEXT(1/0,"0")')).toMatchObject({ code: '#DIV/0!' });
  });

  it('VALUE and NUMBERVALUE', () => {
    expect(run('VALUE("12%")')).toBe(0.12);
    expect(run('VALUE("$1,000")')).toBe(1000);
    expect(run('VALUE(" 42 ")')).toBe(42);
    expect(run('VALUE("2026-01-15")')).toBe(46037);
    expect(run('VALUE("13:45")')).toBeCloseTo(13.75 / 24, 12);
    expect(run('VALUE(5)')).toBe(5);
    expect(run('VALUE("abc")')).toMatchObject(VALUE);
    expect(run('VALUE("")')).toMatchObject(VALUE);
    expect(run('VALUE(TRUE)')).toMatchObject(VALUE);
    expect(run('NUMBERVALUE("2.500,27",",",".")')).toBe(2500.27);
    expect(run('NUMBERVALUE("3.5%")')).toBe(0.035);
    expect(run('NUMBERVALUE(" 1 000 ")')).toBe(1000);
    expect(run('NUMBERVALUE("1,5",",",",")')).toMatchObject(VALUE);
    expect(run('NUMBERVALUE("1.2.3")')).toMatchObject(VALUE);
    expect(run('NUMBERVALUE("")')).toBe(0);
  });

  it('FIXED and DOLLAR', () => {
    expect(run('FIXED(1234.567)')).toBe('1,234.57');
    expect(run('FIXED(1234.567,1)')).toBe('1,234.6');
    expect(run('FIXED(1234.567,-1)')).toBe('1,230');
    expect(run('FIXED(-1234.567,-1,TRUE)')).toBe('-1230');
    expect(run('FIXED(44.332)')).toBe('44.33');
    expect(run('FIXED(0.005)')).toBe('0.01');
    expect(run('DOLLAR(1234.567)')).toBe('$1,234.57');
    expect(run('DOLLAR(-1234.567,4)')).toBe('($1,234.5670)');
    expect(run('DOLLAR(1234.567,-2)')).toBe('$1,200');
    expect(run('DOLLAR(99.888)')).toBe('$99.89');
  });

  it('VALUETOTEXT and ARRAYTOTEXT', () => {
    expect(run('VALUETOTEXT("abc")')).toBe('abc');
    expect(run('VALUETOTEXT("a""b",1)')).toBe('"a""b"');
    expect(run('VALUETOTEXT(1.5)')).toBe('1.5');
    expect(run('VALUETOTEXT(TRUE,1)')).toBe('TRUE');
    expect(run('VALUETOTEXT(#N/A)')).toBe('#N/A');
    expect(run('VALUETOTEXT(1,2)')).toMatchObject(VALUE);
    expect(run('ARRAYTOTEXT({1,2;3,"a"})')).toBe('1, 2, 3, a');
    expect(run('ARRAYTOTEXT({1,2;3,"a"},1)')).toBe('{1,2;3,"a"}');
    expect(run('ARRAYTOTEXT(5)')).toBe('5');
  });
});

describe('text: characters', () => {
  const run = testHost();

  it('CHAR, CODE, UNICHAR and UNICODE', () => {
    expect(run('CHAR(65)')).toBe('A');
    expect(run('CHAR(128)')).toBe('€');
    expect(run('CHAR(233)')).toBe('é');
    expect(run('CHAR(0)')).toMatchObject(VALUE);
    expect(run('CHAR(256)')).toMatchObject(VALUE);
    expect(run('CODE("A")')).toBe(65);
    expect(run('CODE("Apple")')).toBe(65);
    expect(run('CODE("€")')).toBe(128);
    expect(run('CODE("é")')).toBe(233);
    expect(run('CODE("☃")')).toBe(63);
    expect(run('CODE("")')).toMatchObject(VALUE);
    expect(run('UNICHAR(9731)')).toBe('☃');
    expect(run('UNICHAR(128512)')).toBe('😀');
    expect(run('UNICHAR(0)')).toMatchObject(VALUE);
    expect(run('UNICHAR(55296)')).toMatchObject(NA);
    expect(run('UNICODE("😀")')).toBe(128512);
    expect(run('UNICODE("")')).toMatchObject(VALUE);
  });

  it('T and HYPERLINK', () => {
    expect(run('T("a")')).toBe('a');
    expect(run('T(1)')).toBe('');
    expect(run('T(TRUE)')).toBe('');
    expect(run('T(1/0)')).toMatchObject({ code: '#DIV/0!' });
    expect(run('HYPERLINK("https://weldsuite.org","Home")')).toBe('Home');
    expect(run('HYPERLINK("https://weldsuite.org")')).toBe('https://weldsuite.org');
    expect(run('HYPERLINK("https://weldsuite.org",42)')).toBe(42);
  });
});

describe('text: TEXTBEFORE, TEXTAFTER, TEXTSPLIT', () => {
  const run = testHost();

  it('TEXTBEFORE and TEXTAFTER', () => {
    expect(run('TEXTBEFORE("Red riding hood\'s red hood","hood")')).toBe('Red riding ');
    expect(run('TEXTBEFORE("a-b-c","-",2)')).toBe('a-b');
    expect(run('TEXTBEFORE("a-b-c","-",-1)')).toBe('a-b');
    expect(run('TEXTAFTER("a-b-c","-")')).toBe('b-c');
    expect(run('TEXTAFTER("a-b-c","-",-1)')).toBe('c');
    expect(run('TEXTBEFORE("abc","x")')).toMatchObject(NA);
    expect(run('TEXTBEFORE("abc","x",,,,"none")')).toBe('none');
    expect(run('TEXTBEFORE("aXb","x",,1)')).toBe('a');
    expect(run('TEXTBEFORE("aXb","x")')).toMatchObject(NA);
    expect(run('TEXTBEFORE("a-b","-",2,,1)')).toBe('a-b');
    expect(run('TEXTAFTER("a-b","-",0)')).toMatchObject(VALUE);
    expect(run('TEXTBEFORE("a,b;c",{",",";"},2)')).toBe('a,b');
    expect(run('TEXTBEFORE("abc","")')).toBe('');
    expect(run('TEXTAFTER("abc","")')).toBe('abc');
    expect(run('TEXTAFTER("abc","",-1)')).toBe('');
  });

  it('TEXTSPLIT', () => {
    expect(run('TEXTSPLIT("a,b,c",",")')).toEqual({ kind: 'matrix', rows: 1, cols: 3, data: [['a', 'b', 'c']] });
    expect(run('TEXTSPLIT("a,b;c,d",",",";")')).toEqual({ kind: 'matrix', rows: 2, cols: 2, data: [['a', 'b'], ['c', 'd']] });
    expect(run('TEXTSPLIT("a,b;c",",",";")')).toMatchObject({ data: [['a', 'b'], ['c', NA]] });
    expect(run('TEXTSPLIT("a,b;c",",",";",,,"-")')).toMatchObject({ data: [['a', 'b'], ['c', '-']] });
    expect(run('TEXTSPLIT("a,,b",",",,TRUE)')).toMatchObject({ data: [['a', 'b']] });
    expect(run('TEXTSPLIT("a1b2c",{"1","2"})')).toMatchObject({ data: [['a', 'b', 'c']] });
    expect(run('TEXTSPLIT("a;b",,";")')).toMatchObject({ data: [['a'], ['b']] });
    expect(run('TEXTSPLIT("aXbxc","x",,,1)')).toMatchObject({ data: [['a', 'b', 'c']] });
    expect(run('TEXTSPLIT("abc",,)')).toMatchObject(VALUE);
  });
});

describe('text: regular expressions', () => {
  const run = testHost();

  it('REGEXMATCH, REGEXTEST, REGEXEXTRACT, REGEXREPLACE', () => {
    expect(run('REGEXMATCH("abc123","\\d+")')).toBe(true);
    expect(run('REGEXMATCH("abc","\\d")')).toBe(false);
    expect(run('REGEXTEST("ABC","abc")')).toBe(false);
    expect(run('REGEXTEST("ABC","abc",1)')).toBe(true);
    expect(run('REGEXEXTRACT("abc123def45","\\d+")')).toBe('123');
    expect(run('REGEXEXTRACT("abc123def45","\\d+",1)')).toEqual({ kind: 'matrix', rows: 2, cols: 1, data: [['123'], ['45']] });
    expect(run('REGEXEXTRACT("abc123","([a-z]+)(\\d+)",2)')).toEqual({ kind: 'matrix', rows: 1, cols: 2, data: [['abc', '123']] });
    expect(run('REGEXEXTRACT("abc","\\d")')).toMatchObject(NA);
    expect(run('REGEXREPLACE("a1b2","\\d","#")')).toBe('a#b#');
    expect(run('REGEXREPLACE("a1b2","\\d","#",2)')).toBe('a1b#');
    expect(run('REGEXREPLACE("a1b2c3","\\d","#",-1)')).toBe('a1b2c#');
    expect(run('REGEXREPLACE("John Smith","(\\w+) (\\w+)","$2, $1")')).toBe('Smith, John');
    expect(run('REGEXREPLACE("John Smith","(\\w+) (\\w+)","$2, $1",1)')).toBe('Smith, John');
    expect(run('REGEXMATCH("abc","(")')).toMatchObject(VALUE);
  });
});
