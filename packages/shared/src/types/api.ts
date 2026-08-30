import type { TrustedSessionErrorCode } from '../schemas/trusted-session';
import type { McpErrorCode, ServiceToolErrorDetails } from './service';

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  error_code?: McpErrorCode | TrustedSessionErrorCode;
  details?: ServiceToolErrorDetails;
  message?: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface WebSocketMessage<T = any> {
  type: string;
  data: T;
  timestamp: string;
}

export interface ServiceStatusUpdate {
  serviceId: string;
  isConnected: boolean;
  lastPing?: string;
  health: 'unknown' | 'healthy' | 'unhealthy';
}

export interface DeckUpdate {
  deckId: string;
  action: 'created' | 'updated' | 'deleted' | 'service_added' | 'service_removed';
  data: any;
}
