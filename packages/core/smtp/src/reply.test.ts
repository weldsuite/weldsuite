import { describe, expect, it } from 'vitest';
import { ReplyFormatError, ReplyParser } from './reply';

describe('ReplyParser', () => {
  it('parses a single-line reply', () => {
    const parser = new ReplyParser();
    parser.push('250 2.0.0 OK 1700000000 abc - gsmtp\r\n');
    expect(parser.take()).toEqual({
      code: 250,
      enhancedCode: '2.0.0',
      lines: ['2.0.0 OK 1700000000 abc - gsmtp'],
      text: '250 2.0.0 OK 1700000000 abc - gsmtp',
    });
    expect(parser.pendingLength).toBe(0);
  });

  it('collects a multi-line reply and ends at the line with a space', () => {
    const parser = new ReplyParser();
    parser.push('250-mail.example.test at your service\r\n250-SIZE 35882577\r\n250-AUTH LOGIN PLAIN\r\n250 8BITMIME\r\n');
    const reply = parser.take();
    expect(reply?.code).toBe(250);
    expect(reply?.lines).toEqual(['mail.example.test at your service', 'SIZE 35882577', 'AUTH LOGIN PLAIN', '8BITMIME']);
    expect(reply?.enhancedCode).toBeUndefined();
  });

  it('waits for the rest of a reply split across chunks, even mid-line', () => {
    const parser = new ReplyParser();
    parser.push('250-first li');
    expect(parser.take()).toBeNull();
    parser.push('ne\r\n250 sec');
    expect(parser.take()).toBeNull();
    parser.push('ond line\r');
    expect(parser.take()).toBeNull();
    parser.push('\n');
    expect(parser.take()?.lines).toEqual(['first line', 'second line']);
  });

  it('hands out several replies from one chunk one at a time', () => {
    const parser = new ReplyParser();
    parser.push('250 first\r\n354 second\r\n221 third\r\n');
    expect(parser.take()?.text).toBe('250 first');
    expect(parser.take()?.text).toBe('354 second');
    expect(parser.take()?.text).toBe('221 third');
    expect(parser.take()).toBeNull();
  });

  it('keeps the start of the next reply buffered after a complete one', () => {
    const parser = new ReplyParser();
    parser.push('250 done\r\n354 sta');
    expect(parser.take()?.code).toBe(250);
    expect(parser.pendingLength).toBeGreaterThan(0);
    expect(parser.take()).toBeNull();
    parser.push('rt\r\n');
    expect(parser.take()?.text).toBe('354 start');
  });

  it('accepts a bare code and bare LF line endings', () => {
    const parser = new ReplyParser();
    parser.push('250\n');
    expect(parser.take()).toEqual({ code: 250, lines: [''], text: '250' });
  });

  it('reads the enhanced status code only when its class matches the reply', () => {
    const parser = new ReplyParser();
    parser.push('550 5.1.1 The email account does not exist\r\n');
    expect(parser.take()?.enhancedCode).toBe('5.1.1');

    parser.push('550 2.1.1 contradictory\r\n');
    expect(parser.take()?.enhancedCode).toBeUndefined();

    parser.push('250 Ok 5.1.1 later in the line\r\n');
    expect(parser.take()?.enhancedCode).toBeUndefined();
  });

  it('merges multi-line text into one line without repeating the enhanced code', () => {
    const parser = new ReplyParser();
    parser.push(
      '535-5.7.8 Username and Password not accepted. For more information, go to\r\n' +
        '535 5.7.8  https://support.google.com/mail/?p=BadCredentials x - gsmtp\r\n',
    );
    const reply = parser.take();
    expect(reply?.code).toBe(535);
    expect(reply?.enhancedCode).toBe('5.7.8');
    expect(reply?.text).toBe(
      '535 5.7.8 Username and Password not accepted. For more information, go to https://support.google.com/mail/?p=BadCredentials x - gsmtp',
    );
  });

  it('collapses repeated whitespace in the reply text', () => {
    const parser = new ReplyParser();
    parser.push('250 2.0.0 OK  1700000000 abc.12 - gsmtp\r\n');
    expect(parser.take()?.text).toBe('250 2.0.0 OK 1700000000 abc.12 - gsmtp');
  });

  it('rejects lines that are not SMTP replies', () => {
    const parser = new ReplyParser();
    parser.push('HTTP/1.1 400 Bad Request\r\n');
    expect(() => parser.take()).toThrow(ReplyFormatError);
  });

  it('rejects a four-digit code', () => {
    const parser = new ReplyParser();
    parser.push('2500 nope\r\n');
    expect(() => parser.take()).toThrow(ReplyFormatError);
  });

  it('refuses unbounded input', () => {
    const parser = new ReplyParser();
    expect(() => parser.push('2'.repeat(70 * 1024))).toThrow(ReplyFormatError);
  });
});
