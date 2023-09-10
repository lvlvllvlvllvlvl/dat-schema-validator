import {
  ColumnStats,
  DatFile,
  Header,
  getHeaderLength,
  readColumn,
  validateHeader,
} from "pathofexile-dat/dat.js";
import { NamedHeader } from "./datfile.js";

const MAX_POSSIBLES = 100;
const sleep = () => new Promise((resolve) => setImmediate(resolve));

export const headerTypes = {
  "[rid]": { array: true, key: { foreign: true } },
  "[i32]": { array: true, integer: { unsigned: false, size: 4 } },
  "[f32]": { array: true, decimal: { size: 4 } },
  "[row]": { array: true, key: { foreign: false } },
  "[string]": { array: true, string: {} },
  string: { array: false, string: {} },
  rid: { array: false, key: { foreign: true } },
  i32: { array: false, integer: { unsigned: false, size: 4 } },
  f32: { array: false, decimal: { size: 4 } },
  row: { array: false, key: { foreign: false } },
  bool: { array: false, boolean: true },
} as const;

export function typeEq(l: Header["type"], r: Header["type"]) {
  return (
    !!l.array === !!r.array &&
    !!l.boolean === !!r.boolean &&
    !!l.string === !!r.string &&
    !!l.key === !!r.key &&
    !!l.key?.foreign === !!r.key?.foreign &&
    !!l.integer === !!r.integer &&
    !!l.integer?.unsigned === !!r.integer?.unsigned &&
    l.integer?.size === r.integer?.size &&
    !!l.decimal === !!r.decimal &&
    l.decimal?.size === r.decimal?.size
  );
}

export function typeEqDebug(l: Header["type"], r: Header["type"]) {
  if (!!l.array !== !!r.array) return "array";
  if (!!l.boolean !== !!r.boolean) return "boolean";
  if (!!l.string !== !!r.string) return "string";
  if (!!l.key !== !!r.key) return "key";
  if (!!l.key?.foreign !== !!r.key?.foreign) return "foreign";
  if (!!l.integer !== !!r.integer) return "integer";
  if (!!l.integer?.unsigned !== !!r.integer?.unsigned) return "unsigned";
  if (l.integer?.size !== r.integer?.size) return "size";
  if (!!l.decimal !== !!r.decimal) return "decimal";
  if (l.decimal?.size !== r.decimal?.size) return "size";
}

export type HeaderType = (typeof headerTypes)[keyof typeof headerTypes];
export type HeaderTypesEntries = {
  [K in keyof typeof headerTypes]: [K, (typeof headerTypes)[K]];
}[keyof typeof headerTypes][];

export type PossibleHeaders = (NamedHeader | NamedHeader[])[];
export type ValidFn = (header: Header) => boolean;
export type LenFn = (header: Header) => number;

export async function getPossibleHeaders(
  headers: PossibleHeaders,
  stats: ColumnStats[][],
  datFiles: DatFile[]
): Promise<PossibleHeaders[]> {
  const maxOffset = datFiles[0].rowLength;
  const len = (header: NamedHeader) => header.size || getHeaderLength(header, datFiles[0]);
  const last = headers[headers.length - 1];
  const offset = last
    ? Array.isArray(last)
      ? last[0].offset + last.map(len).reduce((l, r) => (l && r ? assertEq(l, r, headers) : l || r))
      : last.offset + len(last)
    : 0;

  if (offset === maxOffset) {
    await sleep();
    return [headers];
  } else if (offset > maxOffset) {
    await sleep();
    return [];
  }

  var possibleHeaders = possibleColumnHeaders(offset, stats, datFiles, Object.values(headerTypes));
  if (!possibleHeaders.length) {
    return [];
  }

  var exact = [] as PossibleHeaders[];
  for (const type of possibleHeaders) {
    const possibles = await getPossibleHeaders(headers.concat([type]), stats, datFiles);
    for (const possible of possibles) {
      let end = possible[possible.length - 1];
      end = Array.isArray(end) ? end[0] : end;
      if (maxOffset === end.offset + len(end)) {
        exact.push(possible);
      }
    }
    if (exact.length) {
      return exact.sort((a, b) => a.length - b.length).slice(0, MAX_POSSIBLES);
    }
  }
  return [];
}

