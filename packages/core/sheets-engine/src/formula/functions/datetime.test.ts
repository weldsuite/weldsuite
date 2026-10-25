import { describe, expect, it } from 'vitest';
import { ERR, matrix } from '../../values';
import { testHost } from '../test-host';

const close = (actual: unknown, expected: number, digits = 9) => {
  expect(typeof actual).toBe('number');
  expect(actual as number).toBeCloseTo(expected, digits);
};

describe('DATE / TIME / TODAY / NOW', () => {
  const run = testHost();

  it('DATE builds serials with overflow and the 1900 leap-day bug', () => {
    expect(run('DATE(2024,1,15)')).toBe(45306);
    expect(run('DATE(108,1,2)')).toBe(39449);
    expect(run('DATE(2024,14,1)')).toBe(45689);
    expect(run('DATE(2024,3,0)')).toBe(45351);
    expect(run('DATE(2024,-1,1)')).toBe(45231);
    expect(run('DATE(2024.9,1.9,15.9)')).toBe(45306);
    expect(run('DATE(1900,1,1)')).toBe(1);
    expect(run('DATE(1900,1,0)')).toBe(0);
    expect(run('DATE(1900,2,28)')).toBe(59);
    expect(run('DATE(1900,2,29)')).toBe(60);
    expect(run('DATE(1900,3,0)')).toBe(60);
    expect(run('DATE(1900,1,60)')).toBe(60);
    expect(run('DATE(1900,3,1)')).toBe(61);
    expect(run('DATE(9999,12,31)')).toBe(2_958_465);
  });

  it('DATE errors', () => {
    expect(run('DATE(10000,1,1)')).toEqual(ERR.num);
    expect(run('DATE(9999,12,32)')).toEqual(ERR.num);
    expect(run('DATE(-1,1,1)')).toEqual(ERR.num);
    expect(run('DATE(1900,1,-1)')).toEqual(ERR.num);
    expect(run('DATE("x",1,1)')).toEqual(ERR.value);
    expect(run('DATE({2024;2025},1,1)')).toEqual(matrix([[45292], [45658]]));
  });

  it('TIME', () => {
    expect(run('TIME(12,0,0)')).toBe(0.5);
    close(run('TIME(16,48,10)'), 0.700115740740741);
    expect(run('TIME(27,0,0)')).toBe(0.125);
    close(run('TIME(1,-30,0)'), 1800 / 86_400);
    expect(run('TIME(0,-1,0)')).toEqual(ERR.num);
    expect(run('TIME(32768,0,0)')).toEqual(ERR.num);
  });

  it('TODAY and NOW use the host clock and timezone', () => {
    // The test host's clock is 2026-01-15T10:30:00Z.
    expect(run('TODAY()')).toBe(46037);
    close(run('NOW()'), 46037.4375);
    close(testHost({}, { timezoneOffset: -120 })('NOW()'), 46037 + 12.5 / 24);
    const late = testHost({}, { now: Date.UTC(2026, 0, 15, 23, 30), timezoneOffset: -120 });
    expect(late('TODAY()')).toBe(46038);
    expect(testHost({}, { now: Date.UTC(2026, 0, 15, 2, 0), timezoneOffset: 300 })('TODAY()')).toBe(46036);
  });
});

