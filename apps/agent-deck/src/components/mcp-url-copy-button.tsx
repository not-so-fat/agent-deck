import { useWebSocket } from "@/hooks/use-websocket";
import { useToast } from "@/hooks/use-toast";
import { fetchMcpEndpointUrl } from "@/lib/mcp-endpoint";

/**
 * "Get MCP URL" copy control (NOT-257).
 *
 * Copies the canonical MCP client connection endpoint from the backend
 * (`GET /api/mcp/endpoint`) verbatim — scheme, host, MCP port, and path —
 * then shows that same value in the success feedback. The clipboard never
 * sees the dashboard/browser origin.
 */
export default function McpUrlCopyButton() {
  const { connectionStatus } = useWebSocket();
  const { toast } = useToast();

  return (
    <div className={`flex items-center space-x-2 px-3 py-1 rounded-full border ${
      connectionStatus === 'connected'
        ? 'bg-emerald-500/20 border-emerald-500/30'
        : 'bg-red-500/20 border-red-500/30'
    }`}>
      <div className={`w-2 h-2 rounded-full animate-pulse ${
        connectionStatus === 'connected' ? 'bg-emerald-400' : 'bg-red-400'
      }`}></div>
      <button
        className={`font-ui-display text-sm hover:underline cursor-pointer ${
          connectionStatus === 'connected' ? 'text-emerald-300' : 'text-red-300'
        }`}
        data-testid="button-copy-mcp-url"
        onClick={() => {
          void (async () => {
            try {
              const mcpUrl = await fetchMcpEndpointUrl();
              await navigator.clipboard.writeText(mcpUrl);
              toast({
                title: "MCP URL copied!",
                description: mcpUrl,
              });
            } catch (error) {
              toast({
                title: "Failed to copy MCP URL",
                description: error instanceof Error ? error.message : "Unknown error",
                variant: "destructive",
              });
            }
          })();
        }}
        title="Click to copy MCP URL"
      >
        Get MCP URL
      </button>
    </div>
  );
}
