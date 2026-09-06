import { createReadStream } from 'node:fs';
import { parse, type Parser } from 'csv-parse';

export interface ParsedTable {
  headers: string[];
  delimiter: string;
  totalRows: number;
  sampleRows: Array<Record<string, string>>;
}

function sniffDelimiter(headerLine: string): string {
  const candidates = [',', ';', '\t'];
  let best = ',';
  let bestCount = 0;
  for (const delimiter of candidates) {
    const count = headerLine.split(delimiter).length - 1;
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function streamRows(path: string, delimiter: string): Parser {
  return createReadStream(path).pipe(
    parse({
      columns: true,
      delimiter,
      trim: true,
      skip_empty_lines: true,
      relax_column_count: true,
      bom: true,
    }),
  );
}

export async function readHeaderLine(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(path, { encoding: 'utf8' });
    let buffer = '';
    stream.on('data', (chunk: string | Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline >= 0) {
        stream.destroy();
        resolve(stripBom(buffer.slice(0, newline).replace(/\r$/, '')));
      }
    });
    stream.on('end', () => resolve(stripBom(buffer.replace(/\r$/, ''))));
    stream.on('error', reject);
  });
}

/**
 * Single streaming pass: headers, delimiter, total data rows, first N sample
 * rows. The file is never fully buffered — this is what keeps 50k+ row
 * uploads bounded in memory.
 */
export async function inspectCsv(path: string, sampleSize = 10): Promise<ParsedTable> {
  const headerLine = await readHeaderLine(path);
  if (!headerLine.trim()) throw new Error('File has no header row');
  const delimiter = sniffDelimiter(headerLine);
  const headers = headerLine.split(delimiter).map((h) => stripBom(h).trim());

  return new Promise((resolve, reject) => {
    let totalRows = 0;
    const sampleRows: Array<Record<string, string>> = [];
    const parser = streamRows(path, delimiter);
    parser.on('readable', () => {
      let record: Record<string, string> | null;
      while ((record = parser.read() as Record<string, string> | null) !== null) {
        totalRows += 1;
        if (sampleRows.length < sampleSize) sampleRows.push(record);
      }
    });
    parser.on('error', reject);
    parser.on('end', () => resolve({ headers, delimiter, totalRows, sampleRows }));
  });
}

export async function* iterateRows(
  path: string,
  delimiter: string,
): AsyncGenerator<{ index: number; row: Record<string, string> }> {
  const parser = streamRows(path, delimiter);
  let index = 0;
  for await (const record of parser as AsyncIterable<Record<string, string>>) {
    index += 1;
    yield { index, row: record };
  }
}

/** Guards CSV exports against spreadsheet formula injection. */
export function safeCell(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

interface VCard {
  [key: string]: string;
}

/** Minimal vCard parser (FN/N/EMAIL/TEL/TITLE/ORG). Returns one object per card. */
export function parseVcf(text: string): VCard[] {
  const unfolded = stripBom(text)
    .replace(/\r\n[ \t]/g, '')
    .replace(/\n[ \t]/g, '');
  const cards: VCard[] = [];
  const blocks = unfolded.split(/BEGIN:VCARD/i);
  for (const block of blocks) {
    if (!/END:VCARD/i.test(block)) continue;
    const card: VCard = {};
    for (const line of block.split(/\r?\n/)) {
      const match = /^([^:;]+)(;[^:]*)?:(.*)$/.exec(line.trim());
      if (!match) continue;
      const name = match[1]!.toUpperCase();
      const value = match[3]!.replace(/\\n/gi, ' ').replace(/\\,/g, ',').trim();
      if (!value) continue;
      if (name === 'FN' && !card['FN']) card['FN'] = value;
      else if (name === 'N' && !card['N']) card['N'] = value;
      else if ((name === 'EMAIL' || name.startsWith('EMAIL;')) && !card['EMAIL'])
        card['EMAIL'] = value;
      else if ((name === 'TEL' || name.startsWith('TEL;')) && !card['TEL']) card['TEL'] = value;
      else if (name === 'TITLE' && !card['TITLE']) card['TITLE'] = value;
      else if (name === 'ORG' && !card['ORG']) card['ORG'] = value.split(';')[0] ?? value;
    }
    if (Object.keys(card).length > 0) cards.push(card);
  }
  return cards;
}

/** Normalizes parsed vCards into import rows with a fixed column set. */
export function vcfToRows(cards: VCard[]): {
  headers: string[];
  rows: Array<Record<string, string>>;
} {
  const headers = ['name', 'firstName', 'lastName', 'email', 'phone', 'title', 'accountName'];
  const rows = cards.map((card) => {
    let firstName = '';
    let lastName = '';
    if (card['N']) {
      const parts = card['N'].split(';');
      lastName = parts[0] ?? '';
      firstName = parts[1] ?? '';
    }
    return {
      name: card['FN'] ?? `${firstName} ${lastName}`.trim(),
      firstName,
      lastName,
      email: card['EMAIL'] ?? '',
      phone: card['TEL'] ?? '',
      title: card['TITLE'] ?? '',
      accountName: card['ORG'] ?? '',
    };
  });
  return { headers, rows };
}

export function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}
