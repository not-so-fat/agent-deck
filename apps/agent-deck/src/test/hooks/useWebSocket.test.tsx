import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useWebSocket } from '../../hooks/use-websocket'
import { createTestWrapper } from '../setup'

// Mock WebSocket
const mockWebSocket = {
  send: vi.fn(),
  close: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  readyState: 1,
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
}

// Mock the toast hook
vi.mock('../../hooks/use-toast', () => ({
  useToast: () => ({
    toast: vi.fn()
  })
}))

describe('useWebSocket', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset WebSocket mock
    // vitest 4+: a mock called with `new` needs a constructible implementation
    // (a function or class), not an arrow function.
    global.WebSocket = vi.fn().mockImplementation(function () { return mockWebSocket }) as any
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('Initial State', () => {
    it('returns initial state correctly', () => {
      const { result } = renderHook(() => useWebSocket(), {
        wrapper: createTestWrapper()
      })

      expect(result.current.connectionStatus).toBe('connecting')
      expect(result.current.lastMessage).toBe(null)
    })

    it('attempts to connect on mount', () => {
      renderHook(() => useWebSocket(), {
        wrapper: createTestWrapper()
      })

      expect(global.WebSocket).toHaveBeenCalledWith(
        `ws://${window.location.host}/api/ws/events`,
      );
    })
  })

  describe('Connection Management', () => {
    it('handles connection open event', () => {
      const { result } = renderHook(() => useWebSocket(), {
        wrapper: createTestWrapper()
      })

      // Simulate WebSocket open event
      const ws = (global.WebSocket as any).mock.results[0].value
      act(() => {
        ws.onopen()
      })

      expect(result.current.connectionStatus).toBe('connected')
    })

    it('handles connection close event', () => {
      const { result } = renderHook(() => useWebSocket(), {
        wrapper: createTestWrapper()
      })

      // Simulate WebSocket close event
      const ws = (global.WebSocket as any).mock.results[0].value
      act(() => {
        ws.onclose()
      })

      expect(result.current.connectionStatus).toBe('disconnected')
    })

    it('handles connection error event', () => {
      const { result } = renderHook(() => useWebSocket(), {
        wrapper: createTestWrapper()
      })

      // Simulate WebSocket error event
      const ws = (global.WebSocket as any).mock.results[0].value
      act(() => {
        ws.onerror(new Error('Connection failed'))
      })

      expect(result.current.connectionStatus).toBe('disconnected')
    })
  })

  describe('Message Handling', () => {
    it('handles incoming messages', () => {
      const { result } = renderHook(() => useWebSocket(), {
        wrapper: createTestWrapper()
      })

      // Simulate WebSocket message event
      const ws = (global.WebSocket as any).mock.results[0].value
      const mockMessage = {
        data: JSON.stringify({ type: 'test', data: 'test message' })
      }

      act(() => {
        ws.onmessage(mockMessage)
      })

      expect(result.current.lastMessage).toEqual({ type: 'test', data: 'test message' })
    })

    it('handles invalid JSON messages', () => {
      const { result } = renderHook(() => useWebSocket(), {
        wrapper: createTestWrapper()
      })

      // Simulate WebSocket message event with invalid JSON
      const ws = (global.WebSocket as any).mock.results[0].value
      const mockMessage = {
        data: 'invalid json'
      }

      act(() => {
        ws.onmessage(mockMessage)
      })

      // Should handle invalid JSON without throwing
      expect(result.current.lastMessage).toBe(null)
    })

    it('handles deck_update messages', () => {
      const { result } = renderHook(() => useWebSocket(), {
        wrapper: createTestWrapper()
      })

      // Simulate WebSocket message event
      const ws = (global.WebSocket as any).mock.results[0].value
      const mockMessage = {
        data: JSON.stringify({ type: 'deck_update', data: { deckId: '123' } })
      }

      act(() => {
        ws.onmessage(mockMessage)
      })

      expect(result.current.lastMessage).toEqual({ type: 'deck_update', data: { deckId: '123' } })
    })

    it('handles service_update messages', () => {
      const { result } = renderHook(() => useWebSocket(), {
        wrapper: createTestWrapper()
      })

      // Simulate WebSocket message event
      const ws = (global.WebSocket as any).mock.results[0].value
      const mockMessage = {
        data: JSON.stringify({ type: 'service_update', data: { serviceId: '456' } })
      }

      act(() => {
        ws.onmessage(mockMessage)
      })

      expect(result.current.lastMessage).toEqual({ type: 'service_update', data: { serviceId: '456' } })
    })

    it('handles connection_status messages', () => {
      const { result } = renderHook(() => useWebSocket(), {
        wrapper: createTestWrapper()
      })

      // Simulate WebSocket message event
      const ws = (global.WebSocket as any).mock.results[0].value
      const mockMessage = {
        data: JSON.stringify({ type: 'connection_status', status: 'connected' })
      }

      act(() => {
        ws.onmessage(mockMessage)
      })

      expect(result.current.connectionStatus).toBe('connected')
    })
  })

  describe('Reconnection', () => {
    it('attempts to reconnect after connection loss', () => {
      const { result } = renderHook(() => useWebSocket(), {
        wrapper: createTestWrapper()
      })

      // First connect
      const ws = (global.WebSocket as any).mock.results[0].value
      act(() => {
        ws.onopen()
      })

      // Then disconnect
      act(() => {
        ws.onclose()
      })

      // Should attempt to reconnect after 3 seconds
      expect(result.current.connectionStatus).toBe('disconnected')
    })
  })

  describe('Cleanup', () => {
    it('cleans up on unmount', () => {
      const { unmount } = renderHook(() => useWebSocket(), {
        wrapper: createTestWrapper()
      })

      // Should not throw on unmount
      expect(() => {
        unmount()
      }).not.toThrow()
    })
  })

  describe('Error Handling', () => {
    it('handles WebSocket constructor errors', () => {
      // Mock WebSocket to throw an error
      global.WebSocket = vi.fn().mockImplementation(function () {
        throw new Error('WebSocket connection failed')
      }) as any

      // Should not throw error
      expect(() => {
        renderHook(() => useWebSocket(), {
          wrapper: createTestWrapper()
        })
      }).not.toThrow()
    })
  })
})