describe('date and time parts', () => {
  const run = testHost({ A1: 45306.75, A2: '2024-01-15' });

  it('YEAR / MONTH / DAY', () => {
    expect(run('YEAR(A1)')).toBe(2024);
    expect(run('MONTH(A1)')).toBe(1);
    expect(run('DAY(A1)')).toBe(15);
    expect(run('YEAR(A2)')).toBe(2024);
    expect(run('MONTH("Mar 3, 2020")')).toBe(3);
    expect(run('YEAR(0)')).toBe(1900);
    expect(run('MONTH(0)')).toBe(1);
    expect(run('DAY(0)')).toBe(0);
    expect(run('MONTH(60)')).toBe(2);
    expect(run('DAY(60)')).toBe(29);
    expect(run('DAY(61)')).toBe(1);
    expect(run('YEAR(-1)')).toEqual(ERR.num);
    expect(run('YEAR(2958466)')).toEqual(ERR.num);
    expect(run('YEAR("abc")')).toEqual(ERR.value);
  });

  it('HOUR / MINUTE / SECOND', () => {
    expect(run('HOUR(A1)')).toBe(18);
    expect(run('HOUR(0.75)')).toBe(18);
    expect(run('MINUTE("12:45:30")')).toBe(45);
    expect(run('SECOND("12:45:30")')).toBe(30);
    expect(run('HOUR("3:30 PM")')).toBe(15);
    expect(run('HOUR("2024-01-15 22:05")')).toBe(22);
    expect(run('SECOND(TIME(10,20,30))')).toBe(30);
    // Rounded to the nearest second, so floating-point noise never shows as 29.
    expect(run('SECOND("0:00:15.6")')).toBe(16);
    expect(run('MINUTE(TIME(0,59,59.6))')).toBe(59);
    expect(run('HOUR(-0.5)')).toEqual(ERR.num);
  });

  it('WEEKDAY return types', () => {
    // 2008-02-14 is a Thursday (Excel docs example).
    expect(run('WEEKDAY(DATE(2008,2,14))')).toBe(5);
    expect(run('WEEKDAY(DATE(2008,2,14),2)')).toBe(4);
    expect(run('WEEKDAY(DATE(2008,2,14),3)')).toBe(3);
    const types = [11, 12, 13, 14, 15, 16, 17].map((t) => run(`WEEKDAY(DATE(2008,2,14),${t})`));
    expect(types).toEqual([4, 3, 2, 1, 7, 6, 5]);
    expect(run('WEEKDAY(DATE(2008,2,14),4)')).toEqual(ERR.num);
    // Excel's calendar: 1900-01-01 is a Sunday, the fake 1900-02-29 a Wednesday.
    expect(run('WEEKDAY(1)')).toBe(1);
    expect(run('WEEKDAY(0)')).toBe(7);
    expect(run('WEEKDAY(60)')).toBe(4);
    expect(run('WEEKDAY(61)')).toBe(5);
  });

  it('WEEKNUM and ISOWEEKNUM', () => {
    expect(run('WEEKNUM(DATE(2012,3,9))')).toBe(10);
    expect(run('WEEKNUM(DATE(2012,3,9),2)')).toBe(11);
    expect(run('WEEKNUM(DATE(2012,3,9),21)')).toBe(10);
    expect(run('WEEKNUM(DATE(2012,1,1),2)')).toBe(1);
    expect(run('WEEKNUM(DATE(2012,1,2),2)')).toBe(2);
    expect(run('WEEKNUM(DATE(2012,1,2),17)')).toBe(1);
    expect(run('WEEKNUM(DATE(2012,3,9),3)')).toEqual(ERR.num);
    expect(run('ISOWEEKNUM(DATE(2012,3,9))')).toBe(10);
    expect(run('ISOWEEKNUM(DATE(2021,1,1))')).toBe(53);
    expect(run('ISOWEEKNUM(DATE(2024,12,30))')).toBe(1);
    expect(run('WEEKNUM(DATE(2021,1,1),21)')).toBe(53);
  });
});

