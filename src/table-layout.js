export const TABLE_LAYOUT_STANDARD = 'standard';
export const TABLE_LAYOUT_BILINGUAL = 'bilingual';

export function normalizeTableLayoutMode(value) {
  return value === TABLE_LAYOUT_BILINGUAL ? TABLE_LAYOUT_BILINGUAL : TABLE_LAYOUT_STANDARD;
}

export function getTableLayoutPresentation(value) {
  const mode = normalizeTableLayoutMode(value);
  return { mode, className: `table-layout-${mode}` };
}
