type NormalizeTextOptions = {
  maxLength?: number;
  collapseWhitespace?: boolean;
};

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeTextInput(value: unknown, options: NormalizeTextOptions = {}): string {
  const { maxLength = 0, collapseWhitespace = true } = options;
  if (typeof value !== 'string') return '';

  let normalized = value.trim();
  if (!normalized) return '';

  if (collapseWhitespace) {
    normalized = normalized.replace(/\s+/g, ' ');
  }

  if (maxLength > 0 && normalized.length > maxLength) {
    normalized = normalized.slice(0, maxLength);
  }

  return normalized;
}

export function parseClampedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'string' ? parseInt(value, 10) : Number(value);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function isUuidLike(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4_REGEX.test(value.trim());
}

export function sanitizeFileName(fileName: unknown): string {
  const safeName = normalizeTextInput(fileName, { maxLength: 180, collapseWhitespace: true });
  if (!safeName) return '';

  // Remove separators and control characters to avoid path traversal and malformed names.
  const stripped = safeName.replace(/[\\/\x00-\x1F\x7F]/g, '').trim();
  return stripped;
}

export function parseAllowedOrigins(originList: string | undefined): string[] {
  if (!originList) return [];
  return originList
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (allowedOrigins.length === 0) return true;
  if (!origin) return true;
  return allowedOrigins.includes(origin);
}