describe('date arithmetic', () => {
  const run = testHost();

  it('EDATE and EOMONTH (Excel docs examples and month ends)', () => {
    expect(run('EDATE(DATE(2011,1,15),1)')).toBe(40589);
    expect(run('EDATE(DATE(2011,1,15),-1)')).toBe(40527);
    expect(run('EDATE(DATE(2011,1,15),2)')).toBe(40617);
    expect(run('EDATE(DATE(2011,1,31),1)')).toBe(40602);
    expect(run('EDATE(DATE(2024,1,31),1)')).toBe(45351);
    expect(run('EDATE(DATE(2024,3,31),-1.9)')).toBe(45351);
    expect(run('EDATE("2024-01-15 18:00",0)')).toBe(45306);
    expect(run('EOMONTH(DATE(2011,1,1),1)')).toBe(40602);
    expect(run('EOMONTH(DATE(2011,1,1),-3)')).toBe(40482);
    expect(run('EOMONTH(DATE(2024,1,15),1)')).toBe(45351);
    expect(run('EOMONTH(DATE(1900,1,15),1)')).toBe(60);
    expect(run('EOMONTH(DATE(1900,1,15),-1)')).toEqual(ERR.num);
    expect(run('EDATE(DATE(9999,12,1),1)')).toEqual(ERR.num);
  });

  it('DATEDIF', () => {
    expect(run('DATEDIF(DATE(2001,1,1),DATE(2003,1,1),"Y")')).toBe(2);
    expect(run('DATEDIF(DATE(2001,6,1),DATE(2002,8,15),"D")')).toBe(440);
    expect(run('DATEDIF(DATE(2001,6,1),DATE(2002,8,15),"YD")')).toBe(75);
    expect(run('DATEDIF(DATE(2001,6,1),DATE(2002,8,15),"M")')).toBe(14);
    expect(run('DATEDIF(DATE(2001,6,1),DATE(2002,8,15),"ym")')).toBe(2);
    expect(run('DATEDIF(DATE(2001,6,1),DATE(2002,8,15),"MD")')).toBe(14);
    expect(run('DATEDIF(DATE(2001,6,15),DATE(2002,6,14),"Y")')).toBe(0);
    expect(run('DATEDIF(DATE(2001,6,15),DATE(2002,6,14),"M")')).toBe(11);
    expect(run('DATEDIF(DATE(2024,1,31),DATE(2024,3,1),"M")')).toBe(1);
    // Excel's MD quirk is reproduced.
    expect(run('DATEDIF(DATE(2015,1,31),DATE(2015,3,1),"MD")')).toBe(-2);
    expect(run('DATEDIF(DATE(2003,1,1),DATE(2001,1,1),"Y")')).toEqual(ERR.num);
    expect(run('DATEDIF(DATE(2001,1,1),DATE(2003,1,1),"X")')).toEqual(ERR.num);
  });

  it('DAYS and DAYS360', () => {
    expect(run('DAYS(DATE(2021,3,15),DATE(2021,2,1))')).toBe(42);
    expect(run('DAYS("3/15/2021","2/1/2021")')).toBe(42);
    expect(run('DAYS(DATE(2021,2,1),DATE(2021,3,15.9))')).toBe(-42);
    expect(run('DAYS("x",1)')).toEqual(ERR.value);
    expect(run('DAYS360(DATE(2011,1,30),DATE(2011,12,31))')).toBe(330);
    expect(run('DAYS360(DATE(2011,1,30),DATE(2011,12,31),TRUE)')).toBe(330);
    expect(run('DAYS360(DATE(2011,1,15),DATE(2011,1,31))')).toBe(16);
    expect(run('DAYS360(DATE(2011,1,15),DATE(2011,1,31),TRUE)')).toBe(15);
    expect(run('DAYS360(DATE(2011,2,28),DATE(2011,3,31))')).toBe(30);
    expect(run('DAYS360(DATE(2011,2,28),DATE(2011,3,31),TRUE)')).toBe(32);
    expect(run('DAYS360(DATE(2011,12,15),DATE(2011,12,31))')).toBe(16);
    expect(run('DAYS360(DATE(2012,1,1),DATE(2011,1,1))')).toBe(-360);
  });

  it('YEARFRAC bases (Excel docs example and more)', () => {
    close(run('YEARFRAC(DATE(2012,1,1),DATE(2012,7,30))'), 0.580555555555556);
    close(run('YEARFRAC(DATE(2012,1,1),DATE(2012,7,30),1)'), 211 / 366);
    close(run('YEARFRAC(DATE(2012,1,1),DATE(2012,7,30),2)'), 211 / 360);
    close(run('YEARFRAC(DATE(2012,1,1),DATE(2012,7,30),3)'), 211 / 365);
    close(run('YEARFRAC(DATE(2012,1,1),DATE(2012,7,30),4)'), 209 / 360);
    close(run('YEARFRAC(DATE(2012,7,30),DATE(2012,1,1))'), 0.580555555555556);
    close(run('YEARFRAC(DATE(2011,1,1),DATE(2013,6,30),1)'), 2.49361313868613);
    close(run('YEARFRAC(DATE(2011,3,1),DATE(2012,2,29),1)'), 365 / 366);
    close(run('YEARFRAC(DATE(2011,2,28),DATE(2012,2,29),0)'), 1);
    close(run('YEARFRAC(DATE(2011,1,31),DATE(2011,3,31),0)'), 60 / 360);
    expect(run('YEARFRAC(DATE(2012,1,1),DATE(2012,7,30),5)')).toEqual(ERR.num);
  });
});

