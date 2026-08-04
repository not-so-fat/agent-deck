import { Service } from "@agent-deck/shared";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Database, Brain, ExternalLink, Wrench, User, Calendar, Activity, Bolt, AlertTriangle } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { apiRequest } from "@/lib/queryClient";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import McpToolsPanel from "@/components/mcp-tools-panel";
import { OAuthConnectPanel } from "@/components/oauth-connect-panel";
import { invalidateDashboardServiceQueries } from "@/lib/invalidate-dashboard-queries";
import {
  formatHeadersForEditor,
  hasCustomHeaders,
  maskedHeadersEntries,
  parseHeadersJson,
} from "@/lib/service-headers";


// API response type that matches the backend
interface APIService {
  id: string;
  name: string;
  type: string;
  url: string;
  health: string;
  description: string;
  registeredAt: string;
  updatedAt: string;
  headers?: Record<string, any>;
  localCommand?: string;
  localArgs?: string[];
  localEnv?: Record<string, string>;
}

function isGoogleDriveLocalMcp(service: APIService | null | undefined): boolean {
  if (!service || service.type !== 'local-mcp') return false;
  const haystack = [
    service.localCommand,
    ...(service.localArgs ?? []),
    service.url,
    service.name,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes('google-drive') || haystack.includes('google_drive');
}

interface ServiceDetailsModalProps {
  service: Service | null;
  isOpen: boolean;
  onClose: () => void;
}

interface MCPTool {
  name: string;
  description: string;
  inputSchema?: any;
}

interface A2AManifest {
  name: string;
  description: string;
  url: string;
  provider?: {
    organization: string;
    url: string;
  };
  version: string;
  documentationUrl?: string;
  capabilities?: {
    streaming?: boolean;
    pushNotifications?: boolean;
    stateTransitionHistory?: boolean;
  };
  securitySchemes?: Record<string, {
    type: string;
    description: string;
  }>;
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  skills?: Array<{
    id: string;
    name: string;
    description: string;
    tags?: string[];
    examples?: string[];
    inputModes?: string[];
    outputModes?: string[];
  }>;
  supportsAuthenticatedExtendedCard?: boolean;
}

export default function ServiceDetailsModal({ 
  service, 
  isOpen, 
  onClose 
}: ServiceDetailsModalProps) {
  const [error, setError] = useState<string | null>(null);
  const [isEditingName, setIsEditingName] = useState(false);
  const [isEditingDescription, setIsEditingDescription] = useState(false);
  const [editingName, setEditingName] = useState<string>('');
  const [editingDescription, setEditingDescription] = useState<string>('');
  const [isUpdatingName, setIsUpdatingName] = useState(false);
  const [isUpdatingDescription, setIsUpdatingDescription] = useState(false);
  const [isEditingHeaders, setIsEditingHeaders] = useState(false);
  const [headersJson, setHeadersJson] = useState('{\n  \n}');
  const [headersJsonError, setHeadersJsonError] = useState<string | null>(null);
  const [isUpdatingHeaders, setIsUpdatingHeaders] = useState(false);
  const [currentService, setCurrentService] = useState<Service | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Prefer the selected card; only reuse currentService for refreshes of the same id.
  const activeService =
    service && currentService?.id === service.id ? currentService : service;
  const apiService = activeService as unknown as APIService;
  const activeHeaders =
    (apiService?.headers && typeof apiService.headers === 'object'
      ? (apiService.headers as Record<string, string>)
      : null);
  
  // Ensure we have a valid service before running queries
  const hasValidService = Boolean(apiService && apiService.id && apiService.url);

  // Query for MCP discovery analysis
  const { data: mcpDiscoveryData, isLoading: mcpDiscoveryLoading, error: mcpDiscoveryError, refetch: refetchMcpDiscovery } = useQuery({
    queryKey: ['/api/mcp/discover', apiService?.url],
    queryFn: async () => {
      if (!apiService || apiService.type !== 'mcp') return null;
      
      console.log(`🔍 Attempting MCP discovery for: ${apiService.url}`);
      
      try {
        const response = await apiRequest('POST', '/api/mcp/discover', { url: apiService.url });
        const data = await response.json();
        console.log(`✅ MCP discovery successful for ${apiService.url}:`, data);
        return data;
      } catch (error) {
        console.log(`❌ MCP discovery failed for ${apiService.url}:`, error);
        throw error;
      }
    },
    enabled: hasValidService && apiService.type === 'mcp' && isOpen,
    staleTime: 0, // Always fetch fresh data for discovery
    gcTime: 2 * 60 * 1000, // 2 minutes cache time
  });

  const oauthRequired = mcpDiscoveryData?.data?.oauth?.required === true;

  const { data: oauthStatusData, refetch: refetchOAuthStatus } = useQuery({
    queryKey: ['/api/oauth', apiService?.id, 'status'],
    queryFn: async () => {
      const response = await apiRequest('GET', `/api/oauth/${apiService!.id}/status`);
      const json = await response.json();
      if (!response.ok || !json.success) {
        throw new Error(json.error || 'Failed to load OAuth status');
      }
      return json.data as {
        hasToken: boolean;
        isExpired: boolean;
        authenticated: boolean;
        hasRefreshToken: boolean;
        expiresAt?: string;
      };
    },
    enabled: hasValidService && apiService.type === 'mcp' && isOpen && oauthRequired,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.authenticated) {
        return false;
      }
      return 2000;
    },
  });

  const getOAuthStatus = () => {
    if (!oauthRequired) {
      return { status: 'not_required' as const, message: null };
    }

    if (oauthStatusData?.authenticated) {
      return { status: 'authenticated' as const, message: null };
    }

    if (oauthStatusData?.hasToken && oauthStatusData?.isExpired) {
      return {
        status: 'expired' as const,
        message: 'OAuth Token Expired - Please re-authenticate',
      };
    }

    return {
      status: 'required' as const,
      message: 'OAuth 2.0 Authentication Required',
    };
  };

  // Get OAuth status after discovery data is available
  const oauthStatus = getOAuthStatus();

  console.log('MCP Discovery Query Debug:', {
    apiService: apiService?.id,
    apiServiceType: apiService?.type,
    apiServiceUrl: apiService?.url,
    isOpen,
    hasValidService,
    enabled: hasValidService && apiService.type === 'mcp' && isOpen,
    mcpDiscoveryLoading,
    mcpDiscoveryData: mcpDiscoveryData ? JSON.stringify(mcpDiscoveryData, null, 2) : null,
    mcpDiscoveryDataKeys: mcpDiscoveryData ? Object.keys(mcpDiscoveryData) : null,
    oauthRequired: mcpDiscoveryData?.data?.oauth?.required,
    oauthData: mcpDiscoveryData?.data?.oauth ? JSON.stringify(mcpDiscoveryData.data.oauth, null, 2) : null,
    toolsQueryEnabled: hasValidService && apiService.type === 'mcp' && isOpen && !mcpDiscoveryData?.data?.oauth?.required
  });

  // Query for MCP tools discovery
  const { data: mcpToolsData, isLoading: mcpToolsLoading, error: mcpToolsError, refetch: refetchMcpTools } = useQuery({
    queryKey: ['/api/services', apiService?.id, 'tools'],
    queryFn: async () => {
      if (!apiService || (apiService.type !== 'mcp' && apiService.type !== 'local-mcp')) return { data: [] };
      
      console.log(`🔍 Attempting to discover tools for MCP service: ${apiService.id} at ${apiService.url}`);
      
      try {
        const response = await apiRequest('GET', `/api/services/${apiService.id}/tools`);
        const responseData = await response.json();
        console.log(`✅ MCP tools discovery successful for ${apiService.id}:`, responseData);
        return responseData;
      } catch (error) {
        console.log(`❌ MCP tools discovery failed for ${apiService.id}:`, error);
        throw error;
      }
    },
    enabled: hasValidService && (apiService.type === 'mcp' || apiService.type === 'local-mcp') && isOpen && (apiService.type === 'local-mcp' || oauthStatus.status === 'authenticated' || oauthStatus.status === 'not_required'),
    staleTime: 0,
    gcTime: 2 * 60 * 1000,
  });

  useEffect(() => {
    if (!isOpen || !apiService?.id) {
      return;
    }
    if (apiService.type !== 'mcp' && apiService.type !== 'local-mcp') {
      return;
    }

    const canLoadTools =
      apiService.type === 'local-mcp' ||
      oauthStatus.status === 'authenticated' ||
      oauthStatus.status === 'not_required';
    if (!canLoadTools || mcpToolsLoading || mcpToolsError) {
      return;
    }

    let cancelled = false;

    const refreshServiceHealth = async () => {
      try {
        const response = await apiRequest('GET', `/api/services/${apiService.id}`);
        const payload = await response.json();
        if (!cancelled && payload?.success && payload.data) {
          setCurrentService(payload.data);
        }
        queryClient.invalidateQueries({ queryKey: ['/api/services'] });
      } catch {
        // Health is best-effort after tool discovery.
      }
    };

    void refreshServiceHealth();

    return () => {
      cancelled = true;
    };
  }, [isOpen, apiService?.id, apiService?.type, mcpToolsLoading, mcpToolsError, oauthStatus.status, queryClient]);

  useEffect(() => {
    if (!isOpen || !apiService?.id || apiService.type !== 'a2a') {
      return;
    }

    let cancelled = false;

    const probeA2aHealth = async () => {
      try {
        await apiRequest('GET', `/api/services/${apiService.id}/health`);
        const response = await apiRequest('GET', `/api/services/${apiService.id}`);
        const payload = await response.json();
        if (!cancelled && payload?.success && payload.data) {
          setCurrentService(payload.data);
        }
        queryClient.invalidateQueries({ queryKey: ['/api/services'] });
      } catch {
        // Best-effort health probe.
      }
    };

    void probeA2aHealth();

    return () => {
      cancelled = true;
    };
  }, [isOpen, apiService?.id, apiService?.type, queryClient]);

  console.log('MCP Tools Query Debug:', {
    hasValidService,
    apiServiceType: apiService?.type,
    isOpen,
    oauthRequired: mcpDiscoveryData?.data?.oauth?.required,
    oauthStatus: oauthStatus.status,
    toolsQueryEnabled: hasValidService && (apiService.type === 'mcp' || apiService.type === 'local-mcp') && isOpen && (apiService.type === 'local-mcp' || oauthStatus.status === 'authenticated' || oauthStatus.status === 'not_required'),
    mcpToolsLoading
  });

  // Query for A2A manifest
  const { data: a2aManifestData, isLoading: a2aManifestLoading, error: a2aManifestError } = useQuery({
    queryKey: ['/api/proxy/a2a', apiService?.id, 'manifest'],
    queryFn: async () => {
      if (!apiService || apiService.type !== 'a2a') return null;
      const response = await apiRequest('GET', `/api/proxy/a2a/${apiService.id}/manifest`);
      const responseText = await response.text();
      return JSON.parse(responseText);
    },
    enabled: hasValidService && apiService.type === 'a2a' && isOpen,
    staleTime: 0, // Always fetch fresh data for manifest
    gcTime: 2 * 60 * 1000, // 2 minutes cache time
  });

  const mcpTools = mcpToolsData?.data || [];
  const a2aManifest = a2aManifestData;
  const isLoading = mcpToolsLoading || a2aManifestLoading;

  // Debug logging
  console.log('ServiceDetailsModal Debug:', {
    service: service?.id,
    serviceType: service?.type,
    isOpen,
    mcpDiscoveryLoading,
    mcpDiscoveryData: mcpDiscoveryData,
    mcpDiscoveryError: mcpDiscoveryError ? String(mcpDiscoveryError) : null,
    mcpToolsLoading,
    a2aManifestLoading,
    mcpToolsError: mcpToolsError ? String(mcpToolsError) : null,
    a2aManifestError: a2aManifestError ? String(a2aManifestError) : null,
    mcpToolsCount: mcpTools.length,
    mcpToolsData: mcpToolsData,
    hasA2aManifest: !!a2aManifest,
    isLoading,
    oauthRequired: mcpDiscoveryData?.data?.oauth?.required,
    oauthStatus: oauthStatus.status,
    oauthMessage: oauthStatus.message,
    oauthAuthenticated: oauthStatusData?.authenticated,
    expiresAt: oauthStatusData?.expiresAt,
  });

  useEffect(() => {
    if (!isOpen) {
      setCurrentService(null);
      setIsEditingHeaders(false);
      setHeadersJsonError(null);
      oauthResolvedThisSession.current = false;
      oauthCompletionHandled.current = false;
      return;
    }
    if (service) {
      setCurrentService(service);
      setEditingName(service.name || '');
      setEditingDescription(service.description || '');
      setIsEditingHeaders(false);
      setHeadersJsonError(null);
    }
  }, [service, isOpen]);

  const oauthCompletionHandled = useRef(false);
  const oauthResolvedThisSession = useRef(false);

  // Refresh service data after OAuth completes (status query polls until authenticated)
  useEffect(() => {
    if (!isOpen || !apiService?.id) {
      oauthCompletionHandled.current = false;
      return;
    }

    if (!oauthStatusData?.authenticated) {
      oauthCompletionHandled.current = false;
      return;
    }

    if (oauthCompletionHandled.current) {
      return;
    }
    oauthCompletionHandled.current = true;
    oauthResolvedThisSession.current = true;

    const refreshAfterOAuth = async () => {
      toast({
        title: 'OAuth completed',
        description: 'Authentication successful! Refreshing service status...',
      });

      invalidateDashboardServiceQueries(queryClient, apiService.id);
      queryClient.invalidateQueries({ queryKey: ['/api/mcp/discover', apiService.url] });

      try {
        const serviceResponse = await apiRequest('GET', `/api/services/${apiService.id}`);
        if (serviceResponse.ok) {
          const updatedService = await serviceResponse.json();
          setCurrentService(updatedService.data ?? updatedService);
        }
      } catch {
        // best-effort refresh
      }

      await refetchMcpDiscovery();
      queryClient.invalidateQueries({ queryKey: ['/api/services', apiService.id, 'tools'] });
      await refetchMcpTools();
      oauthResolvedThisSession.current = false;
    };

    void refreshAfterOAuth();
  }, [oauthStatusData?.authenticated, isOpen, apiService?.id]);

  const getServiceIcon = () => {
    return service?.type === 'mcp' ? <Database className="w-6 h-6" /> : <Brain className="w-6 h-6" />;
  };

  const getServiceTypeColor = () => {
    return service?.type === 'mcp' ? 'text-blue-400' : 'text-purple-400';
  };

  const getServiceTypeBg = () => {
    return service?.type === 'mcp' ? 'bg-blue-500/20' : 'bg-purple-500/20';
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  useEffect(() => {
    if (isEditingName) {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    }
  }, [isEditingName]);

  const commitNameRename = async () => {
    const currentName = activeService?.name || '';
    const next = editingName.trim();
    if (!activeService || !next || next === currentName) {
      setEditingName(currentName);
      setIsEditingName(false);
      return;
    }

    setIsUpdatingName(true);
    try {
      await apiRequest('PUT', `/api/services/${activeService.id}`, { name: next });
      setCurrentService({ ...activeService, name: next });
      queryClient.invalidateQueries({ queryKey: ['/api/services'] });
      queryClient.invalidateQueries({ queryKey: ['/api/collection/warnings'] });
      queryClient.invalidateQueries({ queryKey: ['/api/decks'] });
      setIsEditingName(false);
    } catch (error) {
      setEditingName(currentName);
      setIsEditingName(false);
      toast({
        title: 'Could not rename service',
        description: error instanceof Error ? error.message : 'Failed to update name',
        variant: 'destructive',
      });
    } finally {
      setIsUpdatingName(false);
    }
  };

  const handleDescriptionUpdate = async () => {
    if (!service) return;
    
    setIsUpdatingDescription(true);
    try {
      const response = await apiRequest('PUT', `/api/services/${service.id}`, {
        description: editingDescription.trim()
      });
      
      if (response.ok) {
        // Update the local service object immediately
        if (currentService) {
          const updatedService = { ...currentService, description: editingDescription.trim() };
          setCurrentService(updatedService);
        }
        
        queryClient.invalidateQueries({ queryKey: ['/api/services'] });
        queryClient.invalidateQueries({ queryKey: ['/api/collection/warnings'] });
        queryClient.invalidateQueries({ queryKey: ['/api/decks'] });
        queryClient.invalidateQueries({ queryKey: ['/api/decks'] });
        
        toast({
          title: "Description updated",
          description: `Service description has been updated successfully.`,
        });
        
        setIsEditingDescription(false);
      } else {
        throw new Error('Failed to update description');
      }
    } catch (error) {
      toast({
        title: "Update failed",
        description: "Failed to update service description. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsUpdatingDescription(false);
    }
  };

  const beginHeadersEdit = () => {
    setHeadersJson(formatHeadersForEditor(activeHeaders));
    setHeadersJsonError(null);
    setIsEditingHeaders(true);
  };

  const cancelHeadersEdit = () => {
    setIsEditingHeaders(false);
    setHeadersJsonError(null);
    setHeadersJson(formatHeadersForEditor(activeHeaders));
  };

  const handleHeadersSave = async () => {
    if (!activeService) return;

    const parsed = parseHeadersJson(headersJson);
    if (!parsed.ok) {
      setHeadersJsonError(parsed.error);
      return;
    }

    setIsUpdatingHeaders(true);
    try {
      const response = await apiRequest('PUT', `/api/services/${activeService.id}`, {
        headers: parsed.headers,
      });
      if (!response.ok) {
        throw new Error('Failed to update headers');
      }

      const nextHeaders =
        Object.keys(parsed.headers).length > 0 ? parsed.headers : undefined;
      setCurrentService({
        ...(activeService as Service),
        headers: nextHeaders,
      });
      setIsEditingHeaders(false);
      setHeadersJsonError(null);
      invalidateDashboardServiceQueries(queryClient, activeService.id);
      queryClient.invalidateQueries({ queryKey: ['/api/decks'] });
      toast({
        title: 'Headers updated',
        description: 'Custom headers saved. Reconnecting with the new values.',
      });
    } catch (error) {
      toast({
        title: 'Update failed',
        description:
          error instanceof Error ? error.message : 'Failed to update headers. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setIsUpdatingHeaders(false);
    }
  };

  const handleDialogOpenChange = (open: boolean) => {
    if (open) {
      return;
    }

    if (oauthResolvedThisSession.current) {
      invalidateDashboardServiceQueries(queryClient, apiService?.id ?? service?.id);
      oauthResolvedThisSession.current = false;
    }
    oauthCompletionHandled.current = false;
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="sm:max-w-6xl bg-gradient-to-br from-cosmic-900 to-cosmic-800 border border-white/20 text-white max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-2xl font-bold flex items-center">
            {getServiceIcon()}
            <div className="ml-3 flex min-w-0 items-center">
              {isEditingName ? (
                <input
                  ref={nameInputRef}
                  type="text"
                  value={editingName}
                  disabled={isUpdatingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onBlur={() => {
                    void commitNameRename();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void commitNameRename();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setEditingName(activeService?.name || '');
                      setIsEditingName(false);
                    }
                  }}
                  className="max-w-[16rem] rounded border border-white/20 bg-white/10 px-2 py-1 text-2xl font-bold text-white focus:border-white/40 focus:outline-none sm:max-w-[20rem]"
                  aria-label="Service name"
                  data-testid="input-service-name"
                />
              ) : (
                <button
                  type="button"
                  className="min-w-0 truncate text-left hover:underline"
                  title="Click to rename"
                  onClick={() => {
                    setEditingName(activeService?.name || '');
                    setIsEditingName(true);
                  }}
                  data-testid="button-rename-service"
                >
                  {activeService?.name}
                </button>
              )}
            </div>
            <Badge className={`ml-3 ${getServiceTypeBg()} ${getServiceTypeColor()}`}>
              {service?.type?.toUpperCase()}
            </Badge>
          </DialogTitle>
        </DialogHeader>

        {service && (
          <div className="space-y-6">
            {/* Service Overview Card */}
            <div className="bg-black/20 rounded-lg p-4 border border-white/10">
              <div className="mb-3">
                <h3 className="text-lg font-semibold flex items-center">
                  <Activity className="w-5 h-5 mr-2" />
                  Service Overview
                </h3>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-gray-300 text-sm">Description</p>
                    {!isEditingDescription && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setIsEditingDescription(true)}
                        className="h-6 w-6 p-0 opacity-0 hover:opacity-100 transition-opacity"
                        title="Edit description"
                      >
                        <Wrench className="w-3 h-3" />
                      </Button>
                    )}
                  </div>
                  {isEditingDescription ? (
                    <div className="space-y-2">
                      <textarea
                        value={editingDescription}
                        onChange={(e) => setEditingDescription(e.target.value)}
                        className="w-full bg-black/30 border border-white/20 rounded px-2 py-1 text-white focus:outline-none focus:border-white/40 resize-none"
                        rows={3}
                        placeholder="Enter description..."
                        autoFocus
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={handleDescriptionUpdate}
                          disabled={isUpdatingDescription}
                          className="h-6 px-2 text-xs"
                        >
                          {isUpdatingDescription ? 'Saving...' : 'Save'}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setIsEditingDescription(false);
                            setEditingDescription((activeService)?.description || '');
                          }}
                          className="h-6 px-2 text-xs"
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p 
                      className="text-white cursor-pointer hover:bg-white/10 px-2 py-1 rounded transition-colors"
                      onClick={() => setIsEditingDescription(true)}
                      title="Click to edit description"
                    >
                      {(activeService)?.description || 'No description'}
                    </p>
                  )}
                </div>
                <div>
                  <p className="text-gray-300 text-sm mb-1">Endpoint</p>
                  <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <Badge variant="outline" className="border-blue-500/30 text-blue-300">
                        {apiService.type.toUpperCase()}
                      </Badge>
                        {apiService.type === 'mcp' && hasCustomHeaders(activeHeaders) && (
                          <Badge variant="outline" className="border-green-500/30 text-green-300">
                            Custom Headers
                          </Badge>
                        )}
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => window.open(apiService.url, '_blank')}
                      className="p-1 h-auto"
                    >
                      <ExternalLink className="w-4 h-4" />
                    </Button>
                    </div>
                    <div className="text-xs text-gray-400 break-all bg-black/20 p-2 rounded border border-white/10">
                      {apiService.url || 'No URL available'}
                    </div>
                    {apiService.type === 'mcp' && (
                      <div
                        className="text-xs text-gray-400 bg-black/20 p-2 rounded border border-white/10"
                        data-testid="custom-headers-section"
                      >
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <p className="font-semibold text-gray-300">Custom Headers</p>
                          {!isEditingHeaders && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 px-2 text-xs text-teal-300 hover:text-teal-200"
                              onClick={beginHeadersEdit}
                              data-testid="button-edit-headers"
                            >
                              Edit
                            </Button>
                          )}
                        </div>
                        {isEditingHeaders ? (
                          <div className="space-y-2">
                            <Textarea
                              value={headersJson}
                              onChange={(e) => {
                                setHeadersJson(e.target.value);
                                if (headersJsonError) {
                                  setHeadersJsonError(null);
                                }
                              }}
                              rows={6}
                              className="bg-white/10 border-white/20 text-white placeholder-gray-400 resize-none font-mono text-xs"
                              data-testid="textarea-edit-headers"
                              disabled={isUpdatingHeaders}
                            />
                            {headersJsonError && (
                              <p
                                className="text-red-400 text-xs flex items-center gap-1"
                                data-testid="headers-json-error"
                              >
                                <AlertTriangle className="w-3 h-3 shrink-0" />
                                {headersJsonError}
                              </p>
                            )}
                            <div className="flex justify-end gap-2">
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs"
                                onClick={cancelHeadersEdit}
                                disabled={isUpdatingHeaders}
                                data-testid="button-cancel-headers"
                              >
                                Cancel
                              </Button>
                              <Button
                                size="sm"
                                className="h-7 px-3 text-xs bg-teal-600 hover:bg-teal-500"
                                onClick={handleHeadersSave}
                                disabled={isUpdatingHeaders}
                                data-testid="button-save-headers"
                              >
                                {isUpdatingHeaders ? 'Saving…' : 'Save'}
                              </Button>
                            </div>
                          </div>
                        ) : hasCustomHeaders(activeHeaders) ? (
                          <ul className="space-y-1 font-mono" data-testid="headers-masked-list">
                            {maskedHeadersEntries(activeHeaders).map(({ name, masked }) => (
                              <li key={name}>
                                <span className="text-gray-300">{name}</span>
                                <span className="text-gray-500">: </span>
                                <span>{masked}</span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-gray-500" data-testid="headers-empty-state">
                            No custom headers. Add Bearer or API key headers to authenticate.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                <div>
                  <p className="text-gray-300 text-sm mb-1">Health Status</p>
                  <Badge
                    className={
                      apiService.health === 'healthy'
                        ? 'bg-green-500/20 text-green-300'
                        : apiService.health === 'unhealthy'
                          ? 'bg-red-500/20 text-red-300'
                          : 'bg-amber-500/20 text-amber-200'
                    }
                  >
                    {apiService.health === 'healthy'
                      ? 'Healthy'
                      : apiService.health === 'unhealthy'
                        ? 'Unreachable'
                        : oauthStatus.status === 'required' || oauthStatus.status === 'expired'
                          ? 'Auth required'
                          : 'Unknown'}
                  </Badge>
                </div>
                <div>
                  <p className="text-gray-300 text-sm mb-1">Registered</p>
                  <p className="text-white text-sm">{formatDate(apiService.registeredAt)}</p>
                </div>
              </div>
              

            </div>

            {/* Loading State */}
            {isLoading && (
              <div className="text-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white mx-auto mb-4"></div>
                <p className="text-gray-400">Fetching service details...</p>
              </div>
            )}

            {/* Error State */}
            {error && (
              <div className="bg-red-500/20 border border-red-500/30 rounded-lg p-4">
                <p className="text-red-300">{error}</p>
              </div>
            )}

            {(service.type === 'mcp' || service.type === 'local-mcp') && (
              <>
            {service.type === 'local-mcp' && (
              <div className="bg-cyan-500/15 border border-cyan-500/30 rounded-lg p-4 mb-4">
                <h3 className="text-cyan-200 font-semibold mb-2">Local MCP — auth happens outside Agent Deck</h3>
                <div className="text-cyan-100/90 text-sm space-y-2">
                  {isGoogleDriveLocalMcp(apiService) ? (
                    <>
                      <p>
                        This card runs <code className="text-xs">@piotr-agier/google-drive-mcp</code> on your machine.
                        Agent Deck does <strong>not</strong> handle Google OAuth for it. If Google shows
                        &quot;app not verified&quot;, that is <strong>your Google Cloud project</strong>, not Agent Deck.
                      </p>
                      <ol className="list-decimal list-inside space-y-1 ml-1">
                        <li>Create a GCP OAuth client type <strong>Desktop app</strong> (not Web).</li>
                        <li>Add yourself as a <strong>Test user</strong> on the consent screen.</li>
                        <li>
                          Run in terminal first:{' '}
                          <code className="text-xs block mt-1 bg-black/30 p-2 rounded whitespace-pre-wrap">
                            {`export GOOGLE_DRIVE_OAUTH_CREDENTIALS="/path/to/gcp-oauth.keys.json"\nexport GOOGLE_DRIVE_MCP_AUTH_PORT=3100\nnpx @piotr-agier/google-drive-mcp auth`}
                          </code>
                        </li>
                        <li>
                          Set <code className="text-xs">GOOGLE_DRIVE_MCP_TOKEN_PATH</code> in the card env to the
                          same token file (<code className="text-xs">~/.config/google-drive-mcp/tokens.json</code>).
                        </li>
                      </ol>
                      <p className="text-xs text-cyan-200/80">
                        Full steps: <code className="text-xs">docs/GOOGLE_DRIVE_WORKAROUND.md</code> in the repo.
                      </p>
                    </>
                  ) : (
                    <p>
                      Local servers manage their own credentials (API keys, OAuth, etc.) in the spawned process.
                      Complete any login in the terminal or config for that package before expecting tools here.
                    </p>
                  )}
                </div>
              </div>
            )}
              <McpToolsPanel
                serviceId={apiService.id}
                tools={mcpTools}
                isLoading={mcpToolsLoading}
              />
              </>
            )}

            {/* A2A Agent Details - Playing Card Style */}
            {service.type === 'a2a' && a2aManifest && (
              <div className="space-y-6">
                {/* Agent Overview Card */}
                <div className="bg-black/20 rounded-lg p-4 border border-white/10">
                  <h3 className="text-lg font-semibold mb-4 flex items-center">
                    <User className="w-5 h-5 mr-2" />
                    Agent Overview
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <p className="text-gray-300 text-sm mb-1">Agent Name</p>
                      <p className="text-white font-semibold">{a2aManifest.name}</p>
                    </div>
                    <div>
                      <p className="text-gray-300 text-sm mb-1">Version</p>
                      <p className="text-white">{a2aManifest.version}</p>
                    </div>
                    <div className="md:col-span-2">
                      <p className="text-gray-300 text-sm mb-1">Description</p>
                      <p className="text-white">{a2aManifest.description}</p>
                    </div>
                    {a2aManifest.provider && (
                      <div>
                        <p className="text-gray-300 text-sm mb-1">Provider</p>
                        <p className="text-white">{a2aManifest.provider.organization}</p>
                      </div>
                    )}
                    {a2aManifest.documentationUrl && (
                      <div>
                        <p className="text-gray-300 text-sm mb-1">Documentation</p>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => window.open(a2aManifest.documentationUrl, '_blank')}
                          className="p-1 h-auto text-purple-300"
                        >
                          <ExternalLink className="w-4 h-4 mr-1" />
                          View Docs
                        </Button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Agent Capabilities */}
                {a2aManifest.capabilities && (
                  <div className="bg-black/20 rounded-lg p-4 border border-white/10">
                    <h3 className="text-lg font-semibold mb-4 flex items-center">
                      <Bolt className="w-5 h-5 mr-2" />
                      Capabilities
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      {a2aManifest.capabilities.streaming && (
                        <Badge className="bg-green-500/20 text-green-300">Streaming</Badge>
                      )}
                      {a2aManifest.capabilities.pushNotifications && (
                        <Badge className="bg-blue-500/20 text-blue-300">Push Notifications</Badge>
                      )}
                      {a2aManifest.capabilities.stateTransitionHistory && (
                        <Badge className="bg-purple-500/20 text-purple-300">State History</Badge>
                      )}
                    </div>
                  </div>
                )}

                {/* Agent Skills - Playing Card Style */}
                {a2aManifest.skills && a2aManifest.skills.length > 0 && (
                  <div className="bg-black/20 rounded-lg p-4 border border-white/10">
                    <h3 className="text-lg font-semibold mb-4 flex items-center">
                      <Brain className="w-5 h-5 mr-2" />
                      Skills ({a2aManifest.skills.length})
                    </h3>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                      {a2aManifest.skills.map((skill, index) => (
                        <div 
                          key={index} 
                          className="relative group cursor-pointer transform hover:scale-105 transition-all duration-300"
                          style={{
                            aspectRatio: '2/3',
                            background: 'linear-gradient(135deg, rgba(147, 51, 234, 0.1), rgba(196, 181, 253, 0.1))',
                            border: '2px solid rgba(147, 51, 234, 0.3)',
                            borderRadius: '12px',
                            boxShadow: '0 4px 20px rgba(147, 51, 234, 0.2)',
                            minWidth: '120px',
                            maxWidth: '160px'
                          }}
                        >
                          {/* Card Corner - Top Left */}
                          <div className="absolute top-2 left-2 text-xs font-bold">
                            <div className="text-purple-300 leading-none">S</div>
                          </div>
                          
                          {/* Card Corner - Bottom Right (upside down) */}
                          <div className="absolute bottom-2 right-2 text-xs font-bold rotate-180">
                            <div className="text-purple-300 leading-none">S</div>
                          </div>
                          
                          {/* Card Center Content */}
                          <div className="absolute inset-x-3 top-8 bottom-8 flex flex-col items-center justify-center text-center">
                            <div className="text-purple-300 mb-2">
                              <Brain className="w-6 h-6" />
                            </div>
                            <h4 className="font-bold text-sm mb-2 line-clamp-2 text-white">
                              {skill.name}
                            </h4>
                            <p className="text-gray-300 text-xs line-clamp-4 mb-2">
                              {skill.description}
                            </p>
                            {skill.tags && skill.tags.length > 0 && (
                              <div className="flex flex-wrap gap-1 justify-center">
                                {skill.tags.slice(0, 2).map((tag, tagIndex) => (
                                  <span key={tagIndex} className="text-purple-300 text-xs bg-purple-500/20 px-1 py-0.5 rounded">
                                    {tag}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                          
                          {/* Cyberpunk Glow Effect */}
                          <div className="absolute inset-0 rounded-lg bg-gradient-to-br from-transparent via-purple-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-all duration-500 pointer-events-none"></div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Input/Output Modes */}
                {(a2aManifest.defaultInputModes || a2aManifest.defaultOutputModes) && (
                  <div className="bg-black/20 rounded-lg p-4 border border-white/10">
                    <h3 className="text-lg font-semibold mb-3 flex items-center">
                      <Database className="w-5 h-5 mr-2" />
                      Data Modes
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {a2aManifest.defaultInputModes && (
                        <div>
                          <p className="text-gray-300 text-sm mb-2">Input Modes</p>
                          <div className="flex flex-wrap gap-2">
                            {a2aManifest.defaultInputModes.map((mode, index) => (
                              <Badge key={index} className="bg-blue-500/20 text-blue-300 text-xs">
                                {mode}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}
                      {a2aManifest.defaultOutputModes && (
                        <div>
                          <p className="text-gray-300 text-sm mb-2">Output Modes</p>
                          <div className="flex flex-wrap gap-2">
                            {a2aManifest.defaultOutputModes.map((mode, index) => (
                              <Badge key={index} className="bg-green-500/20 text-green-300 text-xs">
                                {mode}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* OAuth not required — still show preset setup guide (e.g. Draw.io) */}
            {service?.type === 'mcp' && oauthStatus.status === 'not_required' && apiService?.id && (
              <div className="bg-blue-500/20 border border-blue-500/30 rounded-lg p-4 mb-4">
                <h3 className="text-blue-300 font-semibold mb-2">How to connect</h3>
                <OAuthConnectPanel serviceId={apiService.id} />
              </div>
            )}

            {/* OAuth Status Warning - Show when OAuth is required, expired, or not authenticated */}
            {service?.type === 'mcp' && oauthStatus.status !== 'authenticated' && oauthStatus.status !== 'not_required' && (
              <div className={`${oauthStatus.status === 'expired' ? 'bg-red-500/20 border-red-500/30' : 'bg-orange-500/20 border-orange-500/30'} rounded-lg p-4 mb-4`}>
                <h3 className={`${oauthStatus.status === 'expired' ? 'text-red-300' : 'text-orange-300'} font-semibold mb-2`}>
                  {oauthStatus.status === 'expired' ? '⏰ Token Expired' : '🔐 Authentication Required'}
                </h3>
                <div className={`${oauthStatus.status === 'expired' ? 'text-red-200' : 'text-orange-200'} text-sm space-y-2`}>
                  <p><strong>{oauthStatus.message}</strong></p>
                  <p>{oauthStatus.status === 'expired' 
                    ? 'Your OAuth token has expired. Please re-authenticate to continue using this service.'
                    : 'This MCP server requires OAuth authentication to access its tools. Please authenticate to continue.'
                  }</p>
                  
                  {apiService?.id && (
                    <OAuthConnectPanel
                      serviceId={apiService.id}
                      onConnected={() => void refetchOAuthStatus()}
                    />
                  )}
                  
                  {mcpDiscoveryData?.data?.oauth?.resourceName && (
                    <div className="mt-3 p-2 bg-orange-500/10 rounded border border-orange-500/20 text-xs text-orange-100">
                      <p><strong>Resource:</strong> {mcpDiscoveryData.data.oauth.resourceName}</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Connection Logs - Show when trying to access MCP services */}
            {service?.type === 'mcp' && (
              <div className="bg-gray-800/50 border border-gray-600/30 rounded-lg p-4 mb-4">
                <h3 className="text-gray-300 font-semibold mb-2">Connection Logs</h3>
                <div className="text-gray-200 text-sm space-y-2">
                  <div className="bg-black/30 p-2 rounded text-xs">
                    <p><strong>🔍 Attempting to discover tools for MCP service:</strong></p>
                    <p>Service ID: {service?.id}</p>
                    <p>Service URL: {apiService?.url}</p>
                    <p>Status: {mcpToolsLoading ? '🔄 Loading...' : mcpToolsError ? '❌ Failed' : '✅ Complete'}</p>
                  </div>
                  
                  {mcpToolsLoading && (
                    <div className="bg-yellow-500/20 p-2 rounded text-xs">
                      <p>🔄 Making HTTP request to: <code>GET /api/services/{service?.id}/tools</code></p>
                      <p>Target MCP server: <code>{apiService?.url}</code></p>
                    </div>
                  )}
                  
                  {mcpToolsError && (
                    <div className="bg-red-500/20 p-2 rounded text-xs">
                      <p>❌ Request failed:</p>
                      <pre className="whitespace-pre-wrap overflow-x-auto">
                        {mcpToolsError instanceof Error ? mcpToolsError.message : String(mcpToolsError)}
                      </pre>
                      <div className="mt-2 p-2 bg-black/30 rounded">
                        <p><strong>🔍 What we tried:</strong></p>
                        <p>• Service ID: {service?.id}</p>
                        <p>• Target URL: {apiService?.url}</p>
                        <p>• Request: GET /api/services/{service?.id}/tools</p>
                        {hasCustomHeaders(activeHeaders) && (
                          <div>
                            <p><strong>📋 Headers sent:</strong></p>
                            <ul className="text-xs font-mono">
                              {maskedHeadersEntries(activeHeaders).map(({ name, masked }) => (
                                <li key={name}>{name}: {masked}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        <div className="mt-2">
                          <p><strong>💡 What this means:</strong></p>
                          <p>• The MCP server at {apiService?.url} returned an error</p>
                          <p>• This could be due to authentication issues, server being down, or invalid configuration</p>
                          <p>• Check the error message above for specific details from the MCP server</p>
                        </div>
                      </div>
                    </div>
                  )}
                  
                  {!mcpToolsLoading && !mcpToolsError && mcpTools.length > 0 && (
                    <div className="bg-green-500/20 p-2 rounded text-xs">
                      <p>✅ Successfully discovered {mcpTools.length} tools from MCP server</p>
                    </div>
                  )}
                  
                  {!mcpToolsLoading && !mcpToolsError && mcpTools.length === 0 && (
                    <div className="bg-yellow-500/20 p-2 rounded text-xs">
                      <p>⚠️ Connected to MCP server but no tools were found</p>
                      <p>This could mean the server has no tools or requires specific authentication</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Error Display */}
            {mcpToolsError && (service.type === 'mcp' || service.type === 'local-mcp') && (
              <div className="bg-red-500/20 border border-red-500/30 rounded-lg p-4">
                <h3 className="text-red-300 font-semibold mb-2">MCP Tool Discovery Failed</h3>
                <div className="text-red-200 text-sm space-y-2">
                  <p><strong>Raw Error:</strong></p>
                  <pre className="bg-black/30 p-2 rounded text-xs overflow-x-auto whitespace-pre-wrap">
                    {mcpToolsError instanceof Error ? mcpToolsError.message : String(mcpToolsError)}
                  </pre>
                  <p><strong>Service URL:</strong> {apiService?.url}</p>
                  <p><strong>Service ID:</strong> {apiService?.id}</p>
                  {hasCustomHeaders(activeHeaders) && (
                    <div>
                      <p><strong>Custom Headers:</strong></p>
                      <ul className="bg-black/30 p-2 rounded text-xs font-mono">
                        {maskedHeadersEntries(activeHeaders).map(({ name, masked }) => (
                          <li key={name}>{name}: {masked}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            )}

            {a2aManifestError && service.type === 'a2a' && (
              <div className="bg-red-500/20 border border-red-500/30 rounded-lg p-4">
                <h3 className="text-red-300 font-semibold mb-2">A2A Manifest Discovery Failed</h3>
                <div className="text-red-200 text-sm space-y-2">
                  <p><strong>Raw Error:</strong></p>
                  <pre className="bg-black/30 p-2 rounded text-xs overflow-x-auto whitespace-pre-wrap">
                    {a2aManifestError instanceof Error ? a2aManifestError.message : String(a2aManifestError)}
                  </pre>
                  <p><strong>Service URL:</strong> {apiService?.url}</p>
                  <p><strong>Service ID:</strong> {apiService?.id}</p>
                </div>
              </div>
            )}

            {/* No Tools/Details Available (Success but empty) */}
            {!isLoading && !mcpToolsError && !a2aManifestError && (service.type === 'mcp' || service.type === 'local-mcp') && mcpTools.length === 0 && (service.type === 'local-mcp' || !mcpDiscoveryData?.data?.oauth?.required) && (
              <div className="bg-yellow-500/20 border border-yellow-500/30 rounded-lg p-4">
                <h3 className="text-yellow-300 font-semibold mb-2">No Tools Available</h3>
                <p className="text-yellow-200 text-sm">
                  Successfully connected to MCP server at {apiService?.url}, but no tools were discovered.
                </p>
                <div className="text-yellow-200 text-xs mt-2">
                  <p><strong>This could mean:</strong></p>
                  <ul className="list-disc list-inside ml-2 space-y-1">
                    <li>The MCP server has no tools registered</li>
                    <li>Tools require specific authentication</li>
                    <li>Tools are only available after certain operations</li>
                  </ul>
                </div>
              </div>
            )}

            {/* MCP Discovery Information */}
            {(service.type === 'mcp' || service.type === 'local-mcp') && (
              <div className="bg-blue-500/20 border border-blue-500/30 rounded-lg p-4">
                <h3 className="text-blue-300 font-semibold mb-2">🔍 MCP Server Analysis</h3>
                <div className="text-blue-200 text-sm space-y-2">
                  <p><strong>Server URL:</strong> {apiService?.url}</p>
                  
                  {mcpDiscoveryLoading && (
                    <div className="mt-3 p-3 bg-black/30 rounded">
                      <p>🔍 Analyzing MCP server configuration...</p>
                    </div>
                  )}
                  
                  {/* Show analysis based on discovery data */}
                  {mcpDiscoveryData && (
                    <div className="mt-3 p-3 bg-black/30 rounded">
                      <p><strong>🔍 What we discovered:</strong></p>
                      
                      {mcpDiscoveryData.error && mcpDiscoveryData.analysis && (
                        <div className="text-yellow-200">
                          {mcpDiscoveryData.analysis.auth_type === 'oauth2' && (
                            <div>
                              <p>• <strong>OAuth 2.0 Authentication Required</strong></p>
                              <p>• This MCP server requires OAuth 2.0 Bearer token authentication</p>
                              <p>• You'll need to provide OAuth credentials (client ID, client secret, authorization URL, token URL)</p>
                              <p>• Check the service provider's documentation for OAuth setup instructions</p>
                            </div>
                          )}
                          
                          {mcpDiscoveryData.analysis.protocol === 'sse' && (
                            <div>
                              <p>• <strong>SSE Protocol Required</strong></p>
                              <p>• This MCP server uses Server-Sent Events (SSE) protocol</p>
                              <p>• We'll need to connect using event streaming instead of HTTP</p>
                            </div>
                          )}
                          
                          {mcpDiscoveryData.analysis.issue === 'not_found' && (
                            <div>
                              <p>• <strong>Server Not Found</strong></p>
                              <p>• The MCP server URL might be incorrect</p>
                              <p>• Check if the server is running and the URL is correct</p>
                            </div>
                          )}
                          
                          {mcpDiscoveryData.analysis.issue === 'server_error' && (
                            <div>
                              <p>• <strong>Server Error</strong></p>
                              <p>• The MCP server is experiencing internal errors</p>
                              <p>• Try again later or contact the service provider</p>
                            </div>
                          )}
                          
                          {mcpDiscoveryData.analysis.message && (
                            <p>• <strong>Analysis:</strong> {mcpDiscoveryData.analysis.message}</p>
                          )}
                        </div>
                      )}
                      
                      {mcpDiscoveryData?.data?.oauth?.required && (
                        <div className="text-yellow-200">
                          <p>• <strong>OAuth 2.0 Authentication Required</strong></p>
                          {mcpDiscoveryData.data.oauth.authorizationUrl && (
                            <div className="mt-2 flex items-center gap-2">
                              <Button
                                size="sm"
                                variant="default"
                                className="h-7"
                                onClick={async () => {
                                  if (!apiService?.id) return;
                                  
                                  try {
                                    toast({
                                      title: 'Setting up OAuth...',
                                      description: 'Automatically registering OAuth application and starting authorization flow...',
                                    });

                                    const resp = await apiRequest('POST', `/api/oauth/${apiService.id}/auto-setup`, {});
                                    if (!resp.ok) {
                                      const errorData = await resp.json();
                                      
                                      // Check if we have a registration URL to navigate to
                                      if (errorData.data?.registrationUrl) {
                                        // Open the registration page
                                        window.open(errorData.data.registrationUrl, '_blank');
                                        
                                        toast({
                                          title: 'OAuth Registration Required',
                                          description: `${errorData.error} I've opened the registration page for you. Please create an OAuth app and then come back to add your credentials.`,
                                          duration: 15000,
                                        });
                                      } else {
                                        toast({
                                          title: 'OAuth Setup Failed',
                                          description: errorData.error || 'Failed to setup OAuth automatically. Please configure manually.',
                                          variant: 'destructive',
                                        });
                                      }
                                      return;
                                    }

                                    const data = await resp.json();
                                    if (data.success && data.data?.authorizationUrl) {
                                      // Open the authorization URL
                                      window.open(data.data.authorizationUrl, '_blank');
                                      
                                      toast({
                                        title: 'OAuth Setup Successful',
                                        description: 'OAuth application registered automatically! Please complete the authorization in the new window.',
                                        duration: 10000,
                                      });
                                      
                                      // Start polling for OAuth completion
                                      void refetchOAuthStatus();
                                    } else {
                                      toast({
                                        title: 'OAuth Setup Failed',
                                        description: 'Failed to get authorization URL. Please try again.',
                                        variant: 'destructive',
                                      });
                                    }
                                  } catch (error) {
                                    toast({
                                      title: 'OAuth Setup Failed',
                                      description: error instanceof Error ? error.message : 'Unknown error occurred',
                                      variant: 'destructive',
                                    });
                                  }
                                }}
                              >
                                🔧 Auto-Setup OAuth
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="p-1 h-auto text-blue-300"
                                onClick={() => window.open(mcpDiscoveryData.data.oauth.authorizationUrl, '_blank')}
                              >
                                <ExternalLink className="w-4 h-4 mr-1" />
                                Open Raw Authorization URL
                              </Button>
                            </div>
                          )}
                          {!mcpDiscoveryData.data.oauth.authorizationUrl && mcpDiscoveryData.data.oauth.protectedResourceConfigUrl && (
                            <div className="mt-2">
                              <Button
                                size="sm"
                                variant="ghost"
                                className="p-1 h-auto text-blue-300"
                                onClick={() => window.open(mcpDiscoveryData.data.oauth.protectedResourceConfigUrl, '_blank')}
                              >
                                <ExternalLink className="w-4 h-4 mr-1" />
                                View OAuth Configuration
                              </Button>
                            </div>
                          )}
                          {mcpDiscoveryData.data.oauth.authorizationServerMetadataUrl && (
                            <div className="mt-2 text-xs text-gray-300">
                              <span className="mr-1">Auth Server Metadata:</span>
                              <button
                                className="underline text-blue-300"
                                onClick={() => window.open(mcpDiscoveryData.data.oauth.authorizationServerMetadataUrl, '_blank')}
                              >
                                {mcpDiscoveryData.data.oauth.authorizationServerMetadataUrl}
                              </button>
                            </div>
                          )}
                        </div>
                      )}

                      {mcpDiscoveryData?.success && !mcpDiscoveryData?.data?.oauth?.required && (
                        <div className="text-green-200">
                          <p>• <strong>✅ Server Analysis Complete</strong></p>
                          <p>• MCP server is accessible and responding</p>
                          <p>• No authentication issues detected</p>
                          <p>• Protocol compatibility confirmed</p>
                        </div>
                      )}
                      
                      {mcpDiscoveryData?.data?.oauth?.required && (
                        <div className="text-orange-200">
                          <p>• <strong>🔐 OAuth 2.0 Authentication Required</strong></p>
                          <p>• This MCP server requires OAuth authentication</p>
                          {mcpDiscoveryData.data.oauth.resourceName && (
                            <p>• Service: {mcpDiscoveryData.data.oauth.resourceName}</p>
                          )}
                          {mcpDiscoveryData.data.oauth.authorizationUrl && (
                            <p>• Authorization URL: {mcpDiscoveryData.data.oauth.authorizationUrl}</p>
                          )}
                          {mcpDiscoveryData.data.oauth.tokenUrl && (
                            <p>• Token URL: {mcpDiscoveryData.data.oauth.tokenUrl}</p>
                          )}
                          
                          {/* OAuth Configuration Button */}
                          <div className="mt-3 flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant="default"
                              className="bg-orange-600 hover:bg-orange-700"
                              onClick={async () => {
                                if (!apiService?.id) return;
                                
                                try {
                                  toast({
                                    title: 'Setting up OAuth...',
                                    description: 'Automatically registering OAuth application and starting authorization flow...',
                                  });

                                  const resp = await apiRequest('POST', `/api/oauth/${apiService.id}/auto-setup`, {});
                                  if (!resp.ok) {
                                    const errorData = await resp.json();
                                    
                                    // Check if we have a registration URL to navigate to
                                    if (errorData.data?.registrationUrl) {
                                      // Open the registration page
                                      window.open(errorData.data.registrationUrl, '_blank');
                                      
                                      toast({
                                        title: 'OAuth Registration Required',
                                        description: `${errorData.error} I've opened the registration page for you. Please create an OAuth app and then come back to add your credentials.`,
                                        duration: 15000,
                                      });
                                    } else {
                                      toast({
                                        title: 'OAuth Setup Failed',
                                        description: errorData.error || 'Failed to setup OAuth automatically. Please configure manually.',
                                        variant: 'destructive',
                                      });
                                    }
                                    return;
                                  }

                                  const data = await resp.json();
                                  if (data.success && data.data?.authorizationUrl) {
                                    // Open the authorization URL
                                    window.open(data.data.authorizationUrl, '_blank');
                                    
                                    toast({
                                      title: 'OAuth Setup Successful',
                                      description: 'OAuth application registered automatically! Please complete the authorization in the new window.',
                                      duration: 10000,
                                    });
                                    
                                    // Start polling for OAuth completion
                                    void refetchOAuthStatus();
                                  } else {
                                    toast({
                                      title: 'OAuth Setup Failed',
                                      description: 'Failed to get authorization URL. Please try again.',
                                      variant: 'destructive',
                                    });
                                  }
                                } catch (error) {
                                  toast({
                                    title: 'OAuth Setup Failed',
                                    description: error instanceof Error ? error.message : 'Unknown error occurred',
                                    variant: 'destructive',
                                  });
                                }
                              }}
                            >
                              🔧 Auto-Setup OAuth
                            </Button>
                            
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-orange-500/30 text-orange-300 hover:bg-orange-500/10"
                              onClick={() => {
                                // Show generic OAuth setup instructions
                                const instructions = `OAuth Setup Instructions:

1. Go to the service provider's OAuth/Developer settings
2. Create a new OAuth application
3. Set Redirect URL: http://localhost:8000/api/oauth/${apiService?.id}/callback
4. Copy the Client ID and Client Secret
5. Edit this service and add the credentials

${mcpDiscoveryData.data.oauth.authorizationUrl ? `Authorization URL: ${mcpDiscoveryData.data.oauth.authorizationUrl}` : ''}
${mcpDiscoveryData.data.oauth.tokenUrl ? `Token URL: ${mcpDiscoveryData.data.oauth.tokenUrl}` : ''}
${mcpDiscoveryData.data.oauth.issuer ? `Issuer: ${mcpDiscoveryData.data.oauth.issuer}` : ''}`;

                                toast({
                                  title: 'OAuth Setup Instructions',
                                  description: instructions,
                                  duration: 10000, // Show for 10 seconds
                                });
                              }}
                            >
                              📋 Setup Instructions
                            </Button>
                          </div>
                        </div>
                      )}
                      
                      <div className="mt-2 text-xs">
                        <p><strong>💡 Next Steps:</strong></p>
                        <ul className="list-disc list-inside ml-2 space-y-1">
                          <li>For OAuth servers: Provide OAuth credentials in service settings</li>
                          <li>For SSE servers: We'll automatically use the correct protocol</li>
                          <li>For connection issues: Verify the server URL and status</li>
                        </ul>
                      </div>
                    </div>
                  )}
                  
                  {mcpDiscoveryError && (
                    <div className="mt-3 p-3 bg-red-500/20 rounded">
                      <p><strong>❌ Discovery Failed</strong></p>
                      <p>Could not analyze MCP server configuration</p>
                      <pre className="text-xs overflow-x-auto">
                        {mcpDiscoveryError instanceof Error ? mcpDiscoveryError.message : String(mcpDiscoveryError)}
                      </pre>
                    </div>
                  )}
                </div>
              </div>
            )}

            {!isLoading && !mcpToolsError && !a2aManifestError && service.type === 'a2a' && !a2aManifest && (
              <div className="bg-yellow-500/20 border border-yellow-500/30 rounded-lg p-4">
                <h3 className="text-yellow-300 font-semibold mb-2">Agent Details Not Available</h3>
                <p className="text-yellow-200 text-sm">
                  Successfully connected to A2A agent at {apiService?.url}, but no manifest was found.
                </p>
                <div className="text-yellow-200 text-xs mt-2">
                  <p><strong>This could mean:</strong></p>
                  <ul className="list-disc list-inside ml-2 space-y-1">
                    <li>The agent doesn't provide a manifest</li>
                    <li>Manifest endpoint is not implemented</li>
                    <li>Agent requires specific authentication</li>
                  </ul>
                </div>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
