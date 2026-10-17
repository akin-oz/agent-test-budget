/** URL-safe slug: lowercase, accents stripped, runs of non-alphanumerics become one "-". */
export function slugify(input: string, opts: { maxLength?: number; separator?: string } = {}): string {
  const sep = opts.separator ?? '-';
  let s = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, sep)
    .replace(new RegExp(`^${escape(sep)}+|${escape(sep)}+$`, 'g'), '');
  if (opts.maxLength !== undefined && s.length > opts.maxLength) {
    s = s.slice(0, opts.maxLength).replace(new RegExp(`${escape(sep)}+$`), '');
  }
  return s;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