describe('DATEVALUE / TIMEVALUE', () => {
  const run = testHost({ A1: 45306 });

  it('DATEVALUE parses the supported formats (Excel docs examples)', () => {
    expect(run('DATEVALUE("8/22/2011")')).toBe(40777);
    expect(run('DATEVALUE("22-MAY-2011")')).toBe(40685);
    expect(run('DATEVALUE("2011/02/23")')).toBe(40597);
    expect(run('DATEVALUE("2024-01-15")')).toBe(45306);
    expect(run('DATEVALUE("Jan 15, 2024")')).toBe(45306);
    expect(run('DATEVALUE("January 15 2024")')).toBe(45306);
    expect(run('DATEVALUE("15 Jan 2024")')).toBe(45306);
    expect(run('DATEVALUE("Sept 1, 2024")')).toBe(45536);
    expect(run('DATEVALUE("1/15/24")')).toBe(45306);
    expect(run('DATEVALUE("1/15/45")')).toBe(16452);
    expect(run('DATEVALUE("2024-01-15 10:30")')).toBe(45306);
    expect(run('DATEVALUE("2024-01-15T10:30:00")')).toBe(45306);
    expect(run('DATEVALUE("2/29/1900")')).toBe(60);
    expect(run('DATEVALUE("10:30")')).toBe(0);
  });

  it('DATEVALUE rejects invalid dates and non-text', () => {
    expect(run('DATEVALUE("2/29/2023")')).toEqual(ERR.value);
    expect(run('DATEVALUE("13/1/2024")')).toEqual(ERR.value);
    expect(run('DATEVALUE("hello")')).toEqual(ERR.value);
    expect(run('DATEVALUE("45306")')).toEqual(ERR.value);
    expect(run('DATEVALUE(A1)')).toEqual(ERR.value);
    expect(run('DATEVALUE("2024-01-15 25:61")')).toEqual(ERR.value);
  });

  it('TIMEVALUE', () => {
    close(run('TIMEVALUE("2:24 AM")'), 0.1);
    close(run('TIMEVALUE("22-Aug-2011 6:35 AM")'), 0.274305555555556);
    expect(run('TIMEVALUE("12:00 AM")')).toBe(0);
    close(run('TIMEVALUE("12:30 PM")'), 0.520833333333333);
    close(run('TIMEVALUE("6 pm")'), 0.75);
    close(run('TIMEVALUE("18:30:15")'), 66_615 / 86_400);
    close(run('TIMEVALUE("25:00")'), 1 / 24);
    expect(run('TIMEVALUE("2024-01-15")')).toBe(0);
    expect(run('TIMEVALUE("13:00 PM")')).toEqual(ERR.value);
    expect(run('TIMEVALUE("10:61")')).toEqual(ERR.value);
    expect(run('TIMEVALUE(0.5)')).toEqual(ERR.value);
  });
});

