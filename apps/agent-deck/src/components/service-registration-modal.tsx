import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Server, Bot, X, Plus, Terminal, AlertTriangle, CheckCircle } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Service } from "@agent-deck/shared";
import { parseLocalMcpManifestJson } from "../../../../packages/shared/src/utils/local-mcp-manifest";
import { MCP_CARD_COLOR, CARD_FACE_CLASS, cardAccentStyle } from "@/lib/card-colors";

interface ServiceRegistrationModalProps {
  type: Service['type'];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ParsedLocalMCPConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  description?: string;
}

export default function ServiceRegistrationModal({ 
  type, 
  open, 
  onOpenChange 
}: ServiceRegistrationModalProps) {
  // Tab state for MCP registration
  const [activeTab, setActiveTab] = useState<'remote' | 'local'>('remote');
  
  // Local MCP registration stages
  const [localRegistrationStage, setLocalRegistrationStage] = useState<'json' | 'review' | 'complete'>('json');
  
  // JSON input for local MCP
  const [localMCPJson, setLocalMCPJson] = useState(`{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "env": {
        "MEMORY_FILE_PATH": "/path/to/custom/memory.json"
      }
    }
  }
}`);
  
  // Parsed configuration
  const [parsedConfig, setParsedConfig] = useState<ParsedLocalMCPConfig | null>(null);
  const [parsedConfigError, setParsedConfigError] = useState<string | null>(null);
  const [nameConflict, setNameConflict] = useState<string | null>(null);
  
  // Remote MCP form data
  const [remoteFormData, setRemoteFormData] = useState({
    name: "",
    type: 'mcp' as const,
    url: "http://localhost:8000/mcp",
    description: "",
    headers_enabled: false,
    headers: {} as Record<string, string>,
    cardColor: MCP_CARD_COLOR,
  });
  const [headersJson, setHeadersJson] = useState('{\n  \n}');
  const [headersJsonError, setHeadersJsonError] = useState<string | null>(null);

  // Local MCP form data (for review stage)
  const [localFormData, setLocalFormData] = useState({
    name: "",
    type: 'local-mcp' as const,
    command: "",
    args: [""],
    env: {} as Record<string, string>,
    description: "",
    cardColor: MCP_CARD_COLOR,
  });

  // A2A form data
  const [a2aFormData, setA2aFormData] = useState({
    name: "",
    type: 'a2a' as const,
    manifest_url: "http://localhost:8001/.well-known/a2a/manifest.json",
    description: "",
    cardColor: MCP_CARD_COLOR,
  });

  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Parse JSON configuration
  const parseLocalMCPConfig = () => {
    try {
      setParsedConfigError(null);
      const manifest = parseLocalMcpManifestJson(localMCPJson);
      
      const serverEntries = Object.entries(manifest.mcpServers);
      if (serverEntries.length === 0) {
        throw new Error('No MCP servers found in configuration');
      }
      
      if (serverEntries.length > 1) {
        throw new Error('Multiple servers not supported. Please configure one server at a time.');
      }
      
      const [name, serverConfig] = serverEntries[0];
      
      const { command, args, env, description } = serverConfig;
      
      if (!command || typeof command !== 'string') {
        throw new Error('Missing or invalid command');
      }
      
      if (!args || !Array.isArray(args)) {
        throw new Error('Missing or invalid args array');
      }
      
      const parsed: ParsedLocalMCPConfig = {
        name,
        command,
        args: args.map(String),
        env: env && typeof env === 'object' ? env : undefined,
        description: description && typeof description === 'string' ? description : undefined,
      };
      
      setParsedConfig(parsed);
      setLocalRegistrationStage('review');
      
      // Update form data with parsed configuration
      setLocalFormData({
        name: parsed.name,
        type: 'local-mcp',
        command: parsed.command,
        args: parsed.args,
        env: parsed.env || {},
        description: parsed.description || "",
        cardColor: MCP_CARD_COLOR,
      });
      
      // Check for name conflicts
      checkNameConflict(name);
      
    } catch (error) {
      setParsedConfigError(error instanceof Error ? error.message : 'Failed to parse JSON');
      setParsedConfig(null);
    }
  };

  // Check if service name already exists
  const checkNameConflict = async (name: string) => {
    try {
      const response = await apiRequest('GET', '/api/services');
      const services = (response as any).data || [];
      const existingService = services.find((s: Service) => s.name === name);
      
      if (existingService) {
        setNameConflict(name);
      } else {
        setNameConflict(null);
      }
    } catch (error) {
      console.error('Failed to check name conflict:', error);
    }
  };

  // Check name conflict for any service type
  const checkNameConflictForAllTypes = async (name: string) => {
    await checkNameConflict(name);
  };

  // Update local form data from parsed config
  const updateLocalFormFromParsed = () => {
    if (!parsedConfig) return;
    
    setLocalFormData({
      name: parsedConfig.name,
      type: 'local-mcp',
      command: parsedConfig.command,
      args: parsedConfig.args,
      env: parsedConfig.env || {},
      description: parsedConfig.description || "",
      cardColor: MCP_CARD_COLOR,
    });
  };

  const registerServiceMutation = useMutation({
    mutationFn: async (data: any) => {
      if (type === 'mcp' && activeTab === 'local') {
        // Local MCP server registration
        const config = {
          mcpServers: {
            [data.name]: {
              command: data.command,
              args: data.args.filter((arg: string) => arg.trim() !== ''),
              ...(Object.keys(data.env).length > 0 && { env: data.env })
            }
          }
        };

        console.log('Importing local MCP server:', config);
        return apiRequest('POST', '/api/local-mcp/import', { config: JSON.stringify(config) });
      } else {
        // Remote MCP or A2A service registration
        const serviceData = {
          name: data.name,
          type: type,
          url: type === 'mcp' ? data.url : data.manifest_url,
          description: data.description,
          cardColor: data.cardColor,
          ...(data.headers_enabled && {
            headers: data.headers,
          }),
        };

        console.log('Sending service data:', serviceData);
        return apiRequest('POST', '/api/services', serviceData);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/services'] });
      queryClient.invalidateQueries({ queryKey: ['/api/collection/warnings'] });
      const currentFormData = type === 'mcp' ? 
        (activeTab === 'remote' ? remoteFormData : localFormData) : 
        a2aFormData;
      toast({
        title: "Service registered successfully!",
        description: `${currentFormData.name} has been added to your collection.`,
      });
      handleClose();
    },
    onError: (error: any) => {
      console.error('Registration failed:', error);
      console.error('Error details:', {
        message: error?.message,
        name: error?.name,
        stack: error?.stack,
        toString: error?.toString(),
        constructor: error?.constructor?.name
      });
      
      toast({
        title: "Registration failed",
        description: error?.message || "Failed to register service. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleSubmit = async () => {
    if (type === 'mcp' && activeTab === 'local') {
      if (localRegistrationStage === 'json') {
        parseLocalMCPConfig();
      } else if (localRegistrationStage === 'review') {
        // Check for name conflicts before registering
        await checkNameConflictForAllTypes(localFormData.name);
        if (nameConflict) {
          toast({
            title: "Name Conflict",
            description: `A service with the name "${localFormData.name}" already exists. Please choose a different name.`,
            variant: "destructive",
          });
          return;
        }
        registerServiceMutation.mutate(localFormData);
      }
    } else {
      const currentFormData = type === 'mcp' ? 
        (activeTab === 'remote' ? remoteFormData : localFormData) : 
        a2aFormData;
      
      // Check for name conflicts before registering
      await checkNameConflictForAllTypes(currentFormData.name);
      if (nameConflict) {
        toast({
          title: "Name Conflict",
          description: `A service with the name "${currentFormData.name}" already exists. Please choose a different name.`,
          variant: "destructive",
        });
        return;
      }

      if (type === 'mcp' && activeTab === 'remote' && remoteFormData.headers_enabled) {
        const parsedHeaders = parseHeadersJson();
        if (parsedHeaders === null) {
          return;
        }
        registerServiceMutation.mutate({
          ...remoteFormData,
          headers: parsedHeaders,
        });
        return;
      }

      registerServiceMutation.mutate(currentFormData);
    }
  };

  const handleClose = () => {
    // Reset local MCP registration state
    setLocalRegistrationStage('json');
    setLocalMCPJson(`{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "env": {
        "MEMORY_FILE_PATH": "/path/to/custom/memory.json"
      }
    }
  }
}`);
    setParsedConfig(null);
    setParsedConfigError(null);
    setNameConflict(null);
    
    // Reset form data
    setRemoteFormData({
      name: "",
      type: 'mcp',
      url: "http://localhost:8000/mcp",
      description: "",
      headers_enabled: false,
      headers: {},
      cardColor: MCP_CARD_COLOR,
    });
    setHeadersJson('{\n  \n}');
    setHeadersJsonError(null);
    setLocalFormData({
      name: "",
      type: 'local-mcp',
      command: "",
      args: [""],
      env: {},
      description: "",
      cardColor: MCP_CARD_COLOR,
    });
    setA2aFormData({
      name: "",
      type: 'a2a',
      manifest_url: "http://localhost:8001/.well-known/a2a/manifest.json",
      description: "",
      cardColor: MCP_CARD_COLOR,
    });
    
    onOpenChange(false);
  };

  const updateRemoteFormData = (field: string, value: any) => {
    setRemoteFormData(prev => ({ ...prev, [field]: value }));
  };

  const setHeadersEnabled = (enabled: boolean) => {
    updateRemoteFormData('headers_enabled', enabled);
    if (enabled && headersJson.trim() === '{\n  \n}') {
      setHeadersJson('{\n  "Authorization": "Bearer "\n}');
    }
    if (!enabled) {
      setHeadersJsonError(null);
    }
  };

  const parseHeadersJson = (): Record<string, string> | null => {
    const trimmed = headersJson.trim();
    if (!trimmed || trimmed === '{}') {
      return {};
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setHeadersJsonError('Headers must be a JSON object (e.g. {"Authorization": "Bearer token"})');
        return null;
      }
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value !== 'string') {
          setHeadersJsonError(`Header "${key}" must be a string value`);
          return null;
        }
      }
      setHeadersJsonError(null);
      return parsed as Record<string, string>;
    } catch {
      setHeadersJsonError('Invalid JSON — fix syntax before registering');
      return null;
    }
  };

  const updateLocalFormData = (field: string, value: any) => {
    setLocalFormData(prev => ({ ...prev, [field]: value }));
  };

  const updateA2aFormData = (field: string, value: any) => {
    setA2aFormData(prev => ({ ...prev, [field]: value }));
  };

  const getSubmitButtonText = () => {
    if (type === 'mcp' && activeTab === 'local') {
      if (localRegistrationStage === 'json') {
        return "Parse Configuration";
      } else if (localRegistrationStage === 'review') {
        return nameConflict ? "Register Anyway" : "Register Service";
      }
    }
    return "Register Service";
  };

  const isSubmitDisabled = () => {
    if (type === 'mcp' && activeTab === 'local') {
      if (localRegistrationStage === 'json') {
        return !localMCPJson.trim();
      } else if (localRegistrationStage === 'review') {
        return !localFormData.name.trim() || !localFormData.command.trim();
      }
    } else {
      const currentFormData = type === 'mcp' ? 
        (activeTab === 'remote' ? remoteFormData : localFormData) : 
        a2aFormData;
      return !currentFormData.name.trim() || 
        (type === 'mcp' && activeTab === 'remote' && !(currentFormData as any).url?.trim()) ||
        (type === 'a2a' && !(currentFormData as any).manifest_url?.trim());
    }
    return false;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto bg-black/40 backdrop-blur-md border border-white/10 text-white shadow-2xl">
        <DialogHeader>
          <DialogTitle className="text-2xl font-bold flex items-center" style={{background: 'linear-gradient(to right, #C4B643, #D4C760)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text'}}>
            {type === 'mcp' ? (
              <Server className="w-6 h-6 mr-3" style={{color: '#92E4DD'}} />
            ) : (
              <Bot className="w-6 h-6 mr-3" style={{color: '#92E4DD'}} />
            )}
            Register {type === 'mcp' ? 'MCP Server' : 'A2A Agent'}
          </DialogTitle>
          <DialogDescription className="mt-2" style={{color: '#92E4DD', opacity: 0.8}}>
            {type === 'mcp' ? 
              'Add a new Model Context Protocol (MCP) server to your service deck. Configure the server URL and provide details for registration.' :
              'Register a new A2A agent with your service deck. Provide the agent manifest and configuration details.'
            }
          </DialogDescription>
        </DialogHeader>
        
        {type === 'mcp' ? (
          <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as 'remote' | 'local')} className="w-full">
            <TabsList className="grid w-full grid-cols-2 bg-white/10 border border-white/20">
              <TabsTrigger 
                value="remote" 
                className="data-[state=active]:bg-white/20 data-[state=active]:text-white text-gray-400"
              >
                <Server className="w-4 h-4 mr-2" />
                Remote MCP
              </TabsTrigger>
              <TabsTrigger 
                value="local" 
                className="data-[state=active]:bg-white/20 data-[state=active]:text-white text-gray-400"
              >
                <Terminal className="w-4 h-4 mr-2" />
                Local MCP
              </TabsTrigger>
            </TabsList>

            <TabsContent value="remote" className="space-y-4 mt-4">
              <div>
                <Label htmlFor="name" className="text-sm font-semibold" style={{color: '#92E4DD'}}>
                  Server Name
                </Label>
                <Input
                  id="name"
                  placeholder="e.g., Database Tools"
                  value={remoteFormData.name}
                  onChange={(e) => {
                    updateRemoteFormData('name', e.target.value);
                    if (e.target.value.trim()) {
                      checkNameConflictForAllTypes(e.target.value);
                    } else {
                      setNameConflict(null);
                    }
                  }}
                  className="bg-white/10 border-white/20 text-white placeholder-gray-400"
                  required
                  data-testid="input-service-name"
                />
                {nameConflict && (
                  <div className="flex items-center gap-2 mt-1 text-red-400 text-sm">
                    <AlertTriangle className="w-4 h-4" />
                    <span>A service with this name already exists</span>
                  </div>
                )}
              </div>
              
              <div>
                <Label htmlFor="url" className="text-sm font-semibold" style={{color: '#92E4DD'}}>MCP URL</Label>
                <Input
                  id="url"
                  type="url"
                  placeholder="http://localhost:8080/mcp or https://mcp.notion.com/mcp"
                  value={remoteFormData.url}
                  onChange={(e) => updateRemoteFormData('url', e.target.value)}
                  className="bg-white/10 border-white/20 text-white placeholder-gray-400"
                  required
                  data-testid="input-mcp-url"
                />
                <div className="mt-1 text-xs text-gray-400">
                    <p>Supported formats:</p>
                    <ul className="list-disc list-inside ml-2 space-y-1">
                        <li>HTTP MCP: <code>http://localhost:8080/mcp</code></li>
                        <li>SSE MCP: <code>https://be.omnimcp.ai/api/v1/mcp/.../sse</code></li>
                        <li>Notion MCP: <code>https://mcp.notion.com/mcp</code></li>
                    </ul>
                </div>
              </div>
              
              <div>
                <Label htmlFor="description" className="text-sm font-semibold" style={{color: '#92E4DD'}}>Description</Label>
                <Textarea
                  id="description"
                  placeholder="Brief description of capabilities..."
                  value={remoteFormData.description}
                  onChange={(e) => updateRemoteFormData('description', e.target.value)}
                  rows={3}
                  className="bg-white/10 border-white/20 text-white placeholder-gray-400 resize-none"
                  data-testid="textarea-description"
                />
              </div>
            </TabsContent>

            <TabsContent value="local" className="space-y-4 mt-4">
              {localRegistrationStage === 'json' && (
                <div className="space-y-4">
                  <div>
                    <Label htmlFor="local-json" className="text-sm font-semibold" style={{color: '#92E4DD'}}>
                      Local MCP Configuration (JSON)
                    </Label>
                    <Textarea
                      id="local-json"
                      placeholder={`{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
    }
  }
}`}
                      value={localMCPJson}
                      onChange={(e) => setLocalMCPJson(e.target.value)}
                      rows={12}
                      className="bg-white/10 border-white/20 text-white placeholder-gray-400 resize-none font-mono text-xs"
                      data-testid="textarea-local-json"
                    />
                    <div className="mt-2 text-xs text-gray-400">
                      <p>Enter your local MCP server configuration in JSON format.</p>
                      <p>Example:</p>
                      <pre className="bg-white/10 p-2 rounded-md text-xs text-gray-300">
{`{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "env": {
        "MEMORY_FILE_PATH": "/path/to/custom/memory.json"
      }
    }
  }
}`}
                      </pre>
                    </div>
                  </div>
                  <Button
                    type="button"
                    className="flex-1 border"
                    style={{
                      background: 'linear-gradient(135deg, #C4B643, #D4C760)',
                      borderColor: '#C4B643',
                      color: '#0A0A07'
                    }}
                    onClick={parseLocalMCPConfig}
                    disabled={!localMCPJson.trim() || localMCPJson.trim().length < 10} // Disable if JSON is empty or too short
                    data-testid="button-parse-json"
                  >
                    <CheckCircle className="w-4 h-4 mr-2" style={{color: '#0A0A07'}} />
                    Parse Configuration
                  </Button>
                </div>
              )}

              {localRegistrationStage === 'review' && (
                <div className="space-y-4">
                  <div>
                    <Label htmlFor="local-name" className="text-sm font-semibold" style={{color: '#92E4DD'}}>
                      Server Name
                    </Label>
                    <Input
                      id="local-name"
                      placeholder="e.g., Memory Server"
                      value={localFormData.name}
                      onChange={(e) => {
                        updateLocalFormData('name', e.target.value);
                        if (e.target.value.trim()) {
                          checkNameConflictForAllTypes(e.target.value);
                        } else {
                          setNameConflict(null);
                        }
                      }}
                      className="bg-white/10 border-white/20 text-white placeholder-gray-400"
                      required
                      data-testid="input-local-service-name"
                    />
                    {nameConflict && (
                      <div className="mt-2 text-xs text-red-400 flex items-center">
                        <AlertTriangle className="w-4 h-4 mr-1" />
                        A service with the name &quot;{nameConflict}&quot; already exists.
                      </div>
                    )}
                  </div>
                  
                  <div>
                    <Label htmlFor="command" className="text-sm font-semibold" style={{color: '#92E4DD'}}>Command</Label>
                    <Input
                      id="command"
                      placeholder="e.g., npx, python, node"
                      value={localFormData.command}
                      onChange={(e) => updateLocalFormData('command', e.target.value)}
                      className="bg-white/10 border-white/20 text-white placeholder-gray-400"
                      required
                      data-testid="input-command"
                    />
                    <div className="mt-1 text-xs text-gray-400">
                      The command to execute (e.g., npx, python, node)
                    </div>
                  </div>
                  
                  <div>
                    <Label className="text-sm font-semibold" style={{color: '#92E4DD'}}>Arguments</Label>
                    {localFormData.args.map((arg, index) => (
                      <div key={index} className="flex gap-2 mb-2">
                        <Input
                          placeholder={`Argument ${index + 1}`}
                          value={arg}
                          onChange={(e) => {
                            const newArgs = [...localFormData.args];
                            newArgs[index] = e.target.value;
                            updateLocalFormData('args', newArgs);
                          }}
                          className="bg-white/10 border-white/20 text-white placeholder-gray-400"
                          data-testid={`input-arg-${index}`}
                        />
                        {index === localFormData.args.length - 1 && (
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => updateLocalFormData('args', [...localFormData.args, ''])}
                            className="bg-white/20 hover:bg-white/30 text-white"
                          >
                            <Plus className="w-4 h-4" />
                          </Button>
                        )}
                        {localFormData.args.length > 1 && (
                          <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            onClick={() => {
                              const newArgs = localFormData.args.filter((_, i) => i !== index);
                              updateLocalFormData('args', newArgs);
                            }}
                            className="bg-red-500/80 hover:bg-red-500 text-white"
                          >
                            <X className="w-4 h-4" />
                          </Button>
                        )}
                      </div>
                    ))}
                    <div className="mt-1 text-xs text-gray-400">
                      Command arguments (e.g., -y, @modelcontextprotocol/server-memory)
                    </div>
                  </div>
                  
                  <div>
                    <Label className="text-sm font-semibold" style={{color: '#92E4DD'}}>Environment Variables</Label>
                    {Object.entries(localFormData.env).length === 0 ? (
                      <div className="text-gray-400 text-sm italic">No environment variables configured</div>
                    ) : (
                      <div className="space-y-2">
                        {Object.entries(localFormData.env).map(([key, value], index) => (
                          <div key={index} className="flex gap-2">
                            <Input
                              placeholder="Variable name"
                              value={key}
                              onChange={(e) => {
                                const newEnv = { ...localFormData.env };
                                delete newEnv[key];
                                newEnv[e.target.value] = value;
                                updateLocalFormData('env', newEnv);
                              }}
                              className="bg-white/10 border-white/20 text-white placeholder-gray-400"
                              data-testid={`input-env-key-${index}`}
                            />
                            <Input
                              placeholder="Value"
                              value={value}
                              onChange={(e) => {
                                const newEnv = { ...localFormData.env };
                                newEnv[key] = e.target.value;
                                updateLocalFormData('env', newEnv);
                              }}
                              className="bg-white/10 border-white/20 text-white placeholder-gray-400"
                              data-testid={`input-env-value-${index}`}
                            />
                            <Button
                              type="button"
                              size="sm"
                              variant="destructive"
                              onClick={() => {
                                const newEnv = { ...localFormData.env };
                                delete newEnv[key];
                                updateLocalFormData('env', newEnv);
                              }}
                              className="bg-red-500/80 hover:bg-red-500 text-white"
                            >
                              <X className="w-4 h-4" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => {
                        const newEnv = { ...localFormData.env };
                        newEnv[''] = '';
                        updateLocalFormData('env', newEnv);
                      }}
                      className="mt-2 bg-white/20 hover:bg-white/30 text-white"
                    >
                      <Plus className="w-4 h-4 mr-2" />
                      Add Environment Variable
                    </Button>
                    <div className="mt-1 text-xs text-gray-400">
                      Environment variables for the MCP server process
                    </div>
                  </div>
                  
                  <div>
                    <Label htmlFor="local-description" className="text-sm font-semibold" style={{color: '#92E4DD'}}>Description</Label>
                    <Textarea
                      id="local-description"
                      placeholder="Brief description of capabilities..."
                      value={localFormData.description}
                      onChange={(e) => updateLocalFormData('description', e.target.value)}
                      rows={3}
                      className="bg-white/10 border-white/20 text-white placeholder-gray-400 resize-none"
                      data-testid="textarea-local-description"
                    />
                  </div>
                  <div className="flex gap-3">
                    <Button
                      type="button"
                      variant="outline"
                      className="flex-1 border-white/20 text-white hover:bg-white/10"
                      onClick={() => setLocalRegistrationStage('json')}
                      data-testid="button-back-to-json"
                    >
                      ← Back to JSON
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      className={`flex-1 border-2 hover:opacity-90 ${CARD_FACE_CLASS}`}
                      style={cardAccentStyle(MCP_CARD_COLOR)}
                      onClick={handleSubmit}
                      disabled={isSubmitDisabled()}
                      data-testid="button-register"
                    >
                      <Plus className="w-4 h-4 mr-2" />
                      {registerServiceMutation.isPending ? 'Registering...' : getSubmitButtonText()}
                    </Button>
                  </div>
                </div>
              )}

              {localRegistrationStage === 'complete' && (
                <div className="text-center py-8">
                  <CheckCircle className="w-16 h-16 text-green-500 mx-auto mb-4" />
                  <h3 className="text-xl font-bold mb-2" style={{color: '#92E4DD'}}>Local MCP Registered!</h3>
                  <p className="text-gray-400 mb-4">Your local MCP server has been successfully registered.</p>
                  <Button
                    type="button"
                    className="flex-1 border"
                    style={{
                      background: 'linear-gradient(135deg, #C4B643, #D4C760)',
                      borderColor: '#C4B643',
                      color: '#0A0A07'
                    }}
                    onClick={handleClose}
                    data-testid="button-close"
                  >
                    Close
                  </Button>
                </div>
              )}
            </TabsContent>
          </Tabs>
        ) : (
          <div className="space-y-4">
            <div>
              <Label htmlFor="name" className="text-sm font-semibold" style={{color: '#92E4DD'}}>
                Agent Name
              </Label>
              <Input
                id="name"
                placeholder="e.g., Code Assistant"
                value={a2aFormData.name}
                onChange={(e) => {
                  updateA2aFormData('name', e.target.value);
                  if (e.target.value.trim()) {
                    checkNameConflictForAllTypes(e.target.value);
                  } else {
                    setNameConflict(null);
                  }
                }}
                className="bg-white/10 border-white/20 text-white placeholder-gray-400"
                required
                data-testid="input-service-name"
              />
              {nameConflict && (
                <div className="flex items-center gap-2 mt-1 text-red-400 text-sm">
                  <AlertTriangle className="w-4 h-4" />
                  <span>A service with this name already exists</span>
                </div>
              )}
            </div>
            
            <div>
              <Label htmlFor="manifest_url" className="text-sm font-semibold" style={{color: '#92E4DD'}}>Manifest URL</Label>
              <Input
                id="manifest_url"
                type="url"
                placeholder="http://localhost:8001/.well-known/a2a/manifest.json"
                value={a2aFormData.manifest_url}
                onChange={(e) => updateA2aFormData('manifest_url', e.target.value)}
                className="bg-white/10 border-white/20 text-white placeholder-gray-400"
                required
                data-testid="input-manifest-url"
              />
            </div>
            
            <div>
              <Label htmlFor="description" className="text-sm font-semibold" style={{color: '#92E4DD'}}>Description</Label>
              <Textarea
                id="description"
                placeholder="Brief description of capabilities..."
                value={a2aFormData.description}
                onChange={(e) => updateA2aFormData('description', e.target.value)}
                rows={3}
                className="bg-white/10 border-white/20 text-white placeholder-gray-400 resize-none"
                data-testid="textarea-description"
              />
            </div>
          </div>
        )}

        {/* Headers Configuration Section - Only for Remote MCP services */}
        {type === 'mcp' && activeTab === 'remote' && (
          <div className="space-y-4 border border-white/10 rounded-lg p-4">
            <div className="flex items-center space-x-2">
              <input
                type="checkbox"
                id="headers_enabled"
                checked={remoteFormData.headers_enabled}
                onChange={(e) => setHeadersEnabled(e.target.checked)}
                className="rounded border-white/20 bg-white/10"
              />
              <Label htmlFor="headers_enabled" className="text-sm font-semibold" style={{color: '#92E4DD'}}>
                🔐 Authentication Required
              </Label>
            </div>
            <div className="text-xs text-gray-400">
              <p>Enable this if your MCP server requires authentication (API keys, tokens, etc.).</p>
            </div>
            
            {remoteFormData.headers_enabled && (
              <div className="space-y-3 pl-6">
                <div className="text-xs text-gray-400 mb-2">
                  <p>Configure HTTP headers for authentication. Common examples:</p>
                  <ul className="list-disc list-inside ml-2 mt-1 space-y-1">
                    <li><code>Authorization: Bearer YOUR_TOKEN</code> - For API tokens</li>
                    <li><code>X-API-Key: YOUR_API_KEY</code> - For API keys</li>
                    <li><code>X-Custom-Header: value</code> - For custom headers</li>
                  </ul>
                </div>
                <div>
                  <Label htmlFor="headers" className="text-sm font-semibold" style={{color: '#92E4DD'}}>HTTP Headers (JSON)</Label>
                  <Textarea
                    id="headers"
                    placeholder={`{
  "Authorization": "Bearer YOUR_TOKEN_HERE",
  "X-API-Key": "YOUR_API_KEY_HERE"
}`}
                    value={headersJson}
                    onChange={(e) => {
                      setHeadersJson(e.target.value);
                      if (headersJsonError) {
                        setHeadersJsonError(null);
                      }
                    }}
                    onBlur={() => {
                      if (headersJson.trim()) {
                        parseHeadersJson();
                      }
                    }}
                    rows={6}
                    className="bg-white/10 border-white/20 text-white placeholder-gray-400 resize-none font-mono text-xs"
                    data-testid="textarea-headers"
                  />
                  {headersJsonError && (
                    <p className="text-red-400 text-xs mt-1 flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3 shrink-0" />
                      {headersJsonError}
                    </p>
                  )}
                  <div className="text-xs text-gray-400 mt-1">
                    <p>Enter headers as JSON. Keys are header names, values are header values.</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Error Messages */}
        {parsedConfigError && (
          <div className="text-red-400 text-sm mt-2">
            <AlertTriangle className="w-4 h-4 mr-1" />
            {parsedConfigError}
          </div>
        )}
        {nameConflict && (
          <div className="text-red-400 text-sm mt-2">
            <AlertTriangle className="w-4 h-4 mr-1" />
            A service with the name &quot;{nameConflict}&quot; already exists. You can register it anyway, but it might overwrite the existing one.
          </div>
        )}

        {/* Submit Buttons */}
        <div className="flex space-x-3 pt-4">
          <Button 
            type="button" 
            variant="secondary" 
            className="flex-1 border text-white"
            style={{
              background: '#ad095e',
              borderColor: '#ad095e'
            }}
            onClick={handleClose}
            data-testid="button-cancel"
          >
            Cancel
          </Button>
          {!(type === 'mcp' && activeTab === 'local') && (
            <Button 
              type="button"
              variant="ghost"
              className={`flex-1 border-2 hover:opacity-90 ${CARD_FACE_CLASS}`}
              style={cardAccentStyle(MCP_CARD_COLOR)}
              disabled={registerServiceMutation.isPending || isSubmitDisabled()}
              data-testid="button-register"
              onClick={handleSubmit}
            >
              <Plus className="w-4 h-4 mr-2" />
              {registerServiceMutation.isPending ? 'Registering...' : 'Register Service'}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
