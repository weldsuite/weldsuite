import { describe, expect, it } from 'vitest';
import { parseXml, scanXml } from './xml';
import { crc32, openZip, writeZip, ZipError } from './zip';

const text = (s: string) => new TextEncoder().encode(s);

describe('zip', () => {
  it('writes entries and reads them back, by name in any case', async () => {
    const zip = await writeZip([
      { name: 'xl/workbook.xml', data: '<workbook/>' },
      { name: 'docs/ünïcode.txt', data: 'héllo '.repeat(1000) },
      { name: 'empty.bin', data: new Uint8Array(0) },
    ]);
    const reader = openZip(zip);
    expect(reader.names()).toEqual(['xl/workbook.xml', 'docs/ünïcode.txt', 'empty.bin']);
    expect(await reader.readText('XL/Workbook.xml')).toBe('<workbook/>');
    expect(await reader.readText('/docs/ünïcode.txt')).toBe('héllo '.repeat(1000));
    expect((await reader.read('empty.bin'))?.byteLength).toBe(0);
    expect(await reader.read('missing.xml')).toBeNull();
  });

  it('reads stored (uncompressed) entries', async () => {
    expect(await openZip(storedZip('a.txt', 'plain')).readText('a.txt')).toBe('plain');
  });

  it('refuses what is not a zip, damaged entries and entries that expand too far', async () => {
    expect(() => openZip(text('just some text'))).toThrow(ZipError);
    const zip = storedZip('a.txt', 'plain');
    zip[zip.indexOf(0x70)] = 0x71; // 'p' → 'q' in the stored data, so the checksum fails
    await expect(openZip(zip).read('a.txt')).rejects.toMatchObject({ code: 'corrupt' });
    const bomb = await writeZip([{ name: 'zeros', data: new Uint8Array(5_000_000) }]);
    expect(bomb.byteLength).toBeLessThan(20_000);
    await expect(openZip(bomb, { maxEntrySize: 1_000_000 }).read('zeros')).rejects.toMatchObject({ code: 'too_large' });
  });
});

/** A one-entry archive with the entry stored, built by hand. */
function storedZip(name: string, content: string): Uint8Array {
  const n = text(name);
  const data = text(content);
  const crc = crc32(data);
  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true);
  local.setUint32(14, crc, true);
  local.setUint32(18, data.length, true);
  local.setUint32(22, data.length, true);
  local.setUint16(26, n.length, true);
  const central = new DataView(new ArrayBuffer(46));
  central.setUint32(0, 0x02014b50, true);
  central.setUint32(16, crc, true);
  central.setUint32(20, data.length, true);
  central.setUint32(24, data.length, true);
  central.setUint16(28, n.length, true);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, 1, true);
  end.setUint16(10, 1, true);
  end.setUint32(12, 46 + n.length, true);
  end.setUint32(16, 30 + n.length + data.length, true);
  const parts = [new Uint8Array(local.buffer), n, data, new Uint8Array(central.buffer), n, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe('xml', () => {
  it('reads elements, attributes, entities, CDATA and prefixed names', () => {
    const root = parseXml(
      '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><!-- note --><x:root xmlns:x="urn:x" a="1 &gt; 0" b=\'q"\' x:c="p"><x:v>&lt;A&amp;B&#65;&#x42;</x:v><w><![CDATA[<raw>]]></w><e/></x:root>',
    );
    expect(root.name).toBe('root');
    expect(root.attrs).toEqual({ a: '1 > 0', b: 'q"', c: 'p' });
    expect(root.children.map((c) => [c.name, c.text])).toEqual([
      ['v', '<A&BAB'],
      ['w', '<raw>'],
      ['e', ''],
    ]);
  });

  it('finds the end of a tag past a ">" inside quotes', () => {
    const seen: string[] = [];
    scanXml('<f a="x>y"/><g>t</g>', { open: (name, a) => seen.push(`${name}:${a.a ?? ''}`), text: (t) => seen.push(t) });
    expect(seen).toEqual(['f:x>y', 'g:', 't']);
  });
});
