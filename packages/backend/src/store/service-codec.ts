import {
  StoreServiceSchema,
  type Service,
  type StoreService,
} from '@agent-deck/shared';
import { sanitizeServiceForExport } from '../export-import/sanitize-for-export';

export function serializeService(service: StoreService): string {
  const validated = StoreServiceSchema.parse(service);
  return `${JSON.stringify(validated, null, 2)}\n`;
}

export function parseServiceJson(raw: string): StoreService {
  return StoreServiceSchema.parse(JSON.parse(raw));
}

/** Build a store-safe service snapshot from a DB row. */
export function storeServiceFromDb(service: Service): StoreService {
  return StoreServiceSchema.parse(sanitizeServiceForExport(service));
}
