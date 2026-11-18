import React, { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useMcpService } from '@/hooks/use-mcp-service';
import { Service } from '@agent-deck/shared';
import { 
  CheckCircle, 
  XCircle, 
  Loader2, 
  Key, 
  Wrench, 
  Play,
  AlertCircle
} from 'lucide-react';

export default function McpTestPage() {
  const [serviceUrl, setServiceUrl] = useState('https://api.githubcopilot.com/mcp');
  const [toolName, setToolName] = useState('get_me');
  const [toolArgs, setToolArgs] = useState('{}');
  const [result, setResult] = useState<string>('');
  
  // Create a test service object
  const testService: Service = {
    id: 'test-mcp-service',
    name: 'Test MCP Service',
    type: 'mcp',
    url: serviceUrl,
    health: 'unknown',
    description: 'Test service for use-mcp integration',
    cardColor: '#7ed4da',
    isConnected: false,
    lastPing: undefined,
    registeredAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const {
    isConnected,
    isConnecting,
    isAuthenticating,
    hasError,
    error,
    tools,
    resources,
    prompts,
    connect,
    disconnect,
    retry,
    authenticate,
    callTool,
    authUrl,
    clearStorage,
  } = useMcpService({
    service: testService,
    autoConnect: false,
    onConnected: () => {
      console.log('Connected to test MCP service');
    },
    onError: (error) => {
      console.error('Test MCP service error:', error);
    },
  });

  const getConnectionStatus = () => {
    if (isConnecting) return { status: 'connecting', icon: Loader2, color: 'text-yellow-500' };
    if (isAuthenticating) return { status: 'authenticating', icon: Key, color: 'text-blue-500' };
    if (isConnected) return { status: 'connected', icon: CheckCircle, color: 'text-green-500' };
    if (hasError) return { status: 'error', icon: XCircle, color: 'text-red-500' };
    return { status: 'disconnected', icon: XCircle, color: 'text-gray-500' };
  };

  const connectionStatus = getConnectionStatus();

  const handleCallTool = async () => {
    try {
      let args = {};
      if (toolArgs.trim()) {
        args = JSON.parse(toolArgs);
      }
      
      const result = await callTool(toolName, args);
      setResult(JSON.stringify(result, null, 2));
    } catch (error) {
      setResult(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="text-center">
        <h1 className="text-3xl font-bold mb-2">use-mcp Integration Test</h1>
        <p className="text-muted-foreground">
          Testing the new use-mcp library integration with OAuth support
        </p>
      </div>

      {/* Connection Status */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <connectionStatus.icon className={`w-5 h-5 ${connectionStatus.color}`} />
            Connection Status: {connectionStatus.status}
          </CardTitle>
          <CardDescription>
            Current connection state and available actions
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <Label>Service URL</Label>
              <Input 
                value={serviceUrl} 
                onChange={(e) => setServiceUrl(e.target.value)}
                placeholder="Enter MCP service URL"
              />
            </div>
            <div className="flex gap-2">
              {!isConnected && !isConnecting && (
                <Button onClick={connect}>
                  Connect
                </Button>
              )}
              {isConnected && (
                <Button onClick={disconnect} variant="outline">
                  Disconnect
                </Button>
              )}
              {hasError && (
                <Button onClick={retry} variant="outline">
                  <Loader2 className="w-4 h-4 mr-1" />
                  Retry
                </Button>
              )}
              {authUrl && !isConnected && (
                <Button onClick={authenticate} variant="outline">
                  <Key className="w-4 h-4 mr-1" />
                  Authenticate
                </Button>
              )}
            </div>
          </div>
          
          {error && (
            <div className="flex items-center gap-2 p-3 bg-destructive/10 border border-destructive/20 rounded-md">
              <AlertCircle className="w-4 h-4 text-destructive" />
              <span className="text-sm text-destructive">{error}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Service Capabilities */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wrench className="w-4 h-4" />
              Tools ({tools.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {tools.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {isConnected ? 'No tools available' : 'Connect to see tools'}
              </p>
            ) : (
              <div className="space-y-2">
                {tools.slice(0, 5).map((tool, index) => (
                  <div key={index} className="text-sm">
                    <Badge variant="outline" className="text-xs">
                      {tool.name}
                    </Badge>
                  </div>
                ))}
                {tools.length > 5 && (
                  <p className="text-xs text-muted-foreground">
                    +{tools.length - 5} more tools
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Resources ({resources.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {isConnected ? `${resources.length} resources available` : 'Connect to see resources'}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Prompts ({prompts.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {isConnected ? `${prompts.length} prompts available` : 'Connect to see prompts'}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Tool Testing */}
      {isConnected && (
        <Card>
          <CardHeader>
            <CardTitle>Test Tool Call</CardTitle>
            <CardDescription>
              Test calling a tool on the connected MCP service
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="toolName">Tool Name</Label>
                <Input
                  id="toolName"
                  value={toolName}
                  onChange={(e) => setToolName(e.target.value)}
                  placeholder="e.g., get_me"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="toolArgs">Arguments (JSON)</Label>
                <Input
                  id="toolArgs"
                  value={toolArgs}
                  onChange={(e) => setToolArgs(e.target.value)}
                  placeholder='{"key": "value"}'
                />
              </div>
            </div>
            
            <Button onClick={handleCallTool} disabled={!isConnected}>
              <Play className="w-4 h-4 mr-1" />
              Call Tool
            </Button>
            
            {result && (
              <div className="space-y-2">
                <Label>Result</Label>
                <Textarea
                  value={result}
                  readOnly
                  rows={10}
                  className="font-mono text-sm"
                />
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* OAuth Information */}
      {authUrl && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Key className="w-4 h-4" />
              OAuth Authentication
            </CardTitle>
            <CardDescription>
              This service requires OAuth authentication
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="p-3 bg-blue-50 border border-blue-200 rounded-md">
              <p className="text-sm text-blue-800">
                This MCP service requires OAuth authentication. Click the &quot;Authenticate&quot; button above to start the OAuth flow.
              </p>
            </div>
            <div className="flex gap-2">
              <Button onClick={authenticate} variant="outline">
                <Key className="w-4 h-4 mr-1" />
                Start OAuth Flow
              </Button>
              <Button onClick={clearStorage} variant="outline">
                Clear OAuth Data
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
