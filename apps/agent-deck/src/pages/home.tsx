import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Service, Deck, Credential, Playbook } from "@agent-deck/shared";
import {
  toCollectionWarningsView,
  type CollectionWarningsPayload,
} from "@/lib/collection-warnings";
import CardComponent from "@/components/card-component";
import CredentialCardComponent from "@/components/credential-card-component";
import PlaybookCardComponent from "@/components/playbook-card-component";
import DeckBuilder from "@/components/deck-builder";
import LiveSessionBadges from "@/components/live-session-badges";
import ServiceRegistrationModal from "@/components/service-registration-modal";
import DeckManagementPanel from "@/components/deck-management-panel";
import CredentialRegistrationModal from "@/components/credential-registration-modal";
import PlaybookRegistrationModal from "@/components/playbook-registration-modal";
import PlaybookDetailsModal from "@/components/playbook-details-modal";
import CredentialDetailsModal from "@/components/credential-details-modal";
import ServiceDetailsModal from "@/components/service-details-modal";
import ImportBundleModal from "@/components/import-bundle-modal";
import McpToolsPanel from "@/components/mcp-tools-panel";
import { useWebSocket } from "@/hooks/use-websocket";
import { useDragAndDrop } from "@/hooks/use-drag-and-drop";
import { useEditingDeck } from "@/hooks/use-editing-deck";
import { MCP_CARD_COLOR, API_KEY_CARD_COLOR, PLAYBOOK_CARD_COLOR, CARD_FACE_CLASS, cardAccentStyle } from "@/lib/card-colors";
import { downloadBundleJson, exportBundle } from "@/lib/export-import";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Search, Settings, Layers, Bolt, Server, KeyRound, BookOpen, Copy, Plus, Filter, AlertTriangle, LayoutGrid, Download, Upload, GitPullRequest } from "lucide-react";
import { Link } from "wouter";
import { listPlaybookPatches } from "@/lib/playbook-patches";
import { getFeedbackSignalCount } from "@/lib/feedback-signals";
import { isDashboardAuthError } from "@/lib/queryClient";
import AgentDeckLogo from "@/assets/AgentDeckLogo3.png";
import { useToast } from "@/hooks/use-toast";

