import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Service } from '@agent-deck/shared';
import { useMcpService } from '@/hooks/use-mcp-service';
import { 
  CheckCircle, 
  XCircle, 
  Loader2, 
  Key, 
  Wrench, 
  FileText, 
  MessageSquare,
  RefreshCw,
  AlertCircle
} from 'lucide-react';

interface EnhancedServiceDetailsModalProps {
  service: Service;
  isOpen: boolean;
  onClose: () => void;
}

export default function EnhancedServiceDetailsModal({ 
  service, 
  isOpen, 
  onClose 
}: EnhancedServiceDetailsModalProps) {
  const [activeTab, setActiveTab] = useState('overview');
  
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
    readResource,
    listResources,
    getPrompt,
    listPrompts,
    authUrl,
    clearStorage,
  } = useMcpService({
    service,
    autoConnect: false,
    onConnected: () => {
      console.log(`Connected to ${service.name}`);
    },
    onError: (error) => {
      console.error(`Connection error for ${service.name}:`, error);
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

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: "#92E4DD" }} />
            {service.name}
            <Badge variant={isConnected ? "default" : "secondary"}>
              {connectionStatus.status}
            </Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col h-full">
          {/* Connection Controls */}
          <Card className="mb-4">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <connectionStatus.icon className={`w-4 h-4 ${connectionStatus.color}`} />
                Connection Status
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm text-muted-foreground">
                  {service.url}
                </div>
                <div className="flex gap-2">
                  {!isConnected && !isConnecting && (
                    <Button onClick={connect} size="sm">
                      Connect
                    </Button>
                  )}
                  {isConnected && (
                    <Button onClick={disconnect} variant="outline" size="sm">
                      Disconnect
                    </Button>
                  )}
                  {hasError && (
                    <Button onClick={retry} variant="outline" size="sm">
                      <RefreshCw className="w-4 h-4 mr-1" />
                      Retry
                    </Button>
                  )}
                  {authUrl && !isConnected && (
                    <Button onClick={authenticate} variant="outline" size="sm">
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

          {/* Main Content Tabs */}
          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="tools">Tools ({tools.length})</TabsTrigger>
              <TabsTrigger value="resources">Resources ({resources.length})</TabsTrigger>
              <TabsTrigger value="prompts">Prompts ({prompts.length})</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="flex-1 mt-4">
              <Card>
                <CardHeader>
                  <CardTitle>Service Information</CardTitle>
                  <CardDescription>
                    Basic information about this MCP service
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <h4 className="font-medium mb-2">Description</h4>
                    <p className="text-sm text-muted-foreground">
                      {service.description || 'No description available'}
                    </p>
                  </div>
                  
                  <div>
                    <h4 className="font-medium mb-2">Type</h4>
                    <Badge variant="outline">{service.type.toUpperCase()}</Badge>
                  </div>
                  
                  <div>
                    <h4 className="font-medium mb-2">URL</h4>
                    <p className="text-sm font-mono bg-muted p-2 rounded">
                      {service.url}
                    </p>
                  </div>
                  
                  {service.health && (
                    <div>
                      <h4 className="font-medium mb-2">Health</h4>
                      <Badge variant={service.health === 'healthy' ? 'default' : 'destructive'}>
                        {service.health}
                      </Badge>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="tools" className="flex-1 mt-4">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Wrench className="w-4 h-4" />
                    Available Tools
                  </CardTitle>
                  <CardDescription>
                    Tools provided by this MCP service
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ScrollArea className="h-[400px]">
                    {tools.length === 0 ? (
                      <div className="text-center py-8 text-muted-foreground">
                        {isConnected ? 'No tools available' : 'Connect to see available tools'}
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {tools.map((tool, index) => (
                          <div key={index} className="p-3 border rounded-lg">
                            <div className="flex items-center justify-between mb-2">
                              <h4 className="font-medium">{tool.name}</h4>
                              <Badge variant="outline" className="text-xs">
                                {tool.description ? 'Available' : 'No description'}
                              </Badge>
                            </div>
                            {tool.description && (
                              <p className="text-sm text-muted-foreground">
                                {tool.description}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </ScrollArea>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="resources" className="flex-1 mt-4">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <FileText className="w-4 h-4" />
                    Available Resources
                  </CardTitle>
                  <CardDescription>
                    Resources provided by this MCP service
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ScrollArea className="h-[400px]">
                    {resources.length === 0 ? (
                      <div className="text-center py-8 text-muted-foreground">
                        {isConnected ? 'No resources available' : 'Connect to see available resources'}
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {resources.map((resource, index) => (
                          <div key={index} className="p-3 border rounded-lg">
                            <div className="flex items-center justify-between mb-2">
                              <h4 className="font-medium">{resource.uri}</h4>
                              <Badge variant="outline" className="text-xs">
                                {resource.mimeType || 'Unknown type'}
                              </Badge>
                            </div>
                            {resource.description && (
                              <p className="text-sm text-muted-foreground">
                                {resource.description}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </ScrollArea>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="prompts" className="flex-1 mt-4">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <MessageSquare className="w-4 h-4" />
                    Available Prompts
                  </CardTitle>
                  <CardDescription>
                    Prompt templates provided by this MCP service
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ScrollArea className="h-[400px]">
                    {prompts.length === 0 ? (
                      <div className="text-center py-8 text-muted-foreground">
                        {isConnected ? 'No prompts available' : 'Connect to see available prompts'}
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {prompts.map((prompt, index) => (
                          <div key={index} className="p-3 border rounded-lg">
                            <div className="flex items-center justify-between mb-2">
                              <h4 className="font-medium">{prompt.name}</h4>
                              <Badge variant="outline" className="text-xs">
                                {prompt.description ? 'Available' : 'No description'}
                              </Badge>
                            </div>
                            {prompt.description && (
                              <p className="text-sm text-muted-foreground">
                                {prompt.description}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </ScrollArea>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </DialogContent>
    </Dialog>
  );
}