describe('working days', () => {
  const run = testHost({
    A1: '=DATE(2012,11,22)',
    A2: '=DATE(2012,12,4)',
    A3: '=DATE(2013,1,21)',
    B1: '=DATE(2008,11,26)',
    B2: '=DATE(2008,12,4)',
    B3: '=DATE(2009,1,21)',
    C1: 'not a date',
  });

  it('NETWORKDAYS (Excel docs example)', () => {
    expect(run('NETWORKDAYS(DATE(2012,10,1),DATE(2013,3,1))')).toBe(110);
    expect(run('NETWORKDAYS(DATE(2012,10,1),DATE(2013,3,1),DATE(2012,11,22))')).toBe(109);
    expect(run('NETWORKDAYS(DATE(2012,10,1),DATE(2013,3,1),A1:A3)')).toBe(107);
    expect(run('NETWORKDAYS(DATE(2013,3,1),DATE(2012,10,1),A1:A3)')).toBe(-107);
    // A holiday on a weekend or twice in the list counts once.
    expect(run('NETWORKDAYS(DATE(2012,10,1),DATE(2013,3,1),{41235,41235,41237})')).toBe(109);
    expect(run('NETWORKDAYS(DATE(2024,1,6),DATE(2024,1,7))')).toBe(0);
    expect(run('NETWORKDAYS(DATE(2024,1,8),DATE(2024,1,8))')).toBe(1);
    expect(run('NETWORKDAYS(DATE(2012,10,1),DATE(2013,3,1),C1)')).toEqual(ERR.value);
    expect(run('NETWORKDAYS(-1,5)')).toEqual(ERR.num);
  });

  it('NETWORKDAYS.INTL (Excel docs examples)', () => {
    expect(run('NETWORKDAYS.INTL(DATE(2006,1,1),DATE(2006,1,31))')).toBe(22);
    expect(run('NETWORKDAYS.INTL(DATE(2006,2,28),DATE(2006,1,31))')).toBe(-21);
    expect(run('NETWORKDAYS.INTL(DATE(2006,1,1),DATE(2006,2,1),7,{"2006/1/2","2006/1/16"})')).toBe(22);
    expect(run('NETWORKDAYS.INTL(DATE(2006,1,1),DATE(2006,2,1),"0010001",{"2006/1/2","2006/1/16"})')).toBe(20);
    expect(run('NETWORKDAYS.INTL(DATE(2006,1,1),DATE(2006,1,31),11)')).toBe(26);
    expect(run('NETWORKDAYS.INTL(DATE(2006,1,1),DATE(2006,1,31),"0000000")')).toBe(31);
    expect(run('NETWORKDAYS.INTL(DATE(2006,1,1),DATE(2006,1,31),8)')).toEqual(ERR.num);
    expect(run('NETWORKDAYS.INTL(DATE(2006,1,1),DATE(2006,1,31),"000001")')).toEqual(ERR.value);
    expect(run('NETWORKDAYS.INTL(DATE(2006,1,1),DATE(2006,1,31),"1111111")')).toEqual(ERR.value);
  });

  it('WORKDAY and WORKDAY.INTL (Excel docs examples)', () => {
    expect(run('WORKDAY(DATE(2008,10,1),151)')).toBe(39933);
    expect(run('WORKDAY(DATE(2008,10,1),151,B1:B3)')).toBe(39938);
    expect(run('WORKDAY(DATE(2008,10,1),151.9,B1:B3)')).toBe(39938);
    expect(run('WORKDAY(DATE(2024,1,6),0)')).toBe(45297);
    expect(run('WORKDAY(DATE(2024,1,6),1)')).toBe(45299);
    expect(run('WORKDAY(DATE(2024,1,8),-1)')).toBe(45296);
    expect(run('WORKDAY(DATE(2009,4,30),-151)')).toBe(39722);
    expect(run('WORKDAY(DATE(2009,5,5),-151,B1:B3)')).toBe(39722);
    expect(run('WORKDAY.INTL(DATE(2012,1,1),30,0)')).toEqual(ERR.num);
    expect(run('WORKDAY.INTL(DATE(2012,1,1),90,11)')).toBe(41013);
    expect(run('WORKDAY.INTL(DATE(2012,1,1),30,17)')).toBe(40944);
    expect(run('WORKDAY.INTL(DATE(2012,1,1),5,"1111100")')).toBe(40929);
    expect(run('WORKDAY(DATE(9999,12,30),5)')).toEqual(ERR.num);
    expect(run('WORKDAY(10,-20)')).toEqual(ERR.num);
  });
});