export function possibleColumnHeaders(
  offset: number,
  stats: ColumnStats[][],
  datFiles: DatFile[],
  types: HeaderType[]
) {
  const valid = (header: Header) => {
    if (!stats.every((s) => validateHeader(header, s))) {
      return false;
    }
    if (header.type.string && !isString(header, datFiles)) {
      return false;
    }
    return true;
  };
  var possibleHeaders = types
    .map((type) => ({ type, offset } as NamedHeader))
    .filter(valid)
    .reduce((result, header) => {
      const size = header.size || getHeaderLength(header, datFiles[0]);
      header.size = size;
      const existing = result.find((v) => v[0].size === size);
      if (existing) {
        existing.push(header);
      } else {
        result.push([header]);
      }
      return result;
    }, [] as NamedHeader[][])
    .filter((exists) => exists && exists.length);

  // if this looks like a bool column and isn't an array, make bool the first option
  if (
    (stats[0].length === offset + 1 ||
      stats.every((s) => s[offset].maxValue === 1) ||
      stats.every((s) => s[offset].maxValue === 0 && s[offset + 1].maxValue !== 0)) &&
    possibleHeaders.length > 1 &&
    !possibleHeaders.find((h) => h[0].type.array)
  ) {
    const bool = possibleHeaders.pop()!;
    if (bool[0].type.boolean) {
      possibleHeaders.unshift(bool);
    } else {
      console.warn("last header was not boolean");
      possibleHeaders.push(bool);
    }
  }
  return possibleHeaders.map((arr) => (arr.length === 1 ? arr[0] : arr));
}

export function guess(possibles: PossibleHeaders, datFile: DatFile): NamedHeader[] {
  return possibles.map((p) => (Array.isArray(p) ? guessType(p, datFile) : p));
}

function assertEq(l: number, r: number, msg: any) {
  if (l !== r) {
    console.debug(msg);
    throw "offsets should be equal here";
  }
  return l;
}

export function guessType(possibles: NamedHeader[], datFile: DatFile): NamedHeader {
  let header =
    possibles.find((p) => p.type.string) ||
    looksLikeFloat(possibles, datFile) ||
    possibles.find((p) => !p.type.decimal) ||
    possibles[0];

  let hasValue = readColumn(header, datFile).find((v) => (Array.isArray(v) ? v.find((i) => i) : v));
  if (!hasValue && header.type.string) {
    header =
      looksLikeFloat(possibles, datFile) ||
      possibles.find((p) => !p.type.decimal && !p.type.string) ||
      possibles[0];
  }
  hasValue = readColumn(header, datFile).find((v) => (Array.isArray(v) ? v.length : v));
  if (!hasValue) {
    header.noData = true;
  }
  if (header.type.array && !header.type.string) {
    header.unknownArray = true;
  }

  return header;
}

const SMALLEST_NORMAL_F32 = Math.pow(2, -126);
function looksLikeFloat(possibles: NamedHeader[], datFile: DatFile): NamedHeader | undefined {
  const header = possibles.find((p) => p.type.decimal);
  if (!header) {
    return;
  }
  const floats = readColumn(header, datFile).flatMap((v) => v);

  //denormalized values are unlikely to be floats
  //https://stackoverflow.com/a/2485520/2063518
  if (floats.find((f) => f !== 0 && Math.abs(f as number) < SMALLEST_NORMAL_F32)) {
    return;
  }

  const other = possibles.find((p) => !p.type.decimal);
  if (other) {
    const floatSum = floats.map(String).reduce((sum, v) => sum + v.length, 0);
    const otherSum = readColumn(other, datFile)
      .flatMap((v) => v)
      .map(String)
      .reduce((sum, v) => sum + v.length, 0);

    //kolmogorov complexity; 5.5 is more likely to be a relevant value than 1085276160
    //https://stackoverflow.com/a/2489280/2063518
    if (floatSum < otherSum) {
      return header;
    }
  }
}

function isString(header: NamedHeader, datFiles: DatFile[]) {
  return !datFiles.find((datFile) =>
    readColumn(header, datFile).find((v) =>
      Array.isArray(v) ? v.find(unprintable) : unprintable(v)
    )
  );
}

function unprintable(data: any) {
  return /[\x00-\x08\x0E-\x1F]/.test(data);
}

export function toGraphql(headers: NamedHeader[]): string[] {
  return headers.map((h) => {
    return `${h.name || "_"}: ${graphqlType(h).replace("rid", h.type.key?.name || "rid")}`;
  });
}
export function graphqlType(header: NamedHeader): string {
  const type = Object.entries(headerTypes).find(([_, value]) => typeEq(value, header.type));
  if (!type?.[0]) {
    console.warn(
      "didn't recognize type",
      Object.values(headerTypes).map((value) => typeEqDebug(value, header.type)),
      header
    );
    return "<unknown>";
  }
  return type[0];
}