export default function Home() {
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [warningsOnlyFilter, setWarningsOnlyFilter] = useState(false);
  const [mcpModalOpen, setMcpModalOpen] = useState(false);
  const [selectedService, setSelectedService] = useState<Service | null>(null);
  const [serviceDetailsModalOpen, setServiceDetailsModalOpen] = useState(false);
  const [credentialModalOpen, setCredentialModalOpen] = useState(false);
  const [selectedCredentialId, setSelectedCredentialId] = useState<string | null>(null);
  const [credentialDetailsOpen, setCredentialDetailsOpen] = useState(false);
  const [playbookModalOpen, setPlaybookModalOpen] = useState(false);
  const [selectedPlaybookId, setSelectedPlaybookId] = useState<string | null>(null);
  const [playbookDetailsOpen, setPlaybookDetailsOpen] = useState(false);
  const [importBundleOpen, setImportBundleOpen] = useState(false);
  const [exportingAll, setExportingAll] = useState(false);
  const [hoveredCardId, setHoveredCardId] = useState<string | null>(null);
  
  const { toast } = useToast();

  const { data: proposedPatches = [] } = useQuery({
    queryKey: ["/api/playbook-patches", "proposed"],
    queryFn: () => listPlaybookPatches("proposed"),
  });

  const { data: openSignalCount = 0 } = useQuery({
    queryKey: ["/api/feedback-signals/count", "available"],
    queryFn: () => getFeedbackSignalCount(),
  });

  const handleExportAll = async () => {
    setExportingAll(true);
    try {
      const bundle = await exportBundle({ scope: "collection" });
      downloadBundleJson(bundle, "backup.agent-deck.json");
      toast({
        title: "Exported collection",
        description: `${bundle.services.length} services, ${bundle.playbooks.length} playbooks, ${bundle.decks.length} decks`,
      });
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setExportingAll(false);
    }
  };
  
  // WebSocket connection for real-time updates
  const { connectionStatus } = useWebSocket();
  
  // Fetch decks
  const { data: decksResponse, isLoading: decksLoading, error: decksError } = useQuery<{success: boolean, data: Deck[]}>({
    queryKey: ['/api/decks'],
  });

  const decksArray = decksResponse?.data || [];
  const { editingDeck, editingDeckId, setEditingDeckId } = useEditingDeck(decksArray);

  const {
    handleDragStart,
    handleCredentialDragStart,
    handlePlaybookDragStart,
    handleDragEnd,
    handleDrop,
    handleGlobalDrop,
    isDraggingFromDeck,
  } = useDragAndDrop(editingDeckId);

  // Fetch services
  const { data: servicesResponse, isLoading: servicesLoading, error: servicesError } = useQuery<{success: boolean, data: Service[]}>({
    queryKey: ['/api/services'],
  });

  // Fetch credentials (API keys)
  const { data: credentialsResponse, isLoading: credentialsLoading } = useQuery<{ success: boolean; data: Credential[] }>({
    queryKey: ["/api/credentials/vault"],
  });

  const { data: playbooksResponse, isLoading: playbooksLoading } = useQuery<{ success: boolean; data: Playbook[] }>({
    queryKey: ["/api/playbooks/vault"],
  });

  const { data: collectionWarningsResponse } = useQuery<{ success: boolean; data: CollectionWarningsPayload }>({
    queryKey: ["/api/collection/warnings"],
    staleTime: 60_000,
  });

  const servicesArray = servicesResponse?.data || [];
  const credentialsArray = credentialsResponse?.data || [];
  const playbooksArray = playbooksResponse?.data || [];

  const collectionWarnings = useMemo(
    () => toCollectionWarningsView(collectionWarningsResponse?.data),
    [collectionWarningsResponse?.data],
  );

  const matchesWarningsFilter = (
    cardType: "service" | "credential" | "playbook",
    id: string,
  ) => {
    if (!warningsOnlyFilter) {
      return true;
    }
    if (cardType === "service") {
      return collectionWarnings.serviceWarnings.has(id);
    }
    if (cardType === "credential") {
      return collectionWarnings.credentialWarnings.has(id);
    }
    return collectionWarnings.playbookWarnings.has(id);
  };

  // Filter services based on search and filters
  const filteredServices = servicesArray.filter(service => {
    if (!matchesWarningsFilter("service", service.id)) return false;
    if (typeFilter === 'api-key' || typeFilter === 'playbook') return false;

    const matchesSearch = service.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         service.description?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesType = !typeFilter || typeFilter === 'all' || service.type === typeFilter;
    
    return matchesSearch && matchesType;
  });

  const filteredCredentials = credentialsArray.filter(credential => {
    if (!matchesWarningsFilter("credential", credential.id)) return false;
    if (typeFilter && typeFilter !== 'all' && typeFilter !== 'api-key') return false;

    const matchesSearch = credential.label.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesSearch;
  });

  const filteredPlaybooks = playbooksArray.filter((playbook) => {
    if (!matchesWarningsFilter("playbook", playbook.id)) return false;
    if (typeFilter && typeFilter !== 'all' && typeFilter !== 'playbook') return false;

    const matchesSearch =
      playbook.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      playbook.body.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesSearch;
  });

  const collectionCount =
    filteredServices.length + filteredCredentials.length + filteredPlaybooks.length;

  if (servicesError) console.error('Services error:', servicesError);
  if (decksError) console.error('Decks error:', decksError);

  const clearCollectionFilters = () => {
    setSearchQuery("");
    setTypeFilter("");
    setWarningsOnlyFilter(false);
  };

  const hasActiveCollectionFilters = Boolean(searchQuery || typeFilter || warningsOnlyFilter);
  const editingDeckCredentialIds = new Set((editingDeck?.credentials ?? []).map((c) => c.id));
  const editingDeckPlaybookIds = new Set((editingDeck?.playbooks ?? []).map((p) => p.id));
  const editingDeckServices = editingDeck?.services || [];
  const editingDeckPlaybooks = editingDeck?.playbooks || [];

  // Handle card click to show service details
  const handleCardClick = (service: Service) => {
    setSelectedService(service);
    setServiceDetailsModalOpen(true);
  };

  const handlePlaybookClick = (playbook: Playbook) => {
    setSelectedPlaybookId(playbook.id);
    setPlaybookDetailsOpen(true);
  };

  const handleCredentialClick = (credential: Credential) => {
    setSelectedCredentialId(credential.id);
    setCredentialDetailsOpen(true);
  };

  const handleCardHover = (cardId: string | null) => {
    setHoveredCardId(cardId);
  };

  const hasFatalError = servicesError || decksError;
  
  if (hasFatalError) {
    const dashboardAccessExpired =
      isDashboardAuthError(decksError) || isDashboardAuthError(servicesError);
    const errorMessage =
      (decksError instanceof Error ? decksError.message : null) ??
      (servicesError instanceof Error ? servicesError.message : null) ??
      "There was an error loading the application data.";

    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900">
        <div className="text-center max-w-lg px-4">
          <h2 className="text-2xl font-bold text-red-400 mb-4">
            {dashboardAccessExpired ? "Dashboard Access Expired" : "Error Loading Data"}
          </h2>
          {dashboardAccessExpired ? (
            <>
              <p className="text-gray-300 mb-2">Dashboard access has expired.</p>
              <p className="text-gray-400 text-sm mb-4">
                Reopen it securely from your terminal or the Agent Deck menubar.
              </p>
              <code className="mb-6 block rounded bg-black/30 px-3 py-2 text-gray-200">
                agent-deck open
              </code>
              <button
                onClick={() => {
                  void navigator.clipboard.writeText("agent-deck open").then(() => {
                    toast({ title: "Command copied", description: "Run it in your terminal." });
                  });
                }}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                Copy Command
              </button>
            </>
          ) : (
            <>
              <p className="text-gray-300 mb-2">There was an error loading the application data.</p>
              <p className="text-gray-400 text-sm mb-4">{errorMessage}</p>
              <p className="text-gray-500 text-xs mb-6">
                Is the API running? Try <code className="text-gray-300">agent-deck stop &amp;&amp; agent-deck start</code>
              </p>
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                Reload Page
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  // Add loading state
  if (servicesLoading || decksLoading || credentialsLoading || playbooksLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-yellow-400 mx-auto mb-4"></div>
          <p className="text-gray-300">Loading AgentDeck...</p>
        </div>
      </div>
    );
  }

  return (
    <div 
      className="flex min-h-dvh flex-col overflow-x-hidden"
      onDrop={handleGlobalDrop}
      onDragOver={(e) => e.preventDefault()}
      style={{
        position: 'relative',
        ...(isDraggingFromDeck && {
          background: 'linear-gradient(to bottom right, #1a1a2e, #16213e, #0f3460)',
        })
      }}
    >
      {/* Header */}
      <header className="relative z-20 shrink-0 bg-black/30 backdrop-blur-md border-b border-white/10">
        <div className="container mx-auto px-4 py-3 sm:py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3 sm:gap-4">
              <img
                src={AgentDeckLogo}
                alt="Agent Deck Logo"
                className="h-12 w-12 shrink-0 object-contain sm:h-16 sm:w-16"
              />
              <div className="min-w-0">
                <h1 className="text-xl font-bold bg-gradient-to-r from-yellow-400 to-yellow-600 bg-clip-text text-transparent sm:text-2xl" style={{background: 'linear-gradient(to right, #C4B643, #D4C760)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text'}}>
                  AgentDeck
                </h1>
                <p className="text-xs sm:text-sm" style={{color: '#92E4DD'}}>Build tool deck for your agent</p>
              </div>
            </div>
            
            <div className="flex flex-wrap items-center gap-3 sm:gap-6">
              {/* Connection Status */}
              <div className={`flex items-center space-x-2 px-3 py-1 rounded-full border ${
                connectionStatus === 'connected' 
                  ? 'bg-emerald-500/20 border-emerald-500/30' 
                  : 'bg-red-500/20 border-red-500/30'
              }`}>
                <div className={`w-2 h-2 rounded-full animate-pulse ${
                  connectionStatus === 'connected' ? 'bg-emerald-400' : 'bg-red-400'
                }`}></div>
                <button 
                  className={`text-sm hover:underline cursor-pointer ${
                    connectionStatus === 'connected' ? 'text-emerald-300' : 'text-red-300'
                  }`} 
                  data-testid="button-copy-mcp-url"
                  onClick={() => {
                    const mcpUrl = 'http://localhost:3001/mcp';
                    navigator.clipboard.writeText(mcpUrl).then(() => {
                      toast({
                        title: "MCP URL copied!",
                        description: "The MCP server URL has been copied to your clipboard.",
                      });
                    });
                  }}
                  title="Click to copy MCP URL"
                >
                  Get MCP URL
                </button>
              </div>
              
              {/* Live MCP sessions (replaces editing-deck name/cards chip) */}
              <LiveSessionBadges highlightDeckId={editingDeckId ?? undefined} />

              <Link href="/feedback-signals">
                <Button variant="outline" size="sm" className="relative border-white/20 bg-white/5 text-[#E8F6F4]">
                  Feedback
                  {openSignalCount > 0 && (
                    <span
                      className="ml-2 rounded-full px-2 py-0.5 text-xs font-semibold"
                      style={{ background: "#C4B643", color: "#0A0A07" }}
                      title="Open feedback available for curation"
                    >
                      {openSignalCount}
                    </span>
                  )}
                </Button>
              </Link>

              <Link href="/playbook-patches">
                <Button variant="outline" size="sm" className="relative border-white/20 bg-white/5 text-[#E8F6F4]">
                  <GitPullRequest className="mr-2 h-4 w-4" />
                  Review
                  {proposedPatches.length > 0 && (
                    <span
                      className="ml-2 rounded-full px-2 py-0.5 text-xs font-semibold"
                      style={{ background: "#C4B643", color: "#0A0A07" }}
                      title="Proposed playbook patches"
                    >
                      {proposedPatches.length}
                    </span>
                  )}
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* Global Drop Zone Indicator */}
      {isDraggingFromDeck && (
        <div className="fixed inset-0 pointer-events-none z-50 flex items-center justify-center">
          <div className="bg-red-500/20 border-2 border-dashed border-red-500/50 rounded-lg p-8 text-center">
            <div className="text-red-400 text-lg font-bold mb-2">Drop to Remove</div>
            <div className="text-red-300 text-sm">Release to remove card from deck</div>
          </div>
        </div>
      )}

      <main className="container mx-auto flex min-h-0 flex-1 flex-col px-4 py-4 sm:py-6">
        {/*
          Narrow / portrait: page scrolls (no h-screen trap).
          xl+: fill remaining viewport height; collection scrolls inside its panel.
        */}
        <div className="grid min-w-0 grid-cols-1 gap-4 sm:gap-6 xl:min-h-0 xl:flex-1 xl:grid-cols-4 xl:overflow-hidden">
          
          {/* Left Sidebar - 25% width */}
          <div className="min-w-0 space-y-4 sm:space-y-6 xl:col-span-1 xl:min-h-0 xl:overflow-y-auto">
            {/* My Decks */}
            <div className="panel-surface h-64 overflow-hidden p-4 min-w-0 sm:h-72 xl:h-80">
              <DeckManagementPanel
                decks={decksArray}
                editingDeckId={editingDeckId}
                onSelectDeck={setEditingDeckId}
                isLoading={decksLoading}
              />
            </div>
            
            {/* Add Cards */}
            <div className="panel-surface p-4">
              <h2 className="text-lg font-bold mb-3 flex items-center">
                <Bolt className="w-4 h-4 mr-2" style={{ color: "#92E4DD" }} />
                <span style={{ color: "#92E4DD" }}>Add Cards</span>
              </h2>
              
              <div className="space-y-2">
                <Button 
                  variant="ghost"
                  className={`w-full border-2 text-sm py-2 hover:opacity-90 ${CARD_FACE_CLASS}`}
                  style={cardAccentStyle(MCP_CARD_COLOR)}
                  onClick={() => setMcpModalOpen(true)}
                  data-testid="button-register-mcp"
                >
                  <Server className="w-3 h-3 mr-2" />
                  Register MCP
                </Button>
                
                <Button 
                  variant="ghost"
                  className={`w-full border-2 text-sm py-2 hover:opacity-90 ${CARD_FACE_CLASS}`}
                  style={cardAccentStyle(API_KEY_CARD_COLOR)}
                  onClick={() => setCredentialModalOpen(true)}
                  data-testid="button-register-api-key"
                >
                  <KeyRound className="w-3 h-3 mr-2" />
                  Register API key
                </Button>

                <Button 
                  variant="ghost"
                  className={`w-full border-2 text-sm py-2 hover:opacity-90 ${CARD_FACE_CLASS}`}
                  style={cardAccentStyle(PLAYBOOK_CARD_COLOR)}
                  onClick={() => setPlaybookModalOpen(true)}
                  data-testid="button-register-playbook"
                >
                  <BookOpen className="w-3 h-3 mr-2" />
                  Register Playbook
                </Button>
              </div>
            </div>
          </div>
          
          {/* Main Content - 75% width */}
          <div className="flex min-w-0 flex-col gap-4 sm:gap-6 xl:col-span-3 xl:h-full xl:min-h-0">
            {/* Deck editor */}
            <div className="panel-surface h-64 shrink-0 overflow-hidden p-4 min-w-0 sm:h-72 xl:h-80">
              {editingDeck ? (
                <div className="h-full">
                  <DeckBuilder
                    deck={editingDeck}
                    services={editingDeckServices}
                    credentials={editingDeck.credentials ?? []}
                    playbooks={editingDeckPlaybooks}
                    allServices={servicesArray}
                    collectionWarnings={collectionWarnings}
                    onDrop={handleDrop}
                    onDragStart={handleDragStart}
                    onCredentialDragStart={handleCredentialDragStart}
                    onPlaybookDragStart={handlePlaybookDragStart}
                    onDragEnd={handleDragEnd}
                    onCardClick={handleCardClick}
                    onPlaybookClick={handlePlaybookClick}
                    onCredentialClick={handleCredentialClick}
                  />
                </div>
              ) : (
                <div className="text-center h-full flex flex-col justify-center">
                  <div className="w-12 h-12 rounded-full bg-yellow-500/20 border border-yellow-500/30 flex items-center justify-center mx-auto mb-3">
                    <Layers className="w-6 h-6 text-yellow-400" />
                  </div>
                  <h3 className="text-lg font-bold mb-2" style={{color: '#92E4DD'}}>
                    No deck selected
                  </h3>
                  <p className="text-gray-300 mb-4 text-sm">
                    Create a deck or select one from the sidebar to edit its cards.
                  </p>
                  <div className="flex flex-col gap-2">
                    <Button 
                      onClick={() => {
                        const createButton = document.querySelector('[data-testid="create-deck-button"]') as HTMLButtonElement;
                        if (createButton) createButton.click();
                      }}
                      className="border text-sm py-2"
                      style={{
                        background: '#C4B643',
                        borderColor: '#C4B643',
                        color: 'black'
                      }}
                    >
                      <Plus className="w-4 h-4 mr-2" />
                      Create New Deck
                    </Button>
                    <Button 
                      variant="outline"
                      className="border-white/20 text-white hover:bg-white/10 text-sm py-2"
                      onClick={() => {
                        const deckPanel = document.querySelector('[data-testid="deck-management-panel"]');
                        if (deckPanel) deckPanel.scrollIntoView({ behavior: 'smooth' });
                      }}
                    >
                      <Layers className="w-4 h-4 mr-2" />
                      Manage Decks
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {/* My Collection */}
            <div
              className="panel-surface flex min-h-[20rem] flex-col overflow-hidden p-4 min-w-0 sm:min-h-[24rem] xl:min-h-0 xl:flex-1"
              data-testid="collection-panel"
            >
              <div className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-bold flex items-center">
                  <LayoutGrid className="w-4 h-4 mr-2" style={{ color: "#92E4DD" }} />
                  <span style={{ color: "#92E4DD" }}>My Collection</span>
                  <span className="ml-3 text-sm font-normal text-gray-400">
                    ({collectionCount} cards)
                  </span>
                </h2>
                
                {/* Search and Filter Controls */}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 px-2 text-xs border-white/20 text-white hover:bg-white/10"
                    onClick={handleExportAll}
                    disabled={exportingAll}
                    title="Export all MCP, playbooks, and decks"
                    data-testid="button-export-all"
                  >
                    <Download className="w-3 h-3 mr-1" />
                    {exportingAll ? "Exporting…" : "Export all"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 px-2 text-xs border-white/20 text-white hover:bg-white/10"
                    onClick={() => setImportBundleOpen(true)}
                    title="Import a bundle file"
                    data-testid="button-import-bundle"
                  >
                    <Upload className="w-3 h-3 mr-1" />
                    Import
                  </Button>
                  {/* Search Input */}
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
                    <Input
                      placeholder="Search..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="h-8 w-36 pl-8 text-sm bg-white/10 border-white/20 text-white placeholder-gray-400 sm:w-48"
                      data-testid="input-search"
                    />
                  </div>
                  
                  {/* Type Filter */}
                  <Select value={typeFilter || "all"} onValueChange={(v) => setTypeFilter(v === "all" ? "" : v)}>
                    <SelectTrigger className="w-[7.5rem] h-8 bg-white/10 border-white/20 text-white text-xs shrink-0" data-testid="select-type">
                      <Filter className="w-3 h-3 mr-1 shrink-0" />
                      <SelectValue placeholder="Type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All</SelectItem>
                      <SelectItem value="mcp">MCP</SelectItem>
                      <SelectItem value="local-mcp">Local MCP</SelectItem>
                      <SelectItem value="api-key">API Key</SelectItem>
                      <SelectItem value="playbook">Playbook</SelectItem>
                    </SelectContent>
                  </Select>
                  
                  {(searchQuery || typeFilter || warningsOnlyFilter) && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 px-2 text-xs border-white/20 text-white hover:bg-white/10"
                      onClick={clearCollectionFilters}
                      title="Clear all filters"
                    >
                      Clear
                    </Button>
                  )}
                </div>
              </div>

              {collectionWarnings.total > 0 && (
                <button
                  type="button"
                  onClick={() => setWarningsOnlyFilter((active) => !active)}
                  className={`mb-3 w-full shrink-0 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                    warningsOnlyFilter
                      ? "border-amber-300/60 bg-amber-500/15 text-amber-100"
                      : "border-amber-400/30 bg-amber-500/10 text-amber-100 hover:bg-amber-500/15"
                  }`}
                  data-testid="button-collection-warnings"
                >
                  <span className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                    <span>
                      {warningsOnlyFilter ? (
                        <>
                          Showing <strong>{collectionCount}</strong> card
                          {collectionCount === 1 ? "" : "s"} needing attention.
                          <span className="text-amber-200/80"> Click to show all cards.</span>
                        </>
                      ) : (
                        <>
                          <strong>{collectionWarnings.total}</strong> card
                          {collectionWarnings.total === 1 ? "" : "s"} need attention
                          {collectionWarnings.byKind.oauth_expired +
                            collectionWarnings.byKind.oauth_required >
                            0 && (
                            <>
                              {" "}
                              (
                              {collectionWarnings.byKind.oauth_expired +
                                collectionWarnings.byKind.oauth_required}{" "}
                              OAuth)
                            </>
                          )}
                          . <span className="text-amber-200/80">Click to filter.</span>
                        </>
                      )}
                    </span>
                  </span>
                </button>
              )}

              <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-1 py-2">
              {servicesLoading || credentialsLoading || playbooksLoading ? (
                <div className="grid grid-cols-[repeat(auto-fill,5rem)] gap-y-2 pr-12">
                  {Array.from({ length: 10 }).map((_, i) => (
                    <div key={i} className="animate-pulse">
                      <div className="bg-white/10 rounded-lg w-32 h-48 aspect-[2/3]"></div>
                    </div>
                  ))}
                </div>
              ) : collectionCount === 0 ? (
                <div className="text-center py-12">
                  <div className="text-gray-400 mb-4">
                    <i className="fas fa-layer-group text-4xl"></i>
                  </div>
                  <h3 className="text-lg font-semibold text-gray-300 mb-2">No cards yet</h3>
                  <p className="text-gray-400 text-sm mb-4">
                    {hasActiveCollectionFilters
                      ? warningsOnlyFilter
                        ? "No cards with warnings match your current filters"
                        : "Try adjusting your search or filters"
                      : "Register an MCP server, API key, or playbook to get started"
                    }
                  </p>
                  {!hasActiveCollectionFilters && (
                    <div className="flex gap-3 justify-center">
                      <Button 
                        variant="ghost"
                        size="sm"
                        className={`border-2 hover:opacity-90 ${CARD_FACE_CLASS}`}
                        style={cardAccentStyle(MCP_CARD_COLOR)}
                        onClick={() => setMcpModalOpen(true)}
                        data-testid="button-register-mcp-empty"
                      >
                        <Server className="w-3 h-3 mr-1" />
                        Register MCP
                      </Button>
                      <Button 
                        variant="ghost"
                        size="sm"
                        className={`border-2 hover:opacity-90 ${CARD_FACE_CLASS}`}
                        style={cardAccentStyle(API_KEY_CARD_COLOR)}
                        onClick={() => setCredentialModalOpen(true)}
                        data-testid="button-register-api-key-empty"
                      >
                        <KeyRound className="w-3 h-3 mr-1" />
                        Register API key
                      </Button>
                    </div>
                  )}
                </div>
              ) : (
                <div
                  className="relative isolate grid grid-cols-[repeat(auto-fill,5rem)] gap-y-2 pr-12"
                  style={{ isolation: "isolate" }}
                  data-testid="collection-card-grid"
                >
                  {filteredPlaybooks.map((playbook, index) => (
                    <div
                      key={playbook.id}
                      className="relative group"
                      style={{
                        zIndex: hoveredCardId === playbook.id ? 999999 : collectionCount - index,
                      }}
                    >
                      <PlaybookCardComponent
                        playbook={playbook}
                        isInActiveDeck={editingDeckPlaybookIds.has(playbook.id)}
                        activeDeck={editingDeck ?? undefined}
                        isInCollection
                        onDragStart={handlePlaybookDragStart}
                        onDragEnd={handleDragEnd}
                        onCardClick={handlePlaybookClick}
                        onMouseEnter={() => handleCardHover(playbook.id)}
                        onMouseLeave={() => handleCardHover(null)}
                        warnings={collectionWarnings.playbookWarnings.get(playbook.id)}
                      />
                    </div>
                  ))}
                  {filteredCredentials.map((credential, index) => (
                    <div
                      key={credential.id}
                      className="relative group"
                      style={{
                        zIndex:
                          hoveredCardId === credential.id
                            ? 999999
                            : collectionCount - filteredPlaybooks.length - index,
                      }}
                    >
                      <CredentialCardComponent
                        credential={credential}
                        isInActiveDeck={editingDeckCredentialIds.has(credential.id)}
                        activeDeck={editingDeck ?? undefined}
                        isInCollection
                        onDragStart={handleCredentialDragStart}
                        onDragEnd={handleDragEnd}
                        onMouseEnter={() => handleCardHover(credential.id)}
                        onMouseLeave={() => handleCardHover(null)}
                        onCardClick={handleCredentialClick}
                        warnings={collectionWarnings.credentialWarnings.get(credential.id)}
                      />
                    </div>
                  ))}
                  {filteredServices.map((service, index) => (
                    <div
                      key={service.id}
                      className="relative group"
                      style={{
                        zIndex:
                          hoveredCardId === service.id
                            ? 999999
                            : collectionCount -
                              filteredPlaybooks.length -
                              filteredCredentials.length -
                              index,
                      }}
                    >
                      <CardComponent
                        service={service}
                        onDragStart={handleDragStart}
                        onDragEnd={handleDragEnd}
                        isInActiveDeck={editingDeck?.services?.some((s) => s.id === service.id) || false}
                        onCardClick={handleCardClick}
                        isInCollection={true}
                        onMouseEnter={() => handleCardHover(service.id)}
                        onMouseLeave={() => handleCardHover(null)}
                        activeDeck={editingDeck ?? undefined}
                        warnings={collectionWarnings.serviceWarnings.get(service.id)}
                      />
                    </div>
                  ))}
                </div>
              )}
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Cyberpunk Background Effects — wrapper positions, inner orb animates */}
      <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
        <div className="absolute top-20 left-20">
          <div className="h-96 w-96 rounded-full bg-cyan-500/10 blur-3xl animate-orb-drift-1" />
        </div>
        <div className="absolute bottom-20 right-20">
          <div className="h-96 w-96 rounded-full bg-pink-500/10 blur-3xl animate-orb-drift-2" />
        </div>
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <div className="h-96 w-96 rounded-full bg-purple-500/5 blur-3xl animate-orb-drift-3" />
        </div>
      </div>

      {/* Modals */}
      <ServiceRegistrationModal
        type="mcp"
        open={mcpModalOpen}
        onOpenChange={setMcpModalOpen}
      />

      <ServiceDetailsModal
        service={selectedService}
        isOpen={serviceDetailsModalOpen}
        onClose={() => setServiceDetailsModalOpen(false)}
      />

      <CredentialRegistrationModal
        open={credentialModalOpen}
        onOpenChange={setCredentialModalOpen}
      />

      <CredentialDetailsModal
        credentialId={selectedCredentialId}
        open={credentialDetailsOpen}
        onOpenChange={setCredentialDetailsOpen}
      />

      <PlaybookRegistrationModal
        open={playbookModalOpen}
        onOpenChange={setPlaybookModalOpen}
      />

      <PlaybookDetailsModal
        playbookId={selectedPlaybookId}
        open={playbookDetailsOpen}
        onOpenChange={setPlaybookDetailsOpen}
      />

      <ImportBundleModal
        open={importBundleOpen}
        onOpenChange={setImportBundleOpen}
      />
    </div>
  );
}
