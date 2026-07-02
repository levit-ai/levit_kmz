import type { HeightField, PlacemarkSource } from './kmlPlacemarks';

export type HeightEditTarget = {
  /** 0-based position among all Placemarks in the file, in document order. */
  ordinal: number;
  /** wpml:index, used to verify/locate the block when present. */
  index?: number;
  source: PlacemarkSource;
  /** Field the displayed height came from; edits prefer writing the same field back. */
  heightField?: HeightField;
};

type Block = { start: number; end: number; text: string };

/**
 * Returns the document with the target placemark's height replaced, or null if the
 * placemark (or an editable height field within it) could not be located. Edits are
 * textual and targeted so the rest of the file keeps its exact formatting.
 */
export function updatePlacemarkHeight(xml: string, target: HeightEditTarget, newHeight: number): string | null {
  if (!Number.isFinite(newHeight)) {
    return null;
  }
  const blocks = findPlacemarkBlocks(xml);
  const block = pickBlock(blocks, target);
  if (!block) {
    return null;
  }
  const edited = editBlockHeight(block.text, target, newHeight);
  if (edited === null) {
    return null;
  }
  return xml.slice(0, block.start) + edited + xml.slice(block.end);
}

function findPlacemarkBlocks(xml: string): Block[] {
  const blocks: Block[] = [];
  const openRe = /<Placemark(?=[\s>])/g;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(xml)) !== null) {
    const closeIdx = xml.indexOf('</Placemark>', m.index);
    if (closeIdx === -1) {
      break;
    }
    const end = closeIdx + '</Placemark>'.length;
    blocks.push({ start: m.index, end, text: xml.slice(m.index, end) });
    openRe.lastIndex = end;
  }
  return blocks;
}

/**
 * Prefer locating by wpml:index (robust against parse-order vs text-order differences);
 * fall back to the document-order ordinal.
 */
function pickBlock(blocks: Block[], target: HeightEditTarget): Block | undefined {
  const byOrdinal = blocks[target.ordinal];
  if (target.index !== undefined) {
    const indexRe = new RegExp(`<wpml:index>\\s*${target.index}\\s*</wpml:index>`);
    if (byOrdinal && indexRe.test(byOrdinal.text)) {
      return byOrdinal;
    }
    const matching = blocks.filter((b) => indexRe.test(b.text));
    if (matching.length === 1) {
      return matching[0];
    }
  }
  return byOrdinal;
}

function editBlockHeight(block: string, target: HeightEditTarget, newHeight: number): string | null {
  const preferred: HeightField[] =
    target.heightField !== undefined
      ? [target.heightField]
      : target.source === 'waylines'
        ? ['executeHeight', 'height', 'coordinates']
        : ['height', 'executeHeight', 'coordinates'];

  for (const field of preferred) {
    const edited = field === 'coordinates' ? editCoordinatesAlt(block, newHeight) : editHeightTag(block, field, newHeight);
    if (edited !== null) {
      return edited;
    }
  }
  return null;
}

function editHeightTag(block: string, tag: 'executeHeight' | 'height', newHeight: number): string | null {
  const re = tagValueRe(tag);
  const m = re.exec(block);
  if (!m) {
    return null;
  }
  let out = block.slice(0, m.index) + m[1] + String(newHeight) + m[3] + block.slice(m.index + m[0].length);

  // Keep template.kml's ellipsoidHeight consistent by shifting it by the same delta.
  if (tag === 'height') {
    const oldHeight = Number(m[2]);
    if (Number.isFinite(oldHeight)) {
      const delta = newHeight - oldHeight;
      const ellipRe = tagValueRe('ellipsoidHeight');
      const em = ellipRe.exec(out);
      if (em) {
        const oldEllip = Number(em[2]);
        if (Number.isFinite(oldEllip)) {
          out =
            out.slice(0, em.index) + em[1] + String(oldEllip + delta) + em[3] + out.slice(em.index + em[0].length);
        }
      }
    }
  }
  return out;
}

function tagValueRe(tag: string): RegExp {
  return new RegExp(`(<(?:wpml:)?${tag}>\\s*)([^<]*?)(\\s*</(?:wpml:)?${tag}>)`);
}

function editCoordinatesAlt(block: string, newHeight: number): string | null {
  const re = /(<coordinates>\s*)([^<]*?)(\s*<\/coordinates>)/;
  const m = re.exec(block);
  if (!m) {
    return null;
  }
  const parts = m[2].trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length < 2) {
    return null;
  }
  const replaced = `${parts[0]},${parts[1]},${String(newHeight)}`;
  return block.slice(0, m.index) + m[1] + replaced + m[3] + block.slice(m.index + m[0].length);
}
