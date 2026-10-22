import { FastifyInstance, FastifyRequest } from 'fastify';
import { WebSocketMessage, ServiceStatusUpdate, DeckUpdate } from '@agent-deck/shared';

interface WebSocketConnection {
  id: string;
  socket: any;
  subscriptions: Set<string>;
}

/**
 * Connection registry plus the broadcast functions that write to it.
 *
 * Owned by the root server scope (see `installWebSocketBroadcasting`) rather
 * than by the encapsulated `/api/ws` plugin: decorators added inside a
 * registered plugin stay inside it, so sibling plugins and root-scope callers
 * (e.g. the NOT-512 health re-probe) would otherwise only see a stub.
 */
export interface WebSocketHub {
  connections: Map<string, WebSocketConnection>;
  broadcastServiceUpdate: (update: ServiceStatusUpdate) => void;
  broadcastDeckUpdate: (update: DeckUpdate) => void;
  broadcastToAll: (message: WebSocketMessage) => void;
}

export function createWebSocketHub(): WebSocketHub {
  const connections = new Map<string, WebSocketConnection>();

  function broadcastToSubscribers(channel: string, message: WebSocketMessage) {
    console.log(`Broadcasting to ${channel} channel:`, message.type, `(${connections.size} connections)`);
    
    if (connections.size === 0) {
      console.log('No WebSocket connections available for broadcasting');
      return;
    }
    
    for (const connection of connections.values()) {
      if (connection.subscriptions.has(channel)) {
        try {
          connection.socket.send(JSON.stringify(message));
        } catch (error) {
          console.error(`Failed to send message to connection ${connection.id}:`, error);
          // Remove broken connection
          connections.delete(connection.id);
        }
      }
    }
  }

  return {
    connections,
    broadcastServiceUpdate: (update: ServiceStatusUpdate) => {
      console.log('Broadcasting service update:', update);
      const message: WebSocketMessage = {
        type: 'service_update',
        data: update,
        timestamp: new Date().toISOString(),
      };
      
      broadcastToSubscribers('services', message);
    },
    broadcastDeckUpdate: (update: DeckUpdate) => {
      console.log('Broadcasting deck update:', update);
      const message: WebSocketMessage = {
        type: 'deck_update',
        data: update,
        timestamp: new Date().toISOString(),
      };
      
      broadcastToSubscribers('decks', message);
    },
    // Broadcast to all connections
    broadcastToAll: (message: WebSocketMessage) => {
      for (const connection of connections.values()) {
        try {
          connection.socket.send(JSON.stringify(message));
        } catch (error) {
          console.error(`Failed to send message to connection ${connection.id}:`, error);
          // Remove broken connection
          connections.delete(connection.id);
        }
      }
    },
  };
}

/**
 * Create the hub and decorate the given (root) instance with its broadcast
 * functions so every plugin and root-scope caller reaches real subscribers.
 * Call before registering `registerWebSocketRoutes` with the returned hub.
 */
export function installWebSocketBroadcasting(fastify: FastifyInstance): WebSocketHub {
  const hub = createWebSocketHub();
  fastify.decorate('broadcastServiceUpdate', hub.broadcastServiceUpdate);
  fastify.decorate('broadcastDeckUpdate', hub.broadcastDeckUpdate);
  fastify.decorate('broadcastToAll', hub.broadcastToAll);
  return hub;
}

export interface WebSocketRoutesOptions {
  hub: WebSocketHub;
}

export async function registerWebSocketRoutes(fastify: FastifyInstance, options: WebSocketRoutesOptions) {
  const { connections } = options.hub;

  // Enable WebSocket connections
  fastify.get('/events', { websocket: true }, (socket, _req) => {
    const connectionId = `conn-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    console.log(`WebSocket connection established: ${connectionId}`);
    
    const wsConnection: WebSocketConnection = {
      id: connectionId,
      socket,
      subscriptions: new Set(['services', 'decks']) // Subscribe to all channels by default
    };
    
    connections.set(connectionId, wsConnection);
    
    // Send welcome message
    const welcomeMessage: WebSocketMessage = {
      type: 'connected',
      data: { connectionId },
      timestamp: new Date().toISOString(),
    };
    
    try {
      socket.send(JSON.stringify(welcomeMessage));
    } catch (error) {
      console.error('Error sending welcome message:', error);
    }
    
    // Handle incoming messages
    socket.on('message', (message: string) => {
      try {
        const parsed = JSON.parse(message);
        
        switch (parsed.type) {
          case 'subscribe':
            handleSubscribe(wsConnection, parsed.channel);
            break;
          case 'unsubscribe':
            handleUnsubscribe(wsConnection, parsed.channel);
            break;
          case 'ping':
            handlePing(wsConnection);
            break;
          default:
            console.log('Unknown message type:', parsed.type);
        }
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
      }
    });
    
    // Handle connection close
    socket.on('close', () => {
      console.log(`WebSocket connection closed: ${connectionId}`);
      connections.delete(connectionId);
    });
    
    // Handle connection error
    socket.on('error', (error: unknown) => {
      console.error(`WebSocket connection error: ${connectionId}`, error);
      connections.delete(connectionId);
    });
  });

  function handleSubscribe(connection: WebSocketConnection, channel: string) {
    connection.subscriptions.add(channel);
    
    const message: WebSocketMessage = {
      type: 'subscribed',
      data: { channel },
      timestamp: new Date().toISOString(),
    };
    
    try {
      connection.socket.send(JSON.stringify(message));
    } catch (error) {
      console.error('Error sending subscribe message:', error);
    }
  }

  function handleUnsubscribe(connection: WebSocketConnection, channel: string) {
    connection.subscriptions.delete(channel);
    
    const message: WebSocketMessage = {
      type: 'unsubscribed',
      data: { channel },
      timestamp: new Date().toISOString(),
    };
    
    try {
      connection.socket.send(JSON.stringify(message));
    } catch (error) {
      console.error('Error sending unsubscribe message:', error);
    }
  }

  function handlePing(connection: WebSocketConnection) {
    const message: WebSocketMessage = {
      type: 'pong',
      data: {},
      timestamp: new Date().toISOString(),
    };
    
    try {
      connection.socket.send(JSON.stringify(message));
    } catch (error) {
      console.error('Error sending pong message:', error);
    }
  }
}

// Extend FastifyInstance to include broadcast methods
declare module 'fastify' {
  interface FastifyInstance {
    broadcastServiceUpdate: (update: ServiceStatusUpdate) => void;
    broadcastDeckUpdate: (update: DeckUpdate) => void;
    broadcastToAll: (message: WebSocketMessage) => void;
  }
}
