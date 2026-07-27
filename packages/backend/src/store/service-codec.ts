import {
  StoreServiceSchema,
  type Service,
  type StoreService,
} from '@agent-deck/shared';
import {
  sanitizeServiceForExport,
  stripAuthorizationHeader,
} from '../export-import/sanitize-for-export';

export function serializeService(service: StoreService): string {
  const validated = StoreServiceSchema.parse(service);
  return `${JSON.stringify(validated, null, 2)}\n`;
}

export function parseServiceJson(raw: string): StoreService {
  const parsed = StoreServiceSchema.parse(JSON.parse(raw));
  const headers = stripAuthorizationHeader(parsed.headers);
  return StoreServiceSchema.parse({ ...parsed, headers });
}

/** Build a store-safe service snapshot from a DB row. */
export function storeServiceFromDb(service: Service): StoreService {
  return StoreServiceSchema.parse(sanitizeServiceForExport(service));
}
